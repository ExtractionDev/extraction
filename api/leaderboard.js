import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const { data, error } = await supabase
    .from('players')
    .select('username, gc_extracted, runs, game_stats')
    .order('gc_extracted', { ascending: false })
    .limit(50);

  if (error) {
    console.error('Leaderboard error:', error);
    return res.status(500).json({ error: error.message });
  }

  const rows = (data || [])
    .filter(p => !p.is_banned)
    .map((p, i) => ({
      rank: i + 1,
      username: p.username,
      gc_extracted: p.gc_extracted || 0,
      runs: p.runs || 0,
      deepest_floor: p.game_stats ? (p.game_stats.deepestFloor || 0) : 0
    }));

  return res.status(200).json({ rows });
}
