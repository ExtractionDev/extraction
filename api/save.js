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

const VALID_UPS    = ['speed', 'power', 'sell', 'luck'];
const VALID_ORES   = ['Coal', 'Copper', 'Iron', 'Silver', 'Gold', 'Mystrile'];
const MAX_UP_LEVEL = 500;
const MAX_UP_GAIN  = 10;          // upgrades may rise at most this much per save
const MAX_GOLD     = 9999999999;
const MAX_TOKENS   = 9999999999;
const MAX_ITEM_PRICE = 100000;    // mythic items cap at 99999 in-game
const MAX_INVENTORY  = 50;

// Per-rarity legitimate affix bounds (from RARS in index.html: ac=count, ar=value).
// Any injected item is normalised down to these — an injected "god item" can no
// longer grant absurd equip bonuses or carry an absurd marketplace price.
const RARITY = {
  Common:    { maxCount: 1, maxVal: 5 },
  Uncommon:  { maxCount: 2, maxVal: 8 },
  Rare:      { maxCount: 3, maxVal: 12 },
  Epic:      { maxCount: 4, maxVal: 18 },
  Legendary: { maxCount: 5, maxVal: 25 },
  Mythic:    { maxCount: 5, maxVal: 40 }
};
const VALID_AFFIX_KEYS = ['speed', 'power', 'sell', 'luck', 'dungeonGC', 'crystalRes'];
const FIXED_AFFIX      = { dungeonGC: 10, crystalRes: 25 }; // these affixes have exact values

// Generous server-side UPPER BOUND on tokens earnable per second, derived from the
// player's (already-capped) upgrade levels. Mirrors the game's earning formulas
// (getSpd/getPow/getSell in index.html) with very loose headroom — max gear
// (+400% each), lowest rock HP (5), best rock multiplier (25) — so a legitimate
// player is NEVER throttled, while a fresh account still can't claim millions.
function maxEarnPerSec(ups) {
  const speed = Math.min(Math.max(0, ups.speed || 0), MAX_UP_LEVEL);
  const power = Math.min(Math.max(0, ups.power || 0), MAX_UP_LEVEL);
  const sell  = Math.min(Math.max(0, ups.sell  || 0), MAX_UP_LEVEL);
  const spd   = 0.5 + speed * 0.015;   // swings/sec
  const pow   = 1.0 + power * 0.12;    // dmg/swing
  const sellV = 0.01 + sell * 0.003;   // EXT/rock
  // rocks/sec ≈ (spd*gearMax) * (pow*gearMax) / minRockHP ; EXT = rocks * sellV*gearMax * rockMulti
  const ROCK_HP_MIN = 5, ROCK_MULTI_MAX = 25, GEAR = 5;
  return (sellV * GEAR) * ((spd * GEAR) * (pow * GEAR) / ROCK_HP_MIN) * ROCK_MULTI_MAX;
}

