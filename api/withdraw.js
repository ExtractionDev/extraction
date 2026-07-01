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

const MIN_WITHDRAW = 50000;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // Solana address charset + length

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).end();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { username, token, wallet, amount } = body || {};
  if (!username || !token || !wallet || !amount) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  // Validate wallet (base58 + length, not just length)
  if (typeof wallet !== 'string' || !BASE58.test(wallet)) {
    return res.status(400).json({ error: 'Invalid Solana wallet address.' });
  }

  // Validate amount
  const safeAmount = parseFloat(amount);
  if (isNaN(safeAmount) || safeAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount.' });
  }
  if (safeAmount < MIN_WITHDRAW) {
    return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAW.toLocaleString()} $EXT.` });
  }

  // Verify session + ban status
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, tokens, runs, gc_extracted, banned')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found.' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session.' });
  if (player.banned) return res.status(403).json({ error: 'Account suspended.' });

  // Rate limit in the DATABASE (in-memory limits don't survive serverless).
  // One withdrawal request per hour per account.
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  const { data: recent, error: recentErr } = await supabase
    .from('withdrawals')
    .select('id')
    .eq('username', username)
    .gte('requested_at', oneHourAgo)
    .limit(1);
  if (recentErr) {
    console.error('Withdraw rate-check error:', recentErr);
    return res.status(500).json({ error: 'Try again shortly.' });
  }
  if (recent && recent.length) {
    return res.status(429).json({ error: 'Please wait before submitting another request.' });
  }

  // Balance held BEFORE debit (recorded on the request row).
  const balanceBefore = player.tokens || 0;

  // ATOMIC debit — subtracts only if not banned and balance is sufficient.
  // Prevents the double-withdraw / concurrent-withdraw hole.
  const { data: newBalRaw, error: debitErr } = await supabase
    .rpc('debit_tokens', { p_username: username, p_amount: safeAmount });
  if (debitErr) {
    console.error('debit_tokens error:', debitErr);
    return res.status(500).json({ error: 'Try again shortly.' });
  }
  if (newBalRaw == null) {
    return res.status(400).json({ error: 'Insufficient balance.' });
  }
  const newBalance = parseFloat(newBalRaw) || 0;

  // Record the pending request. If this fails, REFUND the debit.
  const { error: insertErr } = await supabase
    .from('withdrawals')
    .insert({
      username,
      wallet,
      amount: safeAmount,
      tokens_balance: balanceBefore,
      runs: player.runs || 0,
      gc_extracted: player.gc_extracted || 0,
      status: 'pending',
      requested_at: new Date().toISOString()
    });

  if (insertErr) {
    console.error('Withdraw insert error (refunding debit):', insertErr);
    await supabase.rpc('credit_tokens', { p_username: username, p_amount: safeAmount });
    return res.status(500).json({ error: 'Failed to submit request. Try again.' });
  }

  return res.status(200).json({ ok: true, newBalance });
}
