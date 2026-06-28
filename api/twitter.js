export default function handler(req, res) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.TWITTER_CLIENT_ID,
    redirect_uri: 'https://extraction.one/callback',
    scope: 'tweet.read users.read',
    state: 'state',
    code_challenge: 'challenge',
    code_challenge_method: 'plain'
  });
  res.redirect(`https://twitter.com/i/oauth2/authorize?${params}`);
}
