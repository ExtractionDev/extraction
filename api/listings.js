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

  const { action, username, token, item, price, lid, seller_wallet } = req.body || {};
  if (!username || !token) return res.status(400).json({ error: 'Missing credentials' });

  const player = await verifyToken(username, token);
  if (!player) return res.status(403).json({ error: 'Invalid session' });

  // LIST — add a pickaxe listing
  if (action === 'list') {
    const safePrice = parseFloat(price);
    if (!item || !safePrice || safePrice < 0.01) {
      return res.status(400).json({ error: 'Invalid listing — price must be at least $0.01 USDC' });
    }
    if (!seller_wallet) {
      return res.status(400).json({ error: 'Phantom wallet not connected — connect wallet before listing' });
    }
    const { data, error } = await supabase.from('listings').insert({
      seller:        username,
      item_data:     item,
      price:         parseFloat(safePrice.toFixed(6)),
      seller_wallet: seller_wallet,
      status:        'active',
      listed_at:     new Date().toISOString()
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

  // BUY — now handled by /api/market-usdc-buy (USDC on-chain)
  if (action === 'buy') {
    return res.status(400).json({ error: 'EXT purchases disabled — use USDC via Phantom wallet' });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
