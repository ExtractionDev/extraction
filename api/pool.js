import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET — return current shared pool
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('global_pool')
      .select('pool')
      .eq('id', 1)
      .single();

    if (error || !data) {
      // Pool row doesn't exist yet — return 0
      return res.status(200).json({ pool: 0 });
    }
    return res.status(200).json({ pool: parseFloat(data.pool) || 0 });
  }

  return res.status(405).end();
}
