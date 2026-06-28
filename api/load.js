import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── POST: dungeon entry fee → 80% to shared pool, 20% removed ──────────────
  if (req.method === 'POST') {
    const { username, token, entryFee, action } = req.body || {};
    if (!username || !token) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    // ===== JACKPOT PULL — server decides the win, not the client =====
    if (action === 'jackpot') {
      // TEST MODE: true = find+win are 100% for testing. Set false for live 1% odds.
      const TEST_MODE = true;
      const WIN_CHANCE = TEST_MODE ? 1.0 : 0.01;

      const { data: jp, error: jErr } = await supabase
        .from('players')
        .select('session_token, tokens')
        .eq('username', username)
        .single();
      if (jErr || !jp) return res.status(403).json({ error: 'Player not found' });
      if (jp.session_token !== token) return res.status(403).json({ error: 'Invalid session' });

      const won = Math.random() < WIN_CHANCE;
      if (!won) return res.status(200).json({ ok: true, won: false });

      // WIN — read pool, reset it FIRST (prevents double-pay), then credit player
      const poolRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/global_pool?id=eq.1&select=pool`, {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        }
      });
      const poolRows = await poolRes.json();
      const wonAmount = (poolRows && poolRows.length) ? parseFloat(poolRows[0].pool) || 0 : 0;

      const { error: resetErr } = await supabase.rpc('reset_pool');
      if (resetErr) {
        console.error('Pool reset error:', resetErr);
        return res.status(500).json({ error: 'Payout failed, try again' });
      }

      const newBalance = (jp.tokens || 0) + wonAmount;
      await supabase.from('players').update({ tokens: newBalance }).eq('username', username);

      await supabase.from('jackpot_wins').insert({
        username, amount: wonAmount, won_at: new Date().toISOString()
      }).catch(() => {});

      return res.status(200).json({ ok: true, won: true, amount: wonAmount, newTokens: newBalance });
    }

    // ===== DUNGEON ENTRY FEE =====
    if (!entryFee) return res.status(400).json({ error: 'Missing entry fee' });
    const fee = parseFloat(entryFee);
    if (isNaN(fee) || fee <= 0) return res.status(400).json({ error: 'Invalid entry fee' });

    // Verify session + check the player actually has the EXT
    const { data: player, error: pErr } = await supabase
      .from('players')
      .select('session_token, tokens')
      .eq('username', username)
      .single();
    if (pErr || !player) return res.status(403).json({ error: 'Player not found' });
    if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session' });
    if ((player.tokens || 0) < fee) return res.status(400).json({ error: 'Insufficient EXT' });

    // Deduct the full fee from the player
    const newTokens = (player.tokens || 0) - fee;
    await supabase.from('players').update({ tokens: newTokens }).eq('username', username);

    // 80% to the shared pool (atomic), 20% removed (burn + dev)
    const poolAdd    = fee * 0.80;
    const removedAdd = fee * 0.20;

    const { error: poolErr } = await supabase.rpc('add_to_pool', { amount: poolAdd });
    if (poolErr) console.error('Pool deposit error:', poolErr);

    const { error: removedErr } = await supabase.rpc('add_removed', { amount: removedAdd });
    if (removedErr) console.error('Removed tracking error:', removedErr);

    return res.status(200).json({ ok: true, newTokens, pooledAdded: poolAdd, removedAdded: removedAdd });
  }

  // ── GET: pool mode ─────────────────────────────────────────────────────────
  if (req.query.pool) {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/global_pool?id=eq.1&select=pool`, {
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      }
    });
    const rows = await r.json();
    const pool = (rows && rows.length) ? parseFloat(rows[0].pool) || 0 : 0;
    return res.status(200).json({ pool });
  }

  // ── GET: load a player ─────────────────────────────────────────────────────
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Missing username' });
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/players?username=eq.${username}&select=*`, {
    headers: {
      'apikey': process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
    }
  });
  const rows = await response.json();
  if (!rows.length) return res.status(404).json({ error: 'Player not found' });
  res.status(200).json(rows[0]);
}
