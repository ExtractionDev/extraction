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

  // SECURITY: Validate upgrades — max level 500, only known keys allowed
  const VALID_UPS = ['speed','power','sell','luck'];
  const safeUps = {};
  const currentUps = current.ups || {};
  for(const key of VALID_UPS) {
    const submitted = Math.floor(data.ups?.[key] || 0);
    const existing = Math.floor(currentUps[key] || 0);
    // Can only go up, never down, never above 500
    safeUps[key] = Math.min(500, Math.max(existing, submitted));
    // Can't jump more than reasonable per session (max ~10 levels per save)
    if(safeUps[key] > existing + 10) {
      console.warn(`CHEAT DETECTED: ${username} tried to jump ${key} from ${existing} to ${submitted}`);
      safeUps[key] = existing + 10;
    }
  }

  // SECURITY: Validate inventory items and affix values
  const VALID_MATS = ['Iron','Steel','Gold','Mithril','Adamant','Rune','Dragon'];
  const VALID_TYPES = ['Pickaxe'];
  const VALID_RARS = ['Common','Uncommon','Rare','Epic','Legendary'];
  const safeInventory = (data.inventory || []).filter(function(item) {
    if(!VALID_MATS.includes(item.mat)) return false;
    if(!VALID_TYPES.includes(item.type)) return false;
    if(!VALID_RARS.includes(item.rarN)) return false;
    if(item.affixes && Array.isArray(item.affixes)) {
      for(const a of item.affixes) {
        if(typeof a.v !== 'number') return false;
        if(a.v > 100 || a.v < 0) return false;
      }
    }
    return true;
  });

  // SECURITY: Validate ore stash values
  const VALID_ORES = ['Coal','Iron','Copper','Silver','Gold','Platinum','Diamond'];
  const safeOreStash = {};
  for(const ore of VALID_ORES) {
    const val = Math.floor(data.oreStash?.[ore] || 0);
    const existing = Math.floor((current.ore_stash)?.[ore] || 0);
    safeOreStash[ore] = Math.max(0, Math.min(val, existing + 500));
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
        chests: Math.max(current.chests || 0, data.chests || 0),
        inventory: safeInventory,
        equipped_slots: data.eqSlots,
        ore_stash: safeOreStash,
        ups: safeUps,
        game_stats: data.gameStats,
        achievements: data._achiev,
        updated_at: new Date().toISOString()
      })
    }
  );

  res.status(response.ok ? 200 : 500).json({ ok: response.ok });
}
