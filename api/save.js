import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── CORS ────────────────────────────────────────────────────────────────────
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
const MAX_UP_GAIN  = 50;
const MAX_GOLD     = 9999999999;
const MAX_TOKENS   = 9999999999;
const MAX_ITEM_PRICE = 100000;
const MAX_INVENTORY  = 50;

const MAX_RUNS_GAIN   = 50;
const MAX_CHESTS_GAIN = 50;
const MAX_ROCKS_GAIN  = 200000;
// Auto-ban if a single upload claims MORE than this many new rocks.
// Legit max is ~320/upload at 20s autosave with fully-maxed upgrades (~640 if a
// save is delayed/merged). 10,000 is ~15x that ceiling: no real player reaches
// it, but scripted/edited clients claiming 100k+ get caught. Lower to tighten.
const ROCKS_CHEAT_LIMIT = 10000;
const MAX_ORE_GAIN    = 500;

const MAX_GOLD_PER_RUN = 50000;
const GOLD_BUFFER      = 1000;

const VALID_STAT_KEYS = ['bestGC','deepestFloor','enemiesKilled','totalDmg','rareRocks','goldRocks','mystrileRocks'];
const STAT_GAIN_CAP   = 100000;
const STAT_MAX        = 1e12;

const VALID_SLOTS = ['pickaxe','head','ring','amulet'];

const REFINE_CAP_MULT = 1.65;
const ENTRY_WINDOW_MS = 60 * 60 * 1000;

