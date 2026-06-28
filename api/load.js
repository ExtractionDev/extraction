import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── POST: dungeon entry fee → 80% to shared pool, 20% removed ──────────────
  if (req.method === 'POST') {
    const { username, token, entryFee } = req.body || {};
    if (!username || !token || !entryFee) {
      return res.status(400).json({ error: 'Missing fields' });
    }
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
    const poolAdd = fee * 0.80;
    const { error: poolErr } = await supabase.rpc('add_to_pool', { amount: poolAdd });
    if (poolErr) console.error('Pool deposit error:', poolErr);

    // Track total removed (20%) for accounting
    await supabase.rpc('add_removed', { amount: fee * 0.20 }).catch(() => {});

    return res.status(200).json({ ok: true, newTokens, pooledAdded: poolAdd });
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
