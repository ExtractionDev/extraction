import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── CORS (same allowlist pattern as load.js) ────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Tunables ────────────────────────────────────────────────────────────────
const VALID_UPS    = ['speed', 'power', 'sell', 'luck'];
const VALID_ORES   = ['Coal', 'Copper', 'Iron', 'Silver', 'Gold', 'Mystrile'];
const MAX_UP_LEVEL = 500;
const MAX_UP_GAIN  = 50;          // upgrades may rise at most this much per save (0→500 takes 10 saves)
const MAX_GOLD     = 9999999999;
const MAX_TOKENS   = 9999999999;
const MAX_ITEM_PRICE = 100000;
const MAX_INVENTORY  = 50;

// Per-save increase ceilings for monotonic counters (stop them being a backdoor).
const MAX_RUNS_GAIN   = 50;
const MAX_CHESTS_GAIN = 50;
const MAX_ROCKS_GAIN  = 200000;
const MAX_ORE_GAIN    = 500;      // per ore type, per save

// Gold is earned ONLY by completing dungeon runs (gold += final; runs++), so a
// gold INCREASE is bounded by (runs this save) × (max per run). Decreases (spending) allowed.
const MAX_GOLD_PER_RUN = 50000;
const GOLD_BUFFER      = 1000;

// gameStats: whitelist of monotonic counters; anything else is dropped.
const VALID_STAT_KEYS = ['bestGC','deepestFloor','enemiesKilled','totalDmg','rareRocks','goldRocks','mystrileRocks'];
const STAT_GAIN_CAP   = 100000;
const STAT_MAX        = 1e12;

const VALID_SLOTS = ['pickaxe','head','ring','amulet'];

// Refinery: payout is entry_fee × ratio, clamped to REFINE_CAP_MULT (1.65×) in
// index.html. We let a player credit up to (their last paid entry × 1.65) as a
// one-time burst on top of the mining ceiling, valid for ENTRY_WINDOW_MS after
// they paid (a dungeon run takes minutes). The entry fee is consumed once used.
const REFINE_CAP_MULT = 1.65;
const ENTRY_WINDOW_MS = 60 * 60 * 1000; // 60 min

// Per-rarity legitimate affix bounds (from RARS in index.html: ac=count, ar=value).
const RARITY = {
  Common:    { maxCount: 1, maxVal: 5 },
  Uncommon:  { maxCount: 2, maxVal: 8 },
  Rare:      { maxCount: 3, maxVal: 12 },
  Epic:      { maxCount: 4, maxVal: 18 },
  Legendary: { maxCount: 5, maxVal: 25 },
  Mythic:    { maxCount: 5, maxVal: 40 }
};
const VALID_AFFIX_KEYS = ['speed','power','sell','luck','dungeonGC','crystalRes'];
const FIXED_AFFIX      = { dungeonGC: 10, crystalRes: 25 };

// Generous upper bound on tokens earnable per second from (capped) upgrade levels.
function maxEarnPerSec(ups) {
  const speed = Math.min(Math.max(0, ups.speed || 0), MAX_UP_LEVEL);
  const power = Math.min(Math.max(0, ups.power || 0), MAX_UP_LEVEL);
  const sell  = Math.min(Math.max(0, ups.sell  || 0), MAX_UP_LEVEL);
  const spd   = 0.5 + speed * 0.015;
  const pow   = 1.0 + power * 0.12;
  const sellV = 0.01 + sell * 0.003;
  const ROCK_HP_MIN = 5, ROCK_MULTI_MAX = 25, GEAR = 5;
  return (sellV * GEAR) * ((spd * GEAR) * (pow * GEAR) / ROCK_HP_MIN) * ROCK_MULTI_MAX;
}

