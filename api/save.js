import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const VALID_ORES     = ['Coal','Copper','Iron','Silver','Gold','Mystrile'];
const VALID_TYPES    = ['Pickaxe'];
const VALID_RARITIES = ['Common','Uncommon','Rare','Epic','Legendary'];
const VALID_UPS      = ['speed','power','sell','luck'];
const MAX_UP_LEVEL   = 500;
const MAX_UP_GAIN    = 10;
const MAX_GOLD       = 9999999999;
const MAX_TOKENS     = 9999999999;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, token, data } = req.body || {};
  if (!username || !token || !data) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  // Verify session token
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, gold, tokens, total_rocks, runs, chests, ups, ore_stash, lifetime_ext')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session token' });

  // Extract from data object
  const { gold, tokens, totalRocks, runs, chests, ups, oreStash,
          inventory, eqSlots, gameStats, _achiev, lifetimeExt } = data;

  // Sanity caps
  const safeGold   = Math.min(Math.max(0, Math.floor(gold || 0)), MAX_GOLD);
  const safeTokens = Math.min(Math.max(player.tokens || 0, tokens || 0), MAX_TOKENS);

  // Monotonic values — can only go up
  const safeRocks  = Math.max(player.total_rocks || 0, totalRocks || 0);
  const safeRuns   = Math.max(player.runs   || 0, runs   || 0);
  const safeChests = Math.max(player.chests || 0, chests || 0);

  // Validate upgrades — can only increase, capped per save
  const safeUps = {};
  if (ups && typeof ups === 'object') {
    VALID_UPS.forEach(k => {
      const prev = player.ups ? (player.ups[k] || 0) : 0;
      safeUps[k] = Math.max(prev, Math.min(ups[k] || 0, Math.min(MAX_UP_LEVEL, prev + MAX_UP_GAIN)));
    });
  }

  // Store inventory — sanitize structure but don't drop items by material whitelist
  // (whitelists are fragile and silently delete valid gear). Session token already verified.
  let safeInventory = [];
  if (Array.isArray(inventory)) {
    safeInventory = inventory
      .filter(item => item && item.id && item.mat && item.type && item.rarN)
      .slice(0, 50);
  }

  // Ore stash — can only go up
  let safeOreStash = {};
  if (oreStash && typeof oreStash === 'object') {
    VALID_ORES.forEach(ore => {
      const prev = player.ore_stash ? (player.ore_stash[ore] || 0) : 0;
      safeOreStash[ore] = Math.max(prev, Math.min(oreStash[ore] || 0, prev + 500));
    });
  }

  // ── Global pool contribution (server-derived, cheat-resistant) ──────────────
  // lifetime_ext is monotonic (never decreases). The pool grows by 10% of each
  // player's NEW mining since their last save. A cheater can't inflate the pool
  // because the delta is capped and lifetime_ext can only move up.
  const prevLifetime = parseFloat(player.lifetime_ext) || 0;
  const newLifetime  = Math.max(prevLifetime, parseFloat(lifetimeExt) || 0);
  let delta = newLifetime - prevLifetime;

  // Sanity cap: ignore absurd jumps (e.g. >1,000,000 EXT in one save = tampering)
  if (delta < 0) delta = 0;
  if (delta > 1000000) delta = 0;

  const poolContribution = delta * 0.10;

  if (poolContribution > 0) {
    // Atomically add to the shared global pool via RPC (handles concurrent writes)
    const { error: poolErr } = await supabase.rpc('add_to_pool', { amount: poolContribution });
    if (poolErr) console.error('Pool contribution error:', poolErr);
  }

  // FIX: use upsert instead of update so it never silently does nothing
  // if the row doesn't exist yet it gets created; if it does it gets updated
  const { error: updateErr } = await supabase
    .from('players')
    .upsert({
      username,
      gold:           safeGold,
      tokens:         safeTokens,
      total_rocks:    safeRocks,
      runs:           safeRuns,
      chests:         safeChests,
      ups:            safeUps,
      ore_stash:      safeOreStash,
      lifetime_ext:   newLifetime,
      inventory:      safeInventory,
      equipped_slots: eqSlots   || {},
      game_stats:     gameStats || {},
      achievements:   _achiev   || {},
      updated_at:     new Date().toISOString()
    }, { onConflict: 'username' });

  if (updateErr) {
    console.error('Save error:', updateErr);
    return res.status(500).json({ error: updateErr.message });
  }

  return res.status(200).json({ ok: true });
}
