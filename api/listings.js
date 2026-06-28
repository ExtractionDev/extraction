
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function verifyToken(username, token) {
  const { data, error } = await supabase
    .from('players').select('session_token, tokens').eq('username', username).single();
  if (error || !data) return null;
  if (data.session_token !== token) return null;
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET — fetch all active listings
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('listings')
      .select('*')
      .eq('status', 'active')
      .order('listed_at', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ listings: data || [] });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const { action, username, token, item, price, lid } = req.body || {};
  if (!username || !token) return res.status(400).json({ error: 'Missing credentials' });

  const player = await verifyToken(username, token);
  if (!player) return res.status(403).json({ error: 'Invalid session' });

  // LIST — add a pickaxe listing
  if (action === 'list') {
    if (!item || !price || price < 1) return res.status(400).json({ error: 'Invalid listing' });
    const { data, error } = await supabase.from('listings').insert({
      seller: username,
      item_data: item,
      price: Math.floor(price),
      status: 'active',
      listed_at: new Date().toISOString()
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, lid: data.id });
  }

  // WITHDRAW — remove own listing, return item to player
  if (action === 'withdraw') {
    if (!lid) return res.status(400).json({ error: 'Missing lid' });
    const { data: listing, error: fetchErr } = await supabase
      .from('listings').select('*').eq('id', lid).single();
    if (fetchErr || !listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.seller !== username) return res.status(403).json({ error: 'Not your listing' });
    if (listing.status !== 'active') return res.status(400).json({ error: 'Listing not active' });
    await supabase.from('listings').update({ status: 'withdrawn' }).eq('id', lid);
    return res.status(200).json({ ok: true, item: listing.item_data });
  }

  // BUY — purchase a listing
  if (action === 'buy') {
    if (!lid) return res.status(400).json({ error: 'Missing lid' });
    const { data: listing, error: fetchErr } = await supabase
      .from('listings').select('*').eq('id', lid).single();
    if (fetchErr || !listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.status !== 'active') return res.status(400).json({ error: 'Already sold' });
    if (listing.seller === username) return res.status(400).json({ error: 'Cannot buy own listing' });
    if (player.tokens < listing.price) return res.status(400).json({ error: 'Insufficient EXT' });

    // Mark sold
    await supabase.from('listings').update({ status: 'sold', buyer: username }).eq('id', lid);
    // Deduct from buyer
    await supabase.from('players').update({ tokens: player.tokens - listing.price }).eq('username', username);
    // Add to seller
    const { data: seller } = await supabase.from('players').select('tokens').eq('username', listing.seller).single();
    if (seller) await supabase.from('players').update({ tokens: (seller.tokens || 0) + listing.price }).eq('username', listing.seller);

    return res.status(200).json({ ok: true, item: listing.item_data, price: listing.price });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