function clampInventory(inventory) {
  if (!Array.isArray(inventory)) return [];
  const out = [];
  for (const item of inventory) {
    if (!item || !item.id || !item.mat || !item.type || !item.rarN) continue;
    const bounds = RARITY[item.rarN];
    if (!bounds) continue;
    const slot = VALID_SLOTS.includes(item.slot) ? item.slot : 'pickaxe';

    let affixes = [];
    if (Array.isArray(item.affixes)) {
      const seen = {};
      for (const a of item.affixes) {
        if (!a) continue;
        const k = a.tk || (a.t && a.t.k);
        if (!VALID_AFFIX_KEYS.includes(k) || seen[k]) continue;
        seen[k] = true;
        const v = Object.prototype.hasOwnProperty.call(FIXED_AFFIX, k)
          ? FIXED_AFFIX[k]
          : Math.min(Math.max(0, Math.floor(a.v || 0)), bounds.maxVal);
        affixes.push({ tk: k, v });
        if (affixes.length >= bounds.maxCount) break;
      }
    }

    out.push({
      id:       String(item.id).slice(0, 32),
      slot,
      slotIcon: item.slotIcon || 'ti-pickaxe',
      mat:      String(item.mat).slice(0, 32),
      type:     String(item.type).slice(0, 32),
      rarN:     item.rarN,
      affixes,
      price:    Math.min(Math.max(0, Math.floor(item.price || 0)), MAX_ITEM_PRICE)
    });
    if (out.length >= MAX_INVENTORY) break;
  }
  return out;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).end();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { username, token, data } = body || {};
  if (!username || !token || !data) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  // ── Verify session ──────────────────────────────────────────────────────
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, gold, tokens, total_rocks, runs, chests, ups, ore_stash, lifetime_ext, game_stats, updated_at, last_entry_fee, last_entry_at')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session token' });

  const {
    gold, totalRocks, runs, chests, ups, oreStash,
    inventory, eqSlots, gameStats, _achiev, lifetimeExt
  } = data;
  // client-sent `tokens` is intentionally IGNORED — balance is server-authoritative.

  // ── Monotonic counters with per-save increase ceilings ──────────────────
  const prevRuns  = player.runs || 0;
  const safeRuns  = Math.min(Math.max(prevRuns,  Math.floor(runs  || 0)), prevRuns  + MAX_RUNS_GAIN);
  const prevRocks = player.total_rocks || 0;
  const safeRocks = Math.min(Math.max(prevRocks, Math.floor(totalRocks || 0)), prevRocks + MAX_ROCKS_GAIN);
  const prevChests = player.chests || 0;
  const safeChests = Math.min(Math.max(prevChests, Math.floor(chests || 0)), prevChests + MAX_CHESTS_GAIN);

  // ── Gold: increase bounded by runs completed; decrease allowed ──────────
  const prevGold   = player.gold || 0;
  const clientGold = Math.max(0, Math.floor(gold || 0));
  let safeGold;
  if (clientGold <= prevGold) {
    safeGold = clientGold;
  } else {
    const runsDelta   = Math.max(0, safeRuns - prevRuns);
    const allowedGain = runsDelta * MAX_GOLD_PER_RUN + GOLD_BUFFER;
    safeGold = Math.min(clientGold, prevGold + allowedGain);
  }
  safeGold = Math.min(safeGold, MAX_GOLD);

  // ── Upgrades: rise at most MAX_UP_GAIN/save, hard cap MAX_UP_LEVEL ───────
  const safeUps = {};
  VALID_UPS.forEach(k => {
    const prev = player.ups ? (player.ups[k] || 0) : 0;
    const want = Math.floor((ups && ups[k]) || 0);
    safeUps[k] = Math.max(prev, Math.min(want, Math.min(MAX_UP_LEVEL, prev + MAX_UP_GAIN)));
  });

  // ── Ore stash: can only rise, bounded per save ──────────────────────────
  const safeOreStash = {};
  VALID_ORES.forEach(ore => {
    const prev = player.ore_stash ? (player.ore_stash[ore] || 0) : 0;
    const want = Math.floor((oreStash && oreStash[ore]) || 0);
    safeOreStash[ore] = Math.max(prev, Math.min(want, prev + MAX_ORE_GAIN));
  });

  // ── gameStats: whitelist, monotonic, per-save capped ────────────────────
  const prevStats = player.game_stats || {};
  const safeStats = {};
  VALID_STAT_KEYS.forEach(k => {
    const prev = Math.max(0, Math.floor(prevStats[k] || 0));
    const want = Math.max(0, Math.floor((gameStats && gameStats[k]) || 0));
    safeStats[k] = Math.min(Math.max(prev, Math.min(want, prev + STAT_GAIN_CAP)), STAT_MAX);
  });

  // ── Inventory + equipped slots ──────────────────────────────────────────
  const safeInventory = clampInventory(inventory);
  const invIds = new Set(safeInventory.map(it => it.id));
  const safeEqSlots = {};
  if (eqSlots && typeof eqSlots === 'object') {
    VALID_SLOTS.forEach(slot => {
      const id = eqSlots[slot];
      safeEqSlots[slot] = (typeof id === 'string' && invIds.has(id)) ? id : null;
    });
  }

  // ── TOKEN / LIFETIME: server-authoritative atomic credit ────────────────
  // Mining AND refinery both raise tokens and lifetime_ext together, so claimed
  // earnings = newLifetime - prevLifetime. Bounded by: 1M/save, the mining-rate
  // time ceiling, PLUS a one-time refinery burst tied to the player's actual
  // last paid entry fee (recorded by load.js). Applied as an atomic increment.
  const prevLifetime  = parseFloat(player.lifetime_ext) || 0;
  const claimLifetime = Math.max(prevLifetime, parseFloat(lifetimeExt) || 0);
  let rawDelta = claimLifetime - prevLifetime;
  if (!(rawDelta > 0)) rawDelta = 0;

  let elapsedSec = 300;
  if (player.updated_at) {
    const dt = (Date.now() - Date.parse(player.updated_at)) / 1000;
    if (isFinite(dt)) elapsedSec = Math.max(0, Math.min(dt, 8 * 3600));
  }
  const timeCeiling = maxEarnPerSec(safeUps) * elapsedSec;

  // Refinery burst — up to (last paid entry × 1.65), within the time window.
  let refineBurst = 0;
  const lastFee = parseFloat(player.last_entry_fee) || 0;
  if (lastFee > 0 && player.last_entry_at) {
    const age = Date.now() - Date.parse(player.last_entry_at);
    if (isFinite(age) && age >= 0 && age <= ENTRY_WINDOW_MS) {
      refineBurst = lastFee * REFINE_CAP_MULT;
    }
  }

  let allowedDelta = Math.min(rawDelta, 1000000, timeCeiling + refineBurst);
  if (!(allowedDelta > 0)) allowedDelta = 0;
  const headroom = Math.max(0, MAX_TOKENS - (parseFloat(player.tokens) || 0));
  allowedDelta = Math.min(allowedDelta, headroom);

  // Consume the entry fee only if the burst was actually needed (a refine
  // happened — the claimed delta exceeded what mining alone could justify).
  const consumedBurst = refineBurst > 0 && allowedDelta > timeCeiling + 0.0001;

  // ── Write everything EXCEPT tokens/lifetime_ext (those go via atomic RPC) ─
  const row = {
    username,
    gold:           safeGold,
    total_rocks:    safeRocks,
    runs:           safeRuns,
    chests:         safeChests,
    ups:            safeUps,
    ore_stash:      safeOreStash,
    inventory:      safeInventory,
    equipped_slots: safeEqSlots,
    game_stats:     safeStats,
    achievements:   (_achiev && typeof _achiev === 'object') ? _achiev : {},
    updated_at:     new Date().toISOString()
  };
  if (consumedBurst) row.last_entry_fee = 0; // burn the paid entry so it can't refine twice

  const { error: updateErr } = await supabase
    .from('players')
    .upsert(row, { onConflict: 'username' });

  if (updateErr) {
    console.error('Save error:', updateErr);
    return res.status(500).json({ error: updateErr.message });
  }

  // ── Apply earnings atomically: tokens += delta, lifetime_ext += delta ────
  let newTokens = parseFloat(player.tokens) || 0;
  if (allowedDelta > 0) {
    const { data: rpcData, error: incErr } = await supabase
      .rpc('apply_mining', { p_username: username, p_amount: allowedDelta });
    if (incErr) {
      console.error('apply_mining failed:', incErr);
    } else if (rpcData != null) {
      newTokens = parseFloat(rpcData) || newTokens;
    }
    // Pool contribution: 10% of bounded earnings, server-computed. Client can
    // never set the pool — it only moves through this RPC and load.js.
    const { error: poolErr } = await supabase
      .rpc('add_to_pool', { amount: allowedDelta * 0.10 });
    if (poolErr) console.error('Pool contribution error:', poolErr);
  }

  return res.status(200).json({ ok: true, newTokens });
}
