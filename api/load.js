export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Pool mode — return the shared global Excalibur pool
  // Called as /api/load?pool=1
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

  // Normal mode — load a player
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
