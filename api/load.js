export default async function handler(req, res) {
  const { username } = req.query;
  if(!username) return res.status(400).json({ error: 'Missing username' });

  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/players?username=eq.${username}&select=*`, {
    headers: {
      'apikey': process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
    }
  });

  const rows = await response.json();
  if(!rows.length) return res.status(404).json({ error: 'Player not found' });

  res.status(200).json(rows[0]);
}
