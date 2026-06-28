import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Anti-cheat limits
const MAX_EXT_PER_SEC = 5;
const MAX_GOLD_PER_SEC = 50;
const RATE_LIMIT_MS = 4000;
const _rateLimits = {};

// Valid item metadata
const VALID_ORES = ['Iron','Steel','Gold','Mithril','Adamant','Rune','Dragon'];
const VALID_TYPES = ['Pickaxe'];
const VALID_RARITIES = ['Common','Uncommon','Rare','Epic','Legendary'];
const VALID_UPS = ['speed','power','sell','luck'];
const MAX_UP_LEVEL = 500;
const MAX_UP_GAIN = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    username, token, gold, tokens, total_rocks, runs, chests,
    ups, ore_stash, inventory, equipped_slots, game_stats, achievements,
    extraction  // { floor, damage_taken, gc_earned } — only on safe extract
  } = req.body || {};

  if (!username) return res.status(400).json({ error: 'Missing username' });
  // Allow token-less requests only for extraction reporting (older sessions without token)
  const extractionOnly = !token && extraction;

  // Rate limiting
  const now = Date.now();
  if (_rateLimits[username] && now - _rateLimits[username] < RATE_LIMIT_MS) {
    return res.status(429).json({ error: 'Rate limited' });
  }
  _rateLimits[username] = now;

  // Validate session token
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, gold, tokens, total_rocks, runs, updated_at, recent_runs, suspicious_count, is_banned, gc_extracted')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found' });
  // Skip token check for extraction-only saves (backwards compat with pre-token logins)
  if (token && player.session_token && player.session_token !== token) return res.status(403).json({ error: 'Invalid session token' });
  if (player.is_banned) return res.status(403).json({ error: 'Account banned from leaderboard' });

  // Time-based caps
  const lastSaved = player.updated_at ? new Date(player.updated_at).getTime() : now - 60000;
  const elapsedSec = Math.max(1, (now - lastSaved) / 1000);
  const maxGold = (player.gold || 0) + Math.floor(elapsedSec * MAX_GOLD_PER_SEC);
  const maxTokens = (player.tokens || 0) + elapsedSec * MAX_EXT_PER_SEC;

  const safeGold = Math.min(gold || 0, maxGold);
  const safeTokens = Math.min(tokens || 0, maxTokens);

  // Rocks/runs can only go up
  const safeRocks = Math.max(player.total_rocks || 0, total_rocks || 0);
  const safeRuns = Math.max(player.runs || 0, runs || 0);

  // Validate upgrades
  const safeUps = {};
  if (ups && typeof ups === 'object') {
    VALID_UPS.forEach(k => {
      const prev = player.ups ? (player.ups[k] || 0) : 0;
      const next = Math.min(ups[k] || 0, MAX_UP_LEVEL);
      safeUps[k] = Math.max(prev, Math.min(next, prev + MAX_UP_GAIN));
    });
  }

  // Validate inventory
  let safeInventory = [];
  if (Array.isArray(inventory)) {
    safeInventory = inventory.filter(item =>
      item && VALID_ORES.includes(item.mat) &&
      VALID_TYPES.includes(item.type) &&
      VALID_RARITIES.includes(item.rarity) &&
      typeof item.affixPow === 'number' && item.affixPow >= 0 && item.affixPow <= 100
    ).slice(0, 50);
  }

  // Validate ore stash
  let safeOreStash = {};
  if (ore_stash && typeof ore_stash === 'object') {
    VALID_ORES.forEach(ore => {
      const prev = player.ore_stash ? (player.ore_stash[ore] || 0) : 0;
      const next = ore_stash[ore] || 0;
      safeOreStash[ore] = Math.max(prev, Math.min(next, prev + 500));
    });
  }

  // --- God mode detection on safe extraction ---
  let newRecentRuns = Array.isArray(player.recent_runs) ? [...player.recent_runs] : [];
  let newSuspiciousCount = player.suspicious_count || 0;
  let newGcExtracted = player.gc_extracted || 0;
  let isBanned = false;
  let banReason = null;

  if (extraction && typeof extraction === 'object') {
    const { floor, damage_taken, gc_earned } = extraction;
    const runRecord = {
      floor: floor || 0,
      damage_taken: damage_taken || 0,
      gc_earned: gc_earned || 0,
      ts: now
    };

    // Add to recent runs, keep last 10
    newRecentRuns.push(runRecord);
    if (newRecentRuns.length > 10) newRecentRuns = newRecentRuns.slice(-10);

    // Check for god mode: floor 5+ with 0 damage
    if ((floor || 0) >= 5 && (damage_taken || 0) === 0) {
      // Count how many suspicious runs in last 10
      const suspiciousInRecent = newRecentRuns.filter(r => r.floor >= 5 && r.damage_taken === 0).length;
      if (suspiciousInRecent >= 3) {
        newSuspiciousCount++;
      }
      if (newSuspiciousCount >= 5) {
        isBanned = true;
        banReason = 'god_mode_detected';
      }
    }

    // Add GC from this extraction to lifetime total
    newGcExtracted += Math.max(0, gc_earned || 0);
  }

  // Build update object
  const updateData = {
    gold: Math.round(safeGold),
    tokens: safeTokens,
    total_rocks: safeRocks,
    runs: safeRuns,
    chests: Math.max(player.chests || 0, chests || 0),
    ups: safeUps,
    ore_stash: safeOreStash,
    inventory: safeInventory,
    equipped_slots: equipped_slots || {},
    game_stats: game_stats || {},
    achievements: achievements || {},
    updated_at: new Date().toISOString(),
    recent_runs: newRecentRuns,
    suspicious_count: newSuspiciousCount,
    gc_extracted: newGcExtracted
  };

  if (isBanned) {
    updateData.is_banned = true;
    updateData.ban_reason = banReason;
  }

  const { error: updateErr } = await supabase
    .from('players')
    .update(updateData)
    .eq('username', username);

  if (updateErr) return res.status(500).json({ error: 'Save failed' });

  return res.status(200).json({ ok: true, banned: isBanned });
}
