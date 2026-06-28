export default async function handler(req, res) {
  if(req.method !== 'POST') return res.status(405).end();
  
  const { username, data } = req.body;
  if(!username || !data) return res.status(400).json({ error: 'Missing data' });

  // Fetch current server state to validate against
  const currentRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/players?username=eq.${username}&select=*`,
    { headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` }}
  );
  const rows = await currentRes.json();
  const current = rows[0];

  let safeTokens = data.tokens || 0;
  let safeGold = data.gold || 0;
  let safeRocks = data.totalRocks || 0;
  let safeRuns = data.runs || 0;

  if(current) {
    const secsSinceLastSave = Math.max(0, (Date.now() - new Date(current.updated_at).getTime()) / 1000);
    
    // Max possible EXT per second even with best upgrades (generous cap)
    const MAX_EXT_PER_SEC = 5;
    const maxTokenIncrease = secsSinceLastSave * MAX_EXT_PER_SEC;
    const tokenIncrease = safeTokens - (current.tokens || 0);
    if(tokenIncrease > maxTokenIncrease) {
      console.warn(`CHEAT DETECTED: ${username} tried to add ${tokenIncrease} EXT, max allowed ${maxTokenIncrease}`);
      safeTokens = current.tokens + maxTokenIncrease;
    }

    // Gold can only go up by reasonable amount per second
    const MAX_GOLD_PER_SEC = 50;
    const goldIncrease = safeGold - (current.gold || 0);
    if(goldIncrease > MAX_GOLD_PER_SEC * secsSinceLastSave) {
      console.warn(`CHEAT DETECTED: ${username} tried to add ${goldIncrease} gold`);
      safeGold = current.gold + (MAX_GOLD_PER_SEC * secsSinceLastSave);
    }

    // Rocks and runs can only go up, never down
    safeRocks = Math.max(current.total_rocks || 0, safeRocks);
    safeRuns = Math.max(current.runs || 0, safeRuns);
  }

  const response = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/players?username=eq.${username}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        gold: safeGold,
        tokens: safeTokens,
        total_rocks: safeRocks,
        runs: safeRuns,
        chests: data.chests || 0,
        inventory: data.inventory,
        equipped_slots: data.eqSlots,
        ore_stash: data.oreStash,
        ups: data.ups,
        game_stats: data.gameStats,
        achievements: data._achiev,
        updated_at: new Date().toISOString()
      })
    }
  );

  res.status(response.ok ? 200 : 500).json({ ok: response.ok });
}
