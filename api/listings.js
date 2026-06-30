import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

// ── Anti-inflation tunables ──────────────────────────────────────────────
const MIN_EXTRACT_INTERVAL_MS = 30000;   // one extract per 30s per account
const MAX_GC_PER_RUN          = 15000;   // per-run cap
const MAX_GC_PER_DAY          = 150000;  // cumulative 24h ceiling (~10 maxed runs) — TUNE THIS

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).end();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { username, token, floor, damage_taken, gc_earned } = body || {};

  // AUTH: this endpoint writes the leaderboard metric (gc_extracted).
  if (!username || !token || typeof gc_earned !== 'number') {
    return res.status(400).json({ error: 'Bad request' });
  }

  const safeGc = Math.min(Math.max(0, Math.floor(gc_earned)), MAX_GC_PER_RUN);

  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, gc_extracted, recent_runs, suspicious_count, banned')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(404).json({ error: 'Player not found' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session' });
  if (player.banned) return res.status(403).json({ error: 'Account suspended.' });

  // ── Rate-limit: one extract per 30s per account ───────────────────────
  const since = new Date(Date.now() - MIN_EXTRACT_INTERVAL_MS).toISOString();
  const { data: recent } = await supabase
    .from('extract_log')
    .select('id')
    .eq('username', username)
    .gte('created_at', since)
    .limit(1);
  if (recent && recent.length) {
    return res.status(429).json({ error: 'Extracting too fast. Wait a moment.' });
  }

  // ── Cumulative 24h cap: sum GC logged in the last day ─────────────────
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const { data: dayRows } = await supabase
    .from('extract_log')
    .select('gc_earned')
    .eq('username', username)
    .gte('created_at', dayAgo);
  const gcToday = (dayRows || []).reduce((s, r) => s + (r.gc_earned || 0), 0);
  const remainingToday = Math.max(0, MAX_GC_PER_DAY - gcToday);
  const grantedGc = Math.min(safeGc, remainingToday);  // credit only what's left in the daily budget

  const now = Date.now();
  const runRecord = {
    floor: Math.floor(floor) || 0,
    damage_taken: Math.floor(damage_taken) || 0,
    gc_earned: grantedGc,
    ts: now
  };

  let recentRuns = Array.isArray(player.recent_runs) ? [...player.recent_runs] : [];
  recentRuns.push(runRecord);
  if (recentRuns.length > 10) recentRuns = recentRuns.slice(-10);

  // God-mode detection: deep floors with zero damage taken, repeatedly.
  let suspCount = player.suspicious_count || 0;
  let banNow = false;
  if (runRecord.floor >= 5 && runRecord.damage_taken === 0) {
    const suspInRecent = recentRuns.filter(r => r.floor >= 5 && r.damage_taken === 0).length;
    if (suspInRecent >= 3) suspCount++;
    if (suspCount >= 5) banNow = true;
  }

  const updateData = {
    gc_extracted: (player.gc_extracted || 0) + grantedGc,
    recent_runs: recentRuns,
    suspicious_count: suspCount
  };
  if (banNow) {
    updateData.banned = true;
    updateData.banned_reason = 'god_mode_detected';
    updateData.banned_at = new Date().toISOString();
  }

  const { error: updateErr } = await supabase
    .from('players')
    .update(updateData)
    .eq('username', username);

  if (updateErr) {
    return res.status(500).json({ error: 'Update failed' });
  }

  // Log this extract for rate-limit + daily-cap accounting (non-fatal)
  try {
    await supabase.from('extract_log').insert({ username, gc_earned: grantedGc });
  } catch (e) { /* ignore logging errors */ }

  return res.status(200).json({ ok: true, gc_extracted: updateData.gc_extracted, banned: banNow, granted: grantedGc });
}
