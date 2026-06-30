import crypto from 'crypto';

// base64url helper
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Sign a value so the callback can trust the cookie wasn't tampered with.
function sign(value) {
  const secret = process.env.OAUTH_COOKIE_SECRET;
  const mac = crypto.createHmac('sha256', secret).update(value).digest('hex');
  return `${value}.${mac}`;
}

export default function handler(req, res) {
  // 1. Per-request random secrets
  const codeVerifier = b64url(crypto.randomBytes(32));  // PKCE verifier
  const state        = b64url(crypto.randomBytes(16));  // CSRF token

  // 2. PKCE S256 challenge (NOT 'plain', NOT a constant)
  const challenge = b64url(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );

  // 3. Stash verifier+state in a signed, HttpOnly cookie (10 min TTL)
  const payload = sign(`${state}:${codeVerifier}`);
  res.setHeader('Set-Cookie',
    `oauth_flow=${payload}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  );

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.TWITTER_CLIENT_ID,
    redirect_uri: 'https://extraction.one/callback',
    scope: 'tweet.read users.read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });

  res.redirect(`https://twitter.com/i/oauth2/authorize?${params}`);
}
