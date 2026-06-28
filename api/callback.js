import crypto from 'crypto';

export default async function handler(req, res) {
  try {
    const { code } = req.query;
    if (!code) return res.redirect('/?autherror=' + encodeURIComponent('No authorization code received'));

    // 1. Exchange code for access token
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
        code_verifier: 'challenge'
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
        { headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` } }
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
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
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

    // 7. Success — redirect into the game
    const name = encodeURIComponent(data.name || data.username);
    return res.redirect(`/?username=${encodeURIComponent(data.username)}&name=${name}&token=${sessionToken}&streak=${streak}&bonus=${streakBonus.toFixed(2)}`);

  } catch (e) {
    console.error('Callback crashed:', e);
    return res.redirect('/?autherror=' + encodeURIComponent('Sign-in error, please try again'));
  }
}
