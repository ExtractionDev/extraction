import crypto from 'crypto';

export default async function handler(req, res) {
  const { code } = req.query;

  const response = await fetch('https://api.twitter.com/2/oauth2/token', {
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

  const tokens = await response.json();

  const userResponse = await fetch('https://api.twitter.com/2/users/me', {
    headers: { 'Authorization': `Bearer ${tokens.access_token}` }
  });

  const { data } = await userResponse.json();

  // Generate a secret session token
  const sessionToken = crypto.randomBytes(32).toString('hex');

  // Fetch existing player
  const existingRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/players?username=eq.${data.username}&select=*`,
    { headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` }}
  );
  const existing = await existingRes.json();
  const player = existing[0];

  // Calculate login streak
  const today = new Date().toISOString().split('T')[0];
  let streak = 1;
  let streakBonus = 0;

  if(player) {
    const lastDate = player.last_streak_date || '';
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    if(lastDate === today) {
      // Already logged in today — keep streak
      streak = player.login_streak || 1;
    } else if(lastDate === yesterday) {
      // Logged in yesterday — extend streak
      streak = (player.login_streak || 0) + 1;
    } else {
      // Streak broken
      streak = 1;
    }
    // Streak bonus EXT (capped at 30 day streak)
    streakBonus = Math.min(streak, 30) * 0.5;
  }

  // Upsert player with new session token and streak
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/players`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      username: data.username,
      name: data.name,
      session_token: sessionToken,
      last_login: new Date().toISOString(),
      login_streak: streak,
      last_streak_date: today
    })
  });

  res.redirect(`/?username=${data.username}&name=${data.name}&token=${sessionToken}&streak=${streak}&bonus=${streakBonus.toFixed(2)}`);
}
