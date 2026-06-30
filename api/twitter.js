import crypto from 'crypto';

// ── OAuth 1.0a "Sign in with Twitter" — step 1: get a request token ──────────
// This flow returns the user's screen_name during the token exchange, so we
// never call the paid v2 /2/users/me endpoint. Uses the OAuth 1.0 Consumer Key
// + Secret (set TWITTER_CONSUMER_KEY / TWITTER_CONSUMER_SECRET in Vercel).
const CONSUMER_KEY    = process.env.TWITTER_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.TWITTER_CONSUMER_SECRET;
const CALLBACK_URL    = 'https://extraction.one/callback';

// RFC3986 percent-encoding (stricter than encodeURIComponent).
function pct(s) {
  return encodeURIComponent(String(s)).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// HMAC-SHA1 signature over the OAuth 1.0a signature base string.
function sign(method, url, params, tokenSecret) {
  const pstr = Object.keys(params).sort().map(k => pct(k) + '=' + pct(params[k])).join('&');
  const base = method.toUpperCase() + '&' + pct(url) + '&' + pct(pstr);
  const key  = pct(CONSUMER_SECRET) + '&' + pct(tokenSecret || '');
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

function authHeader(params) {
  return 'OAuth ' + Object.keys(params).sort().map(k => pct(k) + '="' + pct(params[k]) + '"').join(', ');
}

function signCookie(value) {
  const mac = crypto.createHmac('sha256', process.env.OAUTH_COOKIE_SECRET).update(value).digest('hex');
  return `${value}.${mac}`;
}

export default async function handler(req, res) {
  try {
    const url = 'https://api.twitter.com/oauth/request_token';
    const oauth = {
      oauth_callback:         CALLBACK_URL,
      oauth_consumer_key:     CONSUMER_KEY,
      oauth_nonce:            crypto.randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
      oauth_version:          '1.0'
    };
    oauth.oauth_signature = sign('POST', url, oauth, '');

    const r = await fetch(url, { method: 'POST', headers: { Authorization: authHeader(oauth) } });
    const text = await r.text();
    if (!r.ok) {
      console.error('request_token failed. HTTP', r.status, '— body:', text.slice(0, 500));
      return res.redirect('/?autherror=' + encodeURIComponent('Twitter sign-in failed, please try again'));
    }

    const p = new URLSearchParams(text);
    const oauth_token        = p.get('oauth_token');
    const oauth_token_secret = p.get('oauth_token_secret');
    if (!oauth_token || !oauth_token_secret) {
      console.error('request_token: no token in response:', text.slice(0, 500));
      return res.redirect('/?autherror=' + encodeURIComponent('Twitter sign-in failed, please try again'));
    }

    // Stash request token + secret in a signed, HttpOnly cookie (10 min). The
    // callback needs the secret to sign the access-token exchange.
    const payload = signCookie(`${oauth_token}:${oauth_token_secret}`);
    res.setHeader('Set-Cookie',
      `oauth1_flow=${payload}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);

    return res.redirect(`https://api.twitter.com/oauth/authenticate?oauth_token=${encodeURIComponent(oauth_token)}`);
  } catch (e) {
    console.error('twitter request_token crashed:', e);
    return res.redirect('/?autherror=' + encodeURIComponent('Sign-in error, please try again'));
  }
}
