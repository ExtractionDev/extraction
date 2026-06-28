import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper: fetch the current shared pool amount
async function getPoolAmount() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/global_pool?id=eq.1&select=pool`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  const rows = await r.json();
  return (rows && rows.length) ? (parseFloat(rows[0].pool) || 0) : 0;
}

// Helper: get latest Solana blockhash server-side (no CORS issues)
async function getSolanaBlockhash() {
  const rpcs = [
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana-mainnet.rpc.extrnode.com',
    'https://solana.public-rpc.com'
  ];
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'getLatestBlockhash',
    params: [{ commitment: 'confirmed' }]
  });
  for (const rpc of rpcs) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!r.ok) continue;
      const d = await r.json();
      if (d.error || !d.result) continue;
      return { blockhash: d.result.value.blockhash, rpc };
    } catch (e) {
      console.warn('Blockhash RPC failed:', rpc, e.message);
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // =====================================================================
  // POST — handles: jackpot pull, dungeon entry fee
  // =====================================================================
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { username, token, entryFee, action } = body || {};

    if (!username || !token) {
      return res.status(400).json({ error: 'Missing username or token' });
    }

    // Verify the player's session once, up front
    const { data: player, error: pErr } = await supabase
      .from('players')
      .select('session_token, tokens')
      .eq('username', username)
      .single();

    if (pErr || !player) return res.status(403).json({ error: 'Player not found' });
    if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session' });

    // ---------- JACKPOT PULL ----------
    if (action === 'jackpot') {
      // TEST MODE: true => guaranteed win for testing. Set to false for live odds.
      const TEST_MODE = false;
      // Live odds: each pull rolls a random win chance between 1% and 6%
      const WIN_CHANCE = TEST_MODE ? 1.0 : (0.01 + Math.random() * 0.05);

      const won = Math.random() < WIN_CHANCE;
      if (!won) {
        return res.status(200).json({ ok: true, won: false });
      }

      // Read the pool
      const wonAmount = await getPoolAmount();

      if (wonAmount <= 0) {
        // Nothing to win, but still a valid "win" with 0 payout
        return res.status(200).json({ ok: true, won: true, amount: 0, newTokens: player.tokens || 0 });
      }

      // 1) Credit the player FIRST (so a later failure can't lose the pool)
      const newBalance = (player.tokens || 0) + wonAmount;
      const { error: creditErr } = await supabase
        .from('players')
        .update({ tokens: newBalance })
        .eq('username', username);
      if (creditErr) {
        return res.status(500).json({ error: 'Credit failed: ' + creditErr.message });
      }

      // 2) Reset the pool to 0
      const { error: resetErr } = await supabase.rpc('reset_pool');
      if (resetErr) {
        // Player already paid — log but don't fail the response
        console.error('reset_pool failed (player was paid):', resetErr.message);
      }

      // 3) Log the win (non-fatal)
      try {
        await supabase.from('jackpot_wins').insert({
          username, amount: wonAmount, won_at: new Date().toISOString()
        });
      } catch (e) { /* ignore logging errors */ }

      return res.status(200).json({ ok: true, won: true, amount: wonAmount, newTokens: newBalance });
    }

    // ---------- DUNGEON ENTRY FEE ----------
    if (!entryFee) return res.status(400).json({ error: 'Missing entry fee' });
    const fee = parseFloat(entryFee);
    if (isNaN(fee) || fee <= 0) return res.status(400).json({ error: 'Invalid entry fee' });
    if ((player.tokens || 0) < fee) return res.status(400).json({ error: 'Insufficient EXT' });

    const newTokens = (player.tokens || 0) - fee;
    await supabase.from('players').update({ tokens: newTokens }).eq('username', username);

    const poolAdd = fee * 0.80;
    const removedAdd = fee * 0.20;

    const { error: poolErr } = await supabase.rpc('add_to_pool', { amount: poolAdd });
    if (poolErr) console.error('add_to_pool failed:', poolErr.message);

    const { error: removedErr } = await supabase.rpc('add_removed', { amount: removedAdd });
    if (removedErr) console.error('add_removed failed:', removedErr.message);

    return res.status(200).json({ ok: true, newTokens, pooledAdded: poolAdd, removedAdded: removedAdd });
  }

  // =====================================================================
  // GET — handles: blockhash proxy, pool amount, player load
  // =====================================================================

  // ---------- BLOCKHASH PROXY ----------
  if (req.query.blockhash) {
    const result = await getSolanaBlockhash();
    if (!result) return res.status(503).json({ error: 'All Solana RPC endpoints unavailable. Try again shortly.' });
    return res.status(200).json(result);
  }

  if (req.query.pool) {
    const pool = await getPoolAmount();
    return res.status(200).json({ pool });
  }

  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Missing username' });

  const response = await fetch(`${SUPABASE_URL}/rest/v1/players?username=eq.${encodeURIComponent(username)}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  const rows = await response.json();
  if (!rows.length) return res.status(404).json({ error: 'Player not found' });
  return res.status(200).json(rows[0]);
}
