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

  // Generate a secret session token for this player
  const sessionToken = crypto.randomBytes(32).toString('hex');

  // Save player and session token to Supabase
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
      session_token: sessionToken
    })
  });

  // Pass session token back to game via URL
  res.redirect(`/?username=${data.username}&name=${data.name}&token=${sessionToken}`);
}
