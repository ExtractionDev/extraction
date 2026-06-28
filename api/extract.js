import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const _rateLimits = {};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).end();

  const { username, floor, damage_taken, gc_earned } = req.body || {};
  if (!username || typeof gc_earned !== 'number') {
    return res.status(400).json({ error: 'Bad request', got: req.body });
  }

  // Rate limit: max 1 extraction report per 10 seconds per user
  const now = Date.now();
  if (_rateLimits[username] && now - _rateLimits[username] < 10000) {
    return res.status(429).json({ error: 'Rate limited' });
  }
  _rateLimits[username] = now;

  // Cap gc_earned (max 50 GC per second * 300 seconds = 15000 per run)
  const safeGc = Math.min(Math.max(0, Math.floor(gc_earned)), 15000);

  // Get current value
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('gc_extracted, recent_runs, suspicious_count, is_banned')
    .eq('username', username)
    .single();

  if (fetchErr || !player) {
    return res.status(404).json({ error: 'Player not found', detail: fetchErr?.message });
  }

  if (player.is_banned) {
    return res.status(403).json({ error: 'Banned' });
  }

  // Build run record
  const runRecord = {
    floor: Math.floor(floor) || 0,
    damage_taken: Math.floor(damage_taken) || 0,
    gc_earned: safeGc,
    ts: now
  };

  // Update recent runs (keep last 10)
  let recentRuns = Array.isArray(player.recent_runs) ? [...player.recent_runs] : [];
  recentRuns.push(runRecord);
  if (recentRuns.length > 10) recentRuns = recentRuns.slice(-10);

  // God mode detection: floor >= 5 with 0 damage
  let suspCount = player.suspicious_count || 0;
  let isBanned = false;
  if (runRecord.floor >= 5 && runRecord.damage_taken === 0) {
    const suspInRecent = recentRuns.filter(r => r.floor >= 5 && r.damage_taken === 0).length;
    if (suspInRecent >= 3) suspCount++;
    if (suspCount >= 5) isBanned = true;
  }

  // Update player
  const updateData = {
    gc_extracted: (player.gc_extracted || 0) + safeGc,
    recent_runs: recentRuns,
    suspicious_count: suspCount
  };
  if (isBanned) {
    updateData.is_banned = true;
    updateData.ban_reason = 'god_mode_detected';
  }

  const { error: updateErr } = await supabase
    .from('players')
    .update(updateData)
    .eq('username', username);

  if (updateErr) {
    return res.status(500).json({ error: 'Update failed', detail: updateErr.message });
  }

  return res.status(200).json({ ok: true, gc_extracted: updateData.gc_extracted, banned: isBanned });
}
