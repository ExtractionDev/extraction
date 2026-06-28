// Rate limiting — max 1 save per 4 seconds per user
const _rateLimits = {};

export default async function handler(req, res) {
  if(req.method !== 'POST') return res.status(405).end();
  
  const { username, token, data } = req.body;
  if(!username || !token || !data) return res.status(400).json({ error: 'Missing data' });

  // Rate limit check
  const now = Date.now();
  if(_rateLimits[username] && now - _rateLimits[username] < 4000) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  _rateLimits[username] = now;

  // Fetch current server state
  const currentRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/players?username=eq.${username}&select=*`,
    { headers: { 'apikey': process.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}` }}
  );
  const rows = await currentRes.json();
  const current = rows[0];

  if(!current) return res.status(403).json({ error: 'Player not found' });

  // SECURITY: Validate session token
  if(current.session_token !== token) {
    console.warn(`INVALID TOKEN: ${username} tried to save with wrong token`);
    return res.status(403).json({ error: 'Invalid session token' });
  }

  const secsSinceLastSave = Math.max(0, (Date.now() - new Date(current.updated_at).getTime()) / 1000);
  
  // SECURITY: Validate EXT earnings
  const MAX_EXT_PER_SEC = 5;
  let safeTokens = data.tokens || 0;
  const tokenIncrease = safeTokens - (current.tokens || 0);
  if(tokenIncrease > MAX_EXT_PER_SEC * secsSinceLastSave) {
    console.warn(`CHEAT DETECTED: ${username} tried to add ${tokenIncrease} EXT`);
    safeTokens = current.tokens + (MAX_EXT_PER_SEC * secsSinceLastSave);
  }

  // SECURITY: Validate gold earnings
  const MAX_GOLD_PER_SEC = 50;
  let safeGold = data.gold || 0;
  const goldIncrease = safeGold - (current.gold || 0);
  if(goldIncrease > MAX_GOLD_PER_SEC * secsSinceLastSave) {
    console.warn(`CHEAT DETECTED: ${username} tried to add ${goldIncrease} gold`);
    safeGold = current.gold + (MAX_GOLD_PER_SEC * secsSinceLastSave);
  }

  // SECURITY: Rocks and runs can only go up
  const safeRocks = Math.max(current.total_rocks || 0, data.totalRocks || 0);
  const safeRuns = Math.max(current.runs || 0, data.runs || 0);

  // SECURITY: Validate inventory items
  const VALID_MATS = ['Iron','Steel','Gold','Mithril','Adamant','Rune','Dragon'];
  const VALID_TYPES = ['Pickaxe'];
  const VALID_RARS = ['Common','Uncommon','Rare','Epic','Legendary'];
  const safeInventory = (data.inventory || []).filter(function(item) {
    return VALID_MATS.includes(item.mat) && 
           VALID_TYPES.includes(item.type) && 
           VALID_RARS.includes(item.rarN);
  });

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
        inventory: safeInventory,
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
