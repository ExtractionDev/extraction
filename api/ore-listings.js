import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const VALID_ORES = ['Coal','Copper','Iron','Silver','Gold','Mystrile'];

async function verifyToken(username, token) {
  const { data, error } = await supabase
    .from('players').select('session_token, tokens').eq('username', username).single();
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
    const { data: listing, error: fetchErr } = await supabase
      .from('ore_listings').select('*').eq('id', lid).single();
    if (fetchErr || !listing) return res.status(404).json({ error: 'Not found' });
    if (listing.status !== 'active') return res.status(400).json({ error: 'Already sold' });
    if (listing.seller === username) return res.status(400).json({ error: 'Cannot buy own listing' });
    const totalCost = listing.price * listing.qty;
    if (player.tokens < totalCost) return res.status(400).json({ error: 'Insufficient EXT' });

    await supabase.from('ore_listings').update({ status: 'sold', buyer: username }).eq('id', lid);
    await supabase.from('players').update({ tokens: player.tokens - totalCost }).eq('username', username);
    const { data: seller } = await supabase.from('players').select('tokens').eq('username', listing.seller).single();
    if (seller) await supabase.from('players').update({ tokens: (seller.tokens || 0) + totalCost }).eq('username', listing.seller);

    return res.status(200).json({ ok: true, ore_name: listing.ore_name, qty: listing.qty, cost: totalCost });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
