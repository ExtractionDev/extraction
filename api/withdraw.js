import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const _rateLimits = {};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, token, wallet, amount } = req.body || {};

  if (!username || !token || !wallet || !amount) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  // Rate limit: 1 withdrawal request per hour
  const now = Date.now();
  if (_rateLimits[username] && now - _rateLimits[username] < 3600000) {
    return res.status(429).json({ error: 'Please wait before submitting another request.' });
  }
  _rateLimits[username] = now;

  // Validate wallet (basic Solana address check)
  if (wallet.length < 32 || wallet.length > 44) {
    return res.status(400).json({ error: 'Invalid Solana wallet address.' });
  }

  // Validate amount
  const safeAmount = parseFloat(amount);
  if (isNaN(safeAmount) || safeAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount.' });
  }
  if (safeAmount < 25000) {
    return res.status(400).json({ error: 'Minimum withdrawal is 25,000 $EXT.' });
  }

  // Verify session token and check balance
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, tokens, runs, gc_extracted')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found.' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session.' });
  if (safeAmount > (player.tokens || 0)) {
    return res.status(400).json({ error: 'Insufficient balance.' });
  }

  // Store withdrawal request in Supabase
  const { error: insertErr } = await supabase
    .from('withdrawals')
    .insert({
      username,
      wallet,
      amount: safeAmount,
      tokens_balance: player.tokens || 0,
      runs: player.runs || 0,
      gc_extracted: player.gc_extracted || 0,
      status: 'pending',
      requested_at: new Date().toISOString()
    });

  if (insertErr) {
    console.error('Withdraw insert error:', insertErr);
    return res.status(500).json({ error: 'Failed to submit request. Try again.' });
  }

  return res.status(200).json({ ok: true });
}