function clampInventory(inventory) {
  if (!Array.isArray(inventory)) return [];
  const out = [];
  for (const item of inventory) {
    if (!item || !item.id || !item.mat || !item.type || !item.rarN) continue;
    const bounds = RARITY[item.rarN];
    if (!bounds) continue; // unknown rarity → drop (can't have come from the game)

    // Normalise affixes to legitimate count/value for this rarity.
    let affixes = [];
    if (Array.isArray(item.affixes)) {
      const seen = {};
      for (const a of item.affixes) {
        if (!a) continue;
        const k = a.tk || (a.t && a.t.k);
        if (!VALID_AFFIX_KEYS.includes(k) || seen[k]) continue;
        seen[k] = true;
        let v = Object.prototype.hasOwnProperty.call(FIXED_AFFIX, k)
          ? FIXED_AFFIX[k]
          : Math.min(Math.max(0, Math.floor(a.v || 0)), bounds.maxVal);
        affixes.push({ tk: k, v });
        if (affixes.length >= bounds.maxCount) break;
      }
    }

    out.push({
      id:       String(item.id).slice(0, 32),
      slot:     item.slot || 'pickaxe',
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
    .select('session_token, gold, tokens, total_rocks, runs, chests, ups, ore_stash, lifetime_ext, updated_at')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session token' });

  const {
    gold, totalRocks, runs, chests, ups, oreStash,
    inventory, eqSlots, gameStats, _achiev, lifetimeExt
  } = data;
  // NOTE: `tokens` from the client is intentionally IGNORED. The balance is
  // server-authoritative — see the mining-delta block below.

  // ── Gold: capped absolute (not withdrawable; low risk). ─────────────────
  const safeGold = Math.min(Math.max(0, Math.floor(gold || 0)), MAX_GOLD);

  // ── Monotonic stats ─────────────────────────────────────────────────────
  const safeRocks  = Math.max(player.total_rocks || 0, Math.floor(totalRocks || 0));
  const safeRuns   = Math.max(player.runs   || 0, Math.floor(runs   || 0));
  const safeChests = Math.max(player.chests || 0, Math.floor(chests || 0));

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
    safeOreStash[ore] = Math.max(prev, Math.min(want, prev + 500));
  });

  // ── Inventory: structurally sanitised + affixes/price clamped to rarity ──
  const safeInventory = clampInventory(inventory);

  // ── TOKEN / LIFETIME: the money path. Server-authoritative. ─────────────
  // Legit mining raises tokens and lifetime_ext by the SAME amount. lifetime_ext
  // is monotonic, so the claimed mining delta = newLifetime - prevLifetime.
  // We credit only that delta, bounded by (a) an absolute per-save ceiling and
  // (b) elapsed-time × a generous max earn rate for this player's level. The
  // client's asserted token TOTAL is never trusted; tokens are applied as an
  // ATOMIC INCREMENT so concurrent spends (entry/market/withdraw) can't be
  // clobbered, and a stale save can neither inflate the balance nor erase a
  // server-credited gain (jackpot/deposit).
  const prevLifetime = parseFloat(player.lifetime_ext) || 0;
  const claimLifetime = Math.max(prevLifetime, parseFloat(lifetimeExt) || 0); // monotonic
  let rawDelta = claimLifetime - prevLifetime;
  if (!(rawDelta > 0)) rawDelta = 0;

  // Elapsed since last save (server clock; client can't fake it). Clamp to the
  // game's 8h offline-earning cap. Default to a small window if no prior save.
  let elapsedSec = 300;
  if (player.updated_at) {
    const dt = (Date.now() - Date.parse(player.updated_at)) / 1000;
    if (isFinite(dt)) elapsedSec = Math.max(0, Math.min(dt, 8 * 3600));
  }
  const timeCeiling = maxEarnPerSec(safeUps) * elapsedSec;

  let allowedDelta = Math.min(rawDelta, 1000000, timeCeiling);
  if (!(allowedDelta > 0)) allowedDelta = 0;
  // Never let the running total exceed the absolute cap.
  const headroom = Math.max(0, MAX_TOKENS - (parseFloat(player.tokens) || 0));
  allowedDelta = Math.min(allowedDelta, headroom);

  // ── Write everything EXCEPT tokens/lifetime_ext via upsert ──────────────
  // (those two are handled by the atomic RPC below so they compose correctly
  //  with concurrent server-side balance changes).
  const { error: updateErr } = await supabase
    .from('players')
    .upsert({
      username,
      gold:           safeGold,
      total_rocks:    safeRocks,
      runs:           safeRuns,
      chests:         safeChests,
      ups:            safeUps,
      ore_stash:      safeOreStash,
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

  // ── Apply mining atomically: tokens += delta, lifetime_ext += delta ──────
  let newTokens = parseFloat(player.tokens) || 0;
  if (allowedDelta > 0) {
    const { data: rpcData, error: incErr } = await supabase
      .rpc('apply_mining', { p_username: username, p_amount: allowedDelta });
    if (incErr) {
      console.error('apply_mining failed:', incErr);
      // The non-money fields already saved; report balance unchanged this tick.
    } else if (rpcData != null) {
      newTokens = parseFloat(rpcData) || newTokens;
    }

    // Pool contribution: 10% of the (bounded) new mining. Atomic, existing RPC.
    const { error: poolErr } = await supabase
      .rpc('add_to_pool', { amount: allowedDelta * 0.10 });
    if (poolErr) console.error('Pool contribution error:', poolErr);
  }

  return res.status(200).json({ ok: true, newTokens });
}
