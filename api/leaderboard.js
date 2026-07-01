import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('Cache-Control', 'no-store');

  const { data, error } = await supabase
    .from('players')
    .select('username, gc_extracted, runs, game_stats, banned')
    .order('gc_extracted', { ascending: false })
    .limit(100);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Accounts hidden from the public leaderboard (dev/owner/test), case-insensitive.
  const HIDDEN = ['kaynkingdom'];

  const rows = (data || [])
    .filter(p => !p.banned)              // unified ban flag
    .filter(p => !HIDDEN.includes((p.username || '').toLowerCase()))
    .slice(0, 50)
    .map((p, i) => ({
      rank: i + 1,
      username: p.username,
      gc_extracted: p.gc_extracted || 0,
      runs: p.runs || 0,
      deepest_floor: p.game_stats ? (p.game_stats.deepestFloor || 0) : 0
    }));

  return res.status(200).json({ rows });
}
