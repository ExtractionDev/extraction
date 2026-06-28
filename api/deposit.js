import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const _rateLimits = {};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, token, amount, tx_hash } = req.body || {};

  if (!username || !token || !amount || !tx_hash) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  // Rate limit: 1 deposit request per 10 minutes
  const now = Date.now();
  if (_rateLimits[username] && now - _rateLimits[username] < 60000) {
    return res.status(429).json({ error: 'Please wait before submitting another deposit.' });
  }
  _rateLimits[username] = now;

  const safeAmount = parseFloat(amount);
  if (isNaN(safeAmount) || safeAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount.' });
  }

  if (!tx_hash || tx_hash.length < 20) {
    return res.status(400).json({ error: 'Invalid transaction hash.' });
  }

  // Verify session token
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, tokens, runs')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found.' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session.' });

  // Check for duplicate TX hash
  const { data: existing } = await supabase
    .from('deposits')
    .select('id')
    .eq('tx_hash', tx_hash)
    .single();

  if (existing) {
    return res.status(400).json({ error: 'This transaction has already been submitted.' });
  }

  // Store deposit request
  const { error: insertErr } = await supabase
    .from('deposits')
    .insert({
      username,
      amount: safeAmount,
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
