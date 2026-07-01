import crypto from 'crypto';

// ── OAuth 1.0a "Sign in with Twitter" — step 2: exchange for access token ────
// The access_token response includes screen_name + user_id directly, so we get
// the username WITHOUT calling the paid v2 /2/users/me endpoint.
const CONSUMER_KEY    = process.env.TWITTER_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.TWITTER_CONSUMER_SECRET;

function pct(s) {
  return encodeURIComponent(String(s)).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function sign(method, url, params, tokenSecret) {
  const pstr = Object.keys(params).sort().map(k => pct(k) + '=' + pct(params[k])).join('&');
  const base = method.toUpperCase() + '&' + pct(url) + '&' + pct(pstr);
  const key  = pct(CONSUMER_SECRET) + '&' + pct(tokenSecret || '');
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}
function authHeader(params) {
  return 'OAuth ' + Object.keys(params).sort().map(k => pct(k) + '="' + pct(params[k]) + '"').join(', ');
}

function verifyCookie(raw) {
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx < 0) return null;
  const value = raw.slice(0, idx);
  const mac   = raw.slice(idx + 1);
  const expected = crypto.createHmac('sha256', process.env.OAUTH_COOKIE_SECRET).update(value).digest('hex');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const sep = value.indexOf(':');
  if (sep < 0) return null;
  return { oauth_token: value.slice(0, sep), oauth_token_secret: value.slice(sep + 1) };
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
    const { oauth_token, oauth_verifier } = req.query;
    if (!oauth_token || !oauth_verifier) {
      return res.redirect('/?autherror=' + encodeURIComponent('No authorization received'));
    }

    // Recover the request-token secret from the signed cookie.
    const cookies = parseCookies(req.headers.cookie);
    const flow = verifyCookie(cookies.oauth1_flow);
    if (!flow) {
      return res.redirect('/?autherror=' + encodeURIComponent('Login session expired, please try again'));
    }
    if (flow.oauth_token !== oauth_token) {
      return res.redirect('/?autherror=' + encodeURIComponent('Invalid login state, please try again'));
    }
    res.setHeader('Set-Cookie', 'oauth1_flow=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');

    // Exchange the verifier for an access token. The response body carries
    // screen_name + user_id — no extra (paid) profile call needed.
    const url = 'https://api.twitter.com/oauth/access_token';
    const oauth = {
      oauth_consumer_key:     CONSUMER_KEY,
      oauth_nonce:            crypto.randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
      oauth_token:            oauth_token,
      oauth_version:          '1.0'
    };
    // oauth_verifier must be part of the signature base and sent in the body.
    const sigParams = Object.assign({}, oauth, { oauth_verifier });
    oauth.oauth_signature = sign('POST', url, sigParams, flow.oauth_token_secret);

    const tokenRes = await fetch(url, {
      method: 'POST',
      headers: { Authorization: authHeader(oauth), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ oauth_verifier })
    });
    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      console.error('access_token failed. HTTP', tokenRes.status, '— body:', text.slice(0, 500));
      return res.redirect('/?autherror=' + encodeURIComponent('Twitter sign-in failed, please try again'));
    }

    const parsed = new URLSearchParams(text);
    const screenName = parsed.get('screen_name');
    if (!screenName) {
      console.error('access_token: no screen_name in response:', text.slice(0, 500));
      return res.redirect('/?autherror=' + encodeURIComponent('Could not read Twitter profile, please try again'));
    }

    const username = screenName;
    const displayName = screenName; // 1.0a access_token doesn't return display name

    // 3. Session token
    const sessionToken = crypto.randomBytes(32).toString('hex');

    // 4. Fetch existing player (for streak)
    let player = null;
    try {
      const existingRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/players?username=eq.${encodeURIComponent(username)}&select=*`,
        { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const existing = await existingRes.json();
      player = Array.isArray(existing) ? existing[0] : null;
    } catch (e) {
      console.error('Existing player fetch error:', e);
    }

    // 5. Streak calc — 7-day cycle that resets to 1 after completing day 7.
    // Reward table (EXT) for days 1-7:
    const STREAK_REWARDS = { 1: 500, 2: 750, 3: 1000, 4: 1500, 5: 2000, 6: 3000, 7: 5000 };
    const today = new Date().toISOString().split('T')[0];
    let streak = 1;
    let streakBonus = 0;      // EXT to credit for today's login
    let alreadyClaimedToday = false;
    if (player) {
      const lastDate = player.last_streak_date || '';
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      if (lastDate === today) {
        // Already logged in today — no new reward, keep current streak.
        streak = player.login_streak || 1;
        alreadyClaimedToday = true;
      } else if (lastDate === yesterday) {
        // Consecutive day — advance, but wrap 7 → 1.
        const prev = player.login_streak || 0;
        streak = prev >= 7 ? 1 : prev + 1;
      } else {
        // Missed a day (or first ever) — restart at day 1.
        streak = 1;
      }
      if (!alreadyClaimedToday) streakBonus = STREAK_REWARDS[streak] || 0;
    } else {
      // Brand new player's first login = day 1.
      streak = 1;
      streakBonus = STREAK_REWARDS[1];
    }

    // Credit today's streak reward to the REAL server balance (once per day).
    if (streakBonus > 0) {
      try {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/credit_tokens`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
          },
          body: JSON.stringify({ p_username: username, p_amount: streakBonus })
        });
      } catch (e) {
        console.error('Streak credit failed for', username, e);
        // Non-fatal: login still proceeds; they just miss this credit.
      }
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
        username,
        name: displayName,
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

    // 7. Success — redirect into the game (query string; index.html reads it).
    const name = encodeURIComponent(displayName);
    return res.redirect(`/?username=${encodeURIComponent(username)}&name=${name}&token=${sessionToken}&streak=${streak}&bonus=${streakBonus.toFixed(2)}`);

  } catch (e) {
    console.error('Callback crashed:', e);
    return res.redirect('/?autherror=' + encodeURIComponent('Sign-in error, please try again'));
  }
}
