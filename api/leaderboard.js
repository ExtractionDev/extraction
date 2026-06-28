export default async function handler(req, res) {
  const response = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/players?select=username,name,gold,runs,total_rocks,chests&order=gold.desc&limit=50`,
    {
      headers: {
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      }
    }
  );

  const players = await response.json();
  res.status(200).json(players);
}
