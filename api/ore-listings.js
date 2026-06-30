import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const VALID_ORES = ['Coal','Copper','Iron','Silver','Gold','Mystrile'];

async function verifyToken(username, token) {
  const { data, error } = await supabase
    .from('players').select('session_token, tokens, banned').eq('username', username).single();
  if (error || !data) return null;
  if (data.session_token !== token) return null;
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('ore_listings')
      .select('*')
      .eq('status', 'active')
      .order('listed_at', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ listings: data || [] });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const { action, username, token, ore_name, qty, price, lid } = req.body || {};
  if (!username || !token) return res.status(400).json({ error: 'Missing credentials' });

  const player = await verifyToken(username, token);
  if (!player) return res.status(403).json({ error: 'Invalid session' });
  if (player.banned) return res.status(403).json({ error: 'Account suspended.' });

  if (action === 'list') {
    if (!VALID_ORES.includes(ore_name)) return res.status(400).json({ error: 'Invalid ore' });
    if (!qty || qty < 1 || !price || price < 0.01) return res.status(400).json({ error: 'Invalid listing' });
    const { data, error } = await supabase.from('ore_listings').insert({
      seller: username,
      ore_name,
      qty: Math.floor(qty),
      price: parseFloat(price),
      status: 'active',
      listed_at: new Date().toISOString()
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, lid: data.id });
  }

  if (action === 'withdraw') {
    if (!lid) return res.status(400).json({ error: 'Missing lid' });
    const { data: listing, error: fetchErr } = await supabase
      .from('ore_listings').select('*').eq('id', lid).single();
    if (fetchErr || !listing) return res.status(404).json({ error: 'Not found' });
    if (listing.seller !== username) return res.status(403).json({ error: 'Not your listing' });
    if (listing.status !== 'active') return res.status(400).json({ error: 'Not active' });
    await supabase.from('ore_listings').update({ status: 'withdrawn' }).eq('id', lid);
    return res.status(200).json({ ok: true, ore_name: listing.ore_name, qty: listing.qty });
  }

  if (action === 'buy') {
    if (!lid) return res.status(400).json({ error: 'Missing lid' });
    // ATOMIC: locks the listing, debits buyer (only if funded + not banned),
    // credits seller, marks sold — all in one transaction. No race, no stale
    // read/modify/write, no double-credit token minting.
    const { data: result, error: rpcErr } = await supabase
      .rpc('buy_ore_listing', { p_lid: String(lid), p_buyer: username });
    if (rpcErr) {
      console.error('buy_ore_listing error:', rpcErr);
      return res.status(500).json({ error: 'Purchase failed. Try again.' });
    }
    if (!result || !result.ok) {
      return res.status(400).json({ error: (result && result.error) || 'Purchase failed' });
    }
    return res.status(200).json({ ok: true, ore_name: result.ore_name, qty: result.qty, cost: result.cost });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
