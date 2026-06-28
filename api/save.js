import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const RATE_LIMIT_MS = 4000;
const _rateLimits = {};
const VALID_ORES = ['Coal','Copper','Iron','Silver','Gold','Mystrile'];
const VALID_TYPES = ['Pickaxe'];
const VALID_RARITIES = ['Common','Uncommon','Rare','Epic','Legendary'];
const VALID_UPS = ['speed','power','sell','luck'];
const MAX_UP_LEVEL = 500;
const MAX_UP_GAIN = 10;
const MAX_GOLD = 9999999999;
const MAX_TOKENS = 9999999999;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, token, data } = req.body || {};

  if (!username || !token || !data) return res.status(400).json({ error: 'Missing fields' });

  const now = Date.now();
  if (_rateLimits[username] && now - _rateLimits[username] < RATE_LIMIT_MS) {
    return res.status(429).json({ error: 'Rate limited' });
  }
  _rateLimits[username] = now;

  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, gold, tokens, total_rocks, runs, chests, ups, ore_stash')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session token' });

  // Extract from data object (game sends all values nested under 'data')
  const { gold, tokens, totalRocks, runs, chests, ups, oreStash,
          inventory, eqSlots, gameStats, _achiev } = data;

  // Sanity caps — trust client, just prevent impossible values
  const safeGold = Math.min(Math.max(0, Math.floor(gold || 0)), MAX_GOLD);
  const safeTokens = Math.min(Math.max(0, tokens || 0), MAX_TOKENS);

  // Monotonic values — can only go up
  const safeRocks = Math.max(player.total_rocks || 0, totalRocks || 0);
  const safeRuns = Math.max(player.runs || 0, runs || 0);
  const safeChests = Math.max(player.chests || 0, chests || 0);

  // Validate upgrades — can only increase, capped per save
  const safeUps = {};
  if (ups && typeof ups === 'object') {
    VALID_UPS.forEach(k => {
      const prev = player.ups ? (player.ups[k] || 0) : 0;
      safeUps[k] = Math.max(prev, Math.min(ups[k] || 0, Math.min(MAX_UP_LEVEL, prev + MAX_UP_GAIN)));
    });
  }

  // Validate inventory (game uses rarN not rarity)
  let safeInventory = [];
  if (Array.isArray(inventory)) {
    safeInventory = inventory.filter(item =>
      item && VALID_ORES.includes(item.mat) &&
      VALID_TYPES.includes(item.type) &&
      VALID_RARITIES.includes(item.rarN)
    ).slice(0, 50);
  }

  // Ore stash — can only go up
  let safeOreStash = {};
  if (oreStash && typeof oreStash === 'object') {
    VALID_ORES.forEach(ore => {
      const prev = player.ore_stash ? (player.ore_stash[ore] || 0) : 0;
      safeOreStash[ore] = Math.max(prev, Math.min(oreStash[ore] || 0, prev + 500));
    });
  }

  const { error: updateErr } = await supabase
    .from('players')
    .update({
      gold: safeGold,
      tokens: safeTokens,
      total_rocks: safeRocks,
      runs: safeRuns,
      chests: safeChests,
      ups: safeUps,
      ore_stash: safeOreStash,
      inventory: safeInventory,
      equipped_slots: eqSlots || {},
      game_stats: gameStats || {},
      achievements: _achiev || {},
      updated_at: new Date().toISOString()
    })
    .eq('username', username);

  if (updateErr) {
    console.error('Save error:', updateErr);
    return res.status(500).json({ error: updateErr.message });
  }

  return res.status(200).json({ ok: true });
}
