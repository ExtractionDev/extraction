import crypto from 'crypto';

function sign(value) {
  const secret = process.env.OAUTH_COOKIE_SECRET;
  const mac = crypto.createHmac('sha256', secret).update(value).digest('hex');
  return `${value}.${mac}`;
}

function verifyCookie(raw) {
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx < 0) return null;
  const value = raw.slice(0, idx);
  const expected = sign(value); // re-sign and compare full token
  const a = Buffer.from(`${value}.${raw.slice(idx + 1)}`);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const sep = value.indexOf(':');
  if (sep < 0) return null;
  const state = value.slice(0, sep);
  const codeVerifier = value.slice(sep + 1);
  if (!state || !codeVerifier) return null;
  return { state, codeVerifier };
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export default async function handler(req, res) {
  try {
    const { code, state: returnedState } = req.query;
    if (!code) return res.redirect('/?autherror=' + encodeURIComponent('No authorization code received'));

    // ── Verify PKCE + CSRF state from the signed cookie ──────────────────
    const cookies = parseCookies(req.headers.cookie);
    const flow = verifyCookie(cookies.oauth_flow);
    if (!flow) {
      return res.redirect('/?autherror=' + encodeURIComponent('Login session expired, please try again'));
    }
    if (!returnedState || returnedState !== flow.state) {
      return res.redirect('/?autherror=' + encodeURIComponent('Invalid login state, please try again'));
    }
    // Clear the one-time cookie immediately
    res.setHeader('Set-Cookie', 'oauth_flow=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');

    // 1. Exchange code for access token — using the REAL verifier
    const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(
          process.env.TWITTER_CLIENT_ID + ':' + process.env.TWITTER_CLIENT_SECRET
        ).toString('base64')
      },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        redirect_uri: 'https://extraction.one/callback',
        code_verifier: flow.codeVerifier   // ← was hardcoded 'challenge'
      })
    });

    const tokens = await tokenRes.json();
    if (!tokens || !tokens.access_token) {
      console.error('Token exchange failed:', tokens);
      return res.redirect('/?autherror=' + encodeURIComponent('Twitter sign-in failed, please try again'));
    }

    // 2. Get the user's profile
    const userRes = await fetch('https://api.twitter.com/2/users/me', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    const userJson = await userRes.json();
    const data = userJson && userJson.data;
    if (!data || !data.username) {
      console.error('User fetch failed:', userJson);
      return res.redirect('/?autherror=' + encodeURIComponent('Could not read Twitter profile, please try again'));
    }

    // 3. Session token
    const sessionToken = crypto.randomBytes(32).toString('hex');

    // 4. Fetch existing player (for streak)
    let player = null;
    try {
      const existingRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/players?username=eq.${encodeURIComponent(data.username)}&select=*`,
        { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const existing = await existingRes.json();
      player = Array.isArray(existing) ? existing[0] : null;
    } catch (e) {
      console.error('Existing player fetch error:', e);
    }

    // 5. Streak calc
    const today = new Date().toISOString().split('T')[0];
    let streak = 1;
    let streakBonus = 0;
    if (player) {
      const lastDate = player.last_streak_date || '';
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      if (lastDate === today) {
        streak = player.login_streak || 1;
      } else if (lastDate === yesterday) {
        streak = (player.login_streak || 0) + 1;
      } else {
        streak = 1;
      }
      streakBonus = Math.min(streak, 30) * 0.5;
    }

    // 6. Upsert player
    const upsertRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/players`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        username: data.username,
        name: data.name || data.username,
        session_token: sessionToken,
        last_login: new Date().toISOString(),
        login_streak: streak,
        last_streak_date: today
      })
    });

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.error('Player upsert failed:', upsertRes.status, errText);
      return res.redirect('/?autherror=' + encodeURIComponent('Could not save your profile, please try again'));
    }

    // 6b. Persist the streak bonus on the balance — but only ONCE per new streak
    // day, never on a repeat same-day login (which would double-credit).
    const isNewStreakDay = player && player.last_streak_date !== today;
    if (isNewStreakDay && streakBonus > 0) {
      try {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/credit_tokens`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
          },
          body: JSON.stringify({ p_username: data.username, p_amount: streakBonus })
        });
      } catch (e) {
        console.error('Streak bonus credit failed (non-fatal):', e);
      }
    }

    // 7. Success — redirect into the game with the login result in the QUERY
    // string. index.html reads the token from the URL fragment first and falls
    // back to the query string, so this is compatible. If you want the token
    // kept out of server logs/Referer, switch this `?` to `#` (fragment) — the
    // client already supports it — but do it in one deploy to avoid a mismatch.
    const name = encodeURIComponent(data.name || data.username);
    return res.redirect(`/?username=${encodeURIComponent(data.username)}&name=${name}&token=${sessionToken}&streak=${streak}&bonus=${streakBonus.toFixed(2)}`);

  } catch (e) {
    console.error('Callback crashed:', e);
    return res.redirect('/?autherror=' + encodeURIComponent('Sign-in error, please try again'));
  }
}
