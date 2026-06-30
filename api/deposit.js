import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Solana tx signatures are base58, ~87-88 chars.
const SIG = /^[1-9A-HJ-NP-Za-km-z]{43,90}$/;

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).end();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { username, token, amount, tx_hash } = body || {};
  if (!username || !token || !amount || !tx_hash) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const safeAmount = parseFloat(amount);
  if (isNaN(safeAmount) || safeAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount.' });
  }
  if (typeof tx_hash !== 'string' || !SIG.test(tx_hash)) {
    return res.status(400).json({ error: 'Invalid transaction hash.' });
  }

  // Verify session + ban status
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, tokens, runs, banned')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found.' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session.' });
  if (player.banned) return res.status(403).json({ error: 'Account suspended.' });

  // Reject a tx_hash that was already submitted (replay protection).
  const { data: existing } = await supabase
    .from('deposits')
    .select('id')
    .eq('tx_hash', tx_hash)
    .maybeSingle();
  if (existing) {
    return res.status(400).json({ error: 'This transaction has already been submitted.' });
  }

  // Light DB-based rate limit (one pending deposit per 30s per account).
  const since = new Date(Date.now() - 30000).toISOString();
  const { data: recent } = await supabase
    .from('deposits')
    .select('id')
    .eq('username', username)
    .gte('requested_at', since)
    .limit(1);
  if (recent && recent.length) {
    return res.status(429).json({ error: 'Please wait before submitting another deposit.' });
  }

  // ⚠️ SECURITY: `amount` here is CLIENT-SUPPLIED and NOT trustworthy. Whatever
  // process credits tokens for a 'pending' deposit MUST look up tx_hash on the
  // Solana chain, confirm it is finalized, sent to YOUR deposit wallet, in USDC,
  // and credit the REAL on-chain amount — never this client-claimed value.
  const { error: insertErr } = await supabase
    .from('deposits')
    .insert({
      username,
      amount: safeAmount,          // claimed; verify on-chain before crediting
      tx_hash,
      tokens_balance: player.tokens || 0,
      runs: player.runs || 0,
      status: 'pending',
      requested_at: new Date().toISOString()
    });

  if (insertErr) {
    console.error('Deposit insert error:', insertErr);
    return res.status(500).json({ error: 'Failed to submit. Try again.' });
  }

  return res.status(200).json({ ok: true });
}
