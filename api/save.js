export default async function handler(req, res) {
  if(req.method !== 'POST') return res.status(405).end();
  
  const { username, data } = req.body;
  if(!username || !data) return res.status(400).json({ error: 'Missing data' });

  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/players?username=eq.${username}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
    },
    body: JSON.stringify({
      gold: data.gold,
      tokens: data.tokens,
      total_rocks: data.totalRocks,
      runs: data.runs,
      chests: data.chests,
      inventory: data.inventory,
      equipped_slots: data.eqSlots,
      ore_stash: data.oreStash,
      ups: data.ups,
      game_stats: data.gameStats,
      achievements: data._achiev,
      updated_at: new Date().toISOString()
    })
  });

  res.status(response.ok ? 200 : 500).json({ ok: response.ok });
}