// ── Anti-cheat thresholds (BAN only on values that are impossible or wildly
//    beyond what the player's own activity could produce — never on merely
//    "high" values a legit grinder could reach). ──────────────────────────────
const GOLD_CHEAT_MARGIN  = 1000000; // gold beyond runs-justified by >1M = fabricated
const TOKEN_CHEAT_MARGIN = 1000000; // token total beyond creditable by >1M = mint attempt
const AFFIX_CHEAT_FACTOR = 2;       // affix value beyond 2× its rarity max = fabricated gear

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
      id: String(item.id).slice(0, 32), slot,
      slotIcon: item.slotIcon || 'ti-pickaxe',
      mat: String(item.mat).slice(0, 32), type: String(item.type).slice(0, 32),
      rarN: item.rarN, affixes,
      price: Math.min(Math.max(0, Math.floor(item.price || 0)), MAX_ITEM_PRICE)
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
    .select('session_token, gold, tokens, total_rocks, runs, chests, ups, ore_stash, lifetime_ext, game_stats, updated_at, last_entry_fee, last_entry_at, banned, reset_flag')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session token' });
  if (player.banned) return res.status(403).json({ error: 'Account suspended.' });

  // ── ADMIN RESET ─────────────────────────────────────────────────────────
  // If an admin set reset_flag = true (e.g. via SQL), wipe this account to base
  // ONCE, clear the flag immediately, and tell the client to clear local storage
  // and reload. Fire-once is deliberate: an earlier "hold until clean" version
  // kept the flag set until the client saved a base state, which meant an active
  // player (who always has ups/gold) got re-wiped on every single save and could
  // never keep an upgrade. The client wipe+reload already prevents stale data
  // from being re-uploaded, so one reset is enough.
  if (player.reset_flag === true) {
    const baseRow = {
      username,
      gold: 50,
      tokens: 0,
      total_rocks: 0,
      runs: 0,
      chests: 0,
      ups: { speed: 0, power: 0, sell: 0, luck: 0 },
      ore_stash: {},
      inventory: [],
      equipped_slots: {},
      game_stats: {},
      achievements: {},
      lifetime_ext: 0,
      last_entry_fee: 0,
      reset_flag: false, // clear immediately — fire once
      updated_at: new Date().toISOString()
    };
    const { error: resetErr } = await supabase
      .from('players')
      .upsert(baseRow, { onConflict: 'username' });
    if (resetErr) {
      console.error('Admin reset failed:', resetErr);
      return res.status(500).json({ error: 'Reset failed — try again.' });
    }
    return res.status(200).json({ ok: true, reset: true });
  }

  const {
    gold, totalRocks, runs, chests, ups, oreStash,
    inventory, eqSlots, gameStats, _achiev, lifetimeExt, tokens
  } = data;
  // client-sent `tokens` is IGNORED for the balance — only used below to detect mint attempts.

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
  const runsDelta  = Math.max(0, safeRuns - prevRuns);
  const allowedGoldGain = runsDelta * MAX_GOLD_PER_RUN + GOLD_BUFFER;
  let safeGold = (clientGold <= prevGold) ? clientGold : Math.min(clientGold, prevGold + allowedGoldGain);
  safeGold = Math.min(safeGold, MAX_GOLD);

  // ── Upgrades ────────────────────────────────────────────────────────────
  const safeUps = {};
  VALID_UPS.forEach(k => {
    const prev = player.ups ? (player.ups[k] || 0) : 0;
    const want = Math.floor((ups && ups[k]) || 0);
    safeUps[k] = Math.max(prev, Math.min(want, Math.min(MAX_UP_LEVEL, prev + MAX_UP_GAIN)));
  });

  // ── Ore stash ───────────────────────────────────────────────────────────
  // Decreases are always allowed (the player spent ore on upgrades / listings).
  // Increases are still capped at +MAX_ORE_GAIN per save so ore can't be fabricated.
  const safeOreStash = {};
  VALID_ORES.forEach(ore => {
    const prev = player.ore_stash ? (player.ore_stash[ore] || 0) : 0;
    const want = Math.max(0, Math.floor((oreStash && oreStash[ore]) || 0));
    safeOreStash[ore] = Math.min(want, prev + MAX_ORE_GAIN);
  });

  // ── gameStats ───────────────────────────────────────────────────────────
  const prevStats = player.game_stats || {};
  const safeStats = {};
  VALID_STAT_KEYS.forEach(k => {
    const prev = Math.max(0, Math.floor(prevStats[k] || 0));
    const want = Math.max(0, Math.floor((gameStats && gameStats[k]) || 0));
    safeStats[k] = Math.min(Math.max(prev, Math.min(want, prev + STAT_GAIN_CAP)), STAT_MAX);
  });

  // ── Inventory + equipped ────────────────────────────────────────────────
  const safeInventory = clampInventory(inventory);
  const invIds = new Set(safeInventory.map(it => it.id));
  const safeEqSlots = {};
  if (eqSlots && typeof eqSlots === 'object') {
    VALID_SLOTS.forEach(slot => {
      const id = eqSlots[slot];
      safeEqSlots[slot] = (typeof id === 'string' && invIds.has(id)) ? id : null;
    });
  }

  // ── Token / lifetime bounded credit ─────────────────────────────────────
  const prevLifetime  = parseFloat(player.lifetime_ext) || 0;
  const claimLifetime = Math.max(prevLifetime, parseFloat(lifetimeExt) || 0);
  let rawDelta = claimLifetime - prevLifetime;
  if (!(rawDelta > 0)) rawDelta = 0;

  // Seconds since the last save. Frequent client autosaves make this tiny (a few
  // seconds), which used to crush timeCeiling — and thus the credit — to ~0 on
  // every save, so mined EXT never landed server-side. Enforce the earn-rate cap
  // over a MINIMUM window so a save that arrives 3s after the last one is still
  // allowed to credit the earnings accrued during that period. The rate cap
  // itself (maxEarnPerSec) still prevents crediting faster than upgrades allow.
  const MIN_CREDIT_WINDOW_SEC = 300; // rolling window floor (5 min)
  let elapsedSec = MIN_CREDIT_WINDOW_SEC;
  if (player.updated_at) {
    const dt = (Date.now() - Date.parse(player.updated_at)) / 1000;
    if (isFinite(dt)) {
      // Floor at the window so rapid saves still credit; cap at 8h against idle abuse.
      elapsedSec = Math.max(MIN_CREDIT_WINDOW_SEC, Math.min(dt, 8 * 3600));
    }
  }
  // Hard ceiling: mining can never credit more than MAX_MINE_PER_HOUR, regardless
  // of upgrades or window length. This bounds the pure-mining path only; the
  // dungeon refineBurst and the jackpot (award_jackpot in load.js) are separate
  // and intentionally not limited by this.
  const MAX_MINE_PER_HOUR = 5000;
  const mineCap = MAX_MINE_PER_HOUR * (elapsedSec / 3600);
  const timeCeiling = Math.min(maxEarnPerSec(safeUps) * elapsedSec, mineCap);

  // refineBurst is retired: refining a run's ore now awards GC (progression),
  // not $EXT, so the client's lifetime_ext no longer jumps on refine. Zeroing
  // this closes the old per-run mint headroom (last_entry_fee × 1.65) that a
  // hacked client could otherwise claim as $EXT. Mining stays bounded by
  // timeCeiling below. (last_entry_fee is still cleared so old flags settle.)
  let refineBurst = 0;

  let allowedDelta = Math.min(rawDelta, 1000000, timeCeiling + refineBurst);
  if (!(allowedDelta > 0)) allowedDelta = 0;
  const prevTokens = parseFloat(player.tokens) || 0;
  const headroom = Math.max(0, MAX_TOKENS - prevTokens);
  allowedDelta = Math.min(allowedDelta, headroom);
  const consumedBurst = false;

  // ── CHEAT DETECTION → AUTO-BAN ──────────────────────────────────────────
  // Only fires on values impossible for the real client, or wildly beyond what
  // the player's own runs/balance could justify. Never on merely-high values.
  const cheatReasons = [];

  VALID_UPS.forEach(k => {
    const want = Math.floor((ups && ups[k]) || 0);
    if (want > MAX_UP_LEVEL) cheatReasons.push(`upgrade ${k}=${want} > max ${MAX_UP_LEVEL}`);
  });

  if (clientGold > prevGold + allowedGoldGain + GOLD_CHEAT_MARGIN) {
    cheatReasons.push(`gold ${clientGold} exceeds run-earnable ${Math.floor(prevGold + allowedGoldGain)} by >${GOLD_CHEAT_MARGIN}`);
  }

  const tokenClaim = Math.floor(parseFloat(tokens) || 0);
  if (tokenClaim > prevTokens + allowedDelta + TOKEN_CHEAT_MARGIN) {
    cheatReasons.push(`tokens ${tokenClaim} exceeds creditable ${Math.floor(prevTokens + allowedDelta)} by >${TOKEN_CHEAT_MARGIN}`);
  }

  // Rocks-per-upload cap: a single save claiming more new rocks than a human
  // could mine indicates a memory editor / scripted client.
  const rocksClaimed = Math.floor(totalRocks || 0);
  const rocksDelta = rocksClaimed - prevRocks;
  if (rocksDelta > ROCKS_CHEAT_LIMIT) {
    cheatReasons.push(`rocks +${rocksDelta} in one upload exceeds limit ${ROCKS_CHEAT_LIMIT}`);
  }

  if (Array.isArray(inventory)) {
    for (const item of inventory) {
      if (!item || !item.rarN) continue;
      const b = RARITY[item.rarN];
      if (!b || !Array.isArray(item.affixes)) continue;
      for (const a of item.affixes) {
        if (!a) continue;
        const k = a.tk || (a.t && a.t.k);
        if (Object.prototype.hasOwnProperty.call(FIXED_AFFIX, k)) continue;
        if ((a.v || 0) > b.maxVal * AFFIX_CHEAT_FACTOR) {
          cheatReasons.push(`affix ${k}=${a.v} on ${item.rarN} > ${b.maxVal * AFFIX_CHEAT_FACTOR}`);
          break;
        }
      }
    }
  }

  if (cheatReasons.length) {
    const reasonText = cheatReasons.join('; ');
    await supabase.from('players').update({
      banned: true,
      banned_reason: reasonText.slice(0, 500),
      banned_at: new Date().toISOString()
    }).eq('username', username);
    try {
      await supabase.from('cheat_log').insert({
        username,
        reasons: reasonText.slice(0, 1000),
        details: { clientGold, tokenClaim, ups: ups || null }
      });
    } catch (e) { /* ignore logging errors */ }
    return res.status(403).json({ error: 'Account suspended for invalid game data.' });
  }

  // ── Write everything except tokens/lifetime_ext ─────────────────────────
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
  // NOTE: last_entry_fee is intentionally NOT written here anymore. It's set by
  // the entry endpoint and must survive until the jackpot pull, which scales its
  // payout by the entry fee. refineBurst is retired so nothing credits off it,
  // making it safe to preserve. (Reset still zeroes it in the base row.)

  const { error: updateErr } = await supabase
    .from('players')
    .upsert(row, { onConflict: 'username' });

  if (updateErr) {
    console.error('Save error:', updateErr);
    return res.status(500).json({ error: updateErr.message });
  }

  // ── Apply earnings atomically ───────────────────────────────────────────
  // DIAGNOSTIC: print the exact numbers so we can see why credit is/ isn't happening.
  console.log('SAVE CREDIT', JSON.stringify({
    username,
    clientLifetimeExt: parseFloat(lifetimeExt) || 0,
    serverLifetimeExt: prevLifetime,
    rawDelta,
    timeCeiling,
    refineBurst,
    allowedDelta,
    prevTokens
  }));
  let newTokens = prevTokens;
  if (allowedDelta > 0) {
    const { data: rpcData, error: incErr } = await supabase
      .rpc('apply_mining', { p_username: username, p_amount: allowedDelta });
    if (incErr) {
      console.error('apply_mining failed:', incErr);
    } else if (rpcData != null) {
      newTokens = parseFloat(rpcData) || newTokens;
    }
    const { error: poolErr } = await supabase
      .rpc('add_to_pool', { amount: allowedDelta * 0.10 });
    if (poolErr) console.error('Pool contribution error:', poolErr);
  } else {
    console.log('SAVE CREDIT: allowedDelta is 0 — nothing credited. lifetimeExt client<=server?', (parseFloat(lifetimeExt)||0) <= prevLifetime);
  }

  return res.status(200).json({ ok: true, newTokens });
}
