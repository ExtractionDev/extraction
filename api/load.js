import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------------
// FIX C-3 (CORS): no more wildcard. Only echo the Origin header back if it is
// on an explicit allowlist. Set ALLOWED_ORIGINS in your Vercel env vars, e.g.
//   ALLOWED_ORIGINS=https://yourgame.com,https://www.yourgame.com
// (comma-separated). Falls back to same-origin only if unset.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Fields that must NEVER be returned to the client.
// session_token is a login credential — leaking it = full account takeover.
function publicPlayer(player) {
  if (!player) return player;
  const { session_token, ...safe } = player;
  return safe;
}

// Helper: fetch the current shared pool amount
async function getPoolAmount() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/global_pool?id=eq.1&select=pool`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  const rows = await r.json();
  return (rows && rows.length) ? (parseFloat(rows[0].pool) || 0) : 0;
}

// Helper: get latest Solana blockhash server-side (no CORS issues)
async function getSolanaBlockhash() {
  const rpcs = [
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana-mainnet.rpc.extrnode.com',
    'https://solana.public-rpc.com'
  ];
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'getLatestBlockhash',
    params: [{ commitment: 'confirmed' }]
  });
  for (const rpc of rpcs) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!r.ok) continue;
      const d = await r.json();
      if (d.error || !d.result) continue;
      return { blockhash: d.result.value.blockhash, rpc };
    } catch (e) {
      console.warn('Blockhash RPC failed:', rpc, e.message);
    }
  }
  return null;
}

export default async function handler(req, res) {
  applyCors(req, res);

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // =====================================================================
  // POST — handles: jackpot pull, dungeon entry fee
  // =====================================================================
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { username, token, entryFee, action } = body || {};

    if (!username || !token) {
      return res.status(400).json({ error: 'Missing username or token' });
    }

    // Verify the player's session once, up front
    const { data: player, error: pErr } = await supabase
      .from('players')
      .select('session_token, tokens')
      .eq('username', username)
      .single();

    if (pErr || !player) return res.status(403).json({ error: 'Player not found' });
    if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session' });

    // ---------- JACKPOT PULL ----------
    if (action === 'jackpot') {
      // Live odds: each pull rolls a random win chance between 1% and 6%
      const WIN_CHANCE = (0.01 + Math.random() * 0.05);

      const won = Math.random() < WIN_CHANCE;
      if (!won) {
        return res.status(200).json({ ok: true, won: false });
      }

      // Read the pool
      const wonAmount = await getPoolAmount();

      if (wonAmount <= 0) {
        // Nothing to win, but still a valid "win" with 0 payout
        return res.status(200).json({ ok: true, won: true, amount: 0, newTokens: player.tokens || 0 });
      }

      // 1) Credit the player FIRST (so a later failure can't lose the pool)
      const newBalance = (player.tokens || 0) + wonAmount;
      const { error: creditErr } = await supabase
        .from('players')
        .update({ tokens: newBalance })
        .eq('username', username);
      if (creditErr) {
        return res.status(500).json({ error: 'Credit failed: ' + creditErr.message });
      }

      // 2) Reset the pool to 0
      const { error: resetErr } = await supabase.rpc('reset_pool');
      if (resetErr) {
        // Player already paid — log but don't fail the response
        console.error('reset_pool failed (player was paid):', resetErr.message);
      }

      // 3) Log the win (non-fatal)
      try {
        await supabase.from('jackpot_wins').insert({
          username, amount: wonAmount, won_at: new Date().toISOString()
        });
      } catch (e) { /* ignore logging errors */ }

      return res.status(200).json({ ok: true, won: true, amount: wonAmount, newTokens: newBalance });
    }

    // ---------- DUNGEON ENTRY FEE ----------
    if (!entryFee) return res.status(400).json({ error: 'Missing entry fee' });
    const fee = parseFloat(entryFee);
    if (isNaN(fee) || fee <= 0) return res.status(400).json({ error: 'Invalid entry fee' });
    if ((player.tokens || 0) < fee) return res.status(400).json({ error: 'Insufficient EXT' });

    const newTokens = (player.tokens || 0) - fee;
    // Record the entry fee just paid so save.js can credit the refinery payout
    // (entry fee x 1.65 max) without it being throttled, and can't be faked by
    // anyone who never paid. save.js clears last_entry_fee once it's refined.
    await supabase.from('players').update({
      tokens: newTokens,
      last_entry_fee: fee,
      last_entry_at: new Date().toISOString()
    }).eq('username', username);

    const poolAdd = fee * 0.80;
    const removedAdd = fee * 0.20;

    const { error: poolErr } = await supabase.rpc('add_to_pool', { amount: poolAdd });
    if (poolErr) console.error('add_to_pool failed:', poolErr.message);

    const { error: removedErr } = await supabase.rpc('add_removed', { amount: removedAdd });
    if (removedErr) console.error('add_removed failed:', removedErr.message);

    return res.status(200).json({ ok: true, newTokens, pooledAdded: poolAdd, removedAdded: removedAdd });
  }

  // =====================================================================
  // GET — handles: blockhash proxy, pool amount, player load
  // =====================================================================

  // ---------- BLOCKHASH PROXY (public on-chain data, no auth needed) ----------
  if (req.query.blockhash) {
    const result = await getSolanaBlockhash();
    if (!result) return res.status(503).json({ error: 'All Solana RPC endpoints unavailable. Try again shortly.' });
    return res.status(200).json(result);
  }

  // ---------- SIGNATURE STATUS CHECK (public on-chain data) ----------
  if (req.query.sig) {
    const sig = req.query.sig;
    const rpcs = ['https://api.mainnet-beta.solana.com','https://rpc.ankr.com/solana'];
    for (const rpc of rpcs) {
      try {
        const r = await fetch(rpc, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignatureStatuses',params:[[sig],{searchTransactionHistory:true}]})
        });
        const d = await r.json();
        const status = d.result?.value?.[0];
        if (!status) { await new Promise(r=>setTimeout(r,1000)); continue; }
        return res.json({
          confirmed: status.confirmationStatus==='confirmed'||status.confirmationStatus==='finalized',
          finalized: status.confirmationStatus==='finalized',
          err: status.err||null
        });
      } catch(e) { continue; }
    }
    return res.json({ confirmed: false, finalized: false });
  }

  // ---------- ATA EXISTENCE CHECK (public on-chain data) ----------
  if (req.query.ata_exists) {
    const ata = req.query.ata_exists;
    const rpcs = ['https://api.mainnet-beta.solana.com','https://rpc.ankr.com/solana'];
    for (const rpc of rpcs) {
      try {
        const r = await fetch(rpc, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[ata,{encoding:'base64'}]})
        });
        const d = await r.json();
        if (d.error) continue;
        return res.json({ exists: d.result && d.result.value !== null });
      } catch(e) { continue; }
    }
    return res.json({ exists: false });
  }

  // ---------- GET REAL USDC TOKEN ACCOUNT ADDRESS (public on-chain data) ----------
  if (req.query.usdc_account) {
    const wallet = req.query.usdc_account;
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const rpcs = ['https://api.mainnet-beta.solana.com','https://rpc.ankr.com/solana'];
    for (const rpc of rpcs) {
      try {
        const r = await fetch(rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getTokenAccountsByOwner',
            params: [wallet, { mint: USDC_MINT }, { encoding: 'jsonParsed' }]
          })
        });
        const d = await r.json();
        if (d.error) continue;
        const accounts = d.result?.value || [];
        if (!accounts.length) return res.json({ account: null, exists: false });
        return res.json({ account: accounts[0].pubkey, exists: true });
      } catch(e) { continue; }
    }
    return res.json({ account: null, exists: false });
  }

  // ---------- USDC BALANCE CHECK (public on-chain data) ----------
  if (req.query.usdc_balance) {
    const wallet = req.query.usdc_balance;
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const rpcs = ['https://api.mainnet-beta.solana.com','https://rpc.ankr.com/solana'];
    for (const rpc of rpcs) {
      try {
        const r = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getTokenAccountsByOwner',
            params: [wallet, { mint: USDC_MINT }, { encoding: 'jsonParsed' }]
          })
        });
        const d = await r.json();
        if (d.error) continue;
        const accounts = d.result?.value || [];
        if (!accounts.length) return res.json({ balance: 0, exists: false });
        const bal = accounts[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
        return res.json({ balance: bal, exists: true });
      } catch(e) { continue; }
    }
    return res.json({ balance: 0, exists: false });
  }

  if (req.query.pool) {
    const pool = await getPoolAmount();
    return res.status(200).json({ pool });
  }

  // ---------- PLAYER LOAD ----------
  // FIX C-1 / H-2 / H-3: this used to return ANY player's full row (including
  // session_token) to ANYONE with no auth. Now it requires a valid session
  // token that matches the requested account, and strips the credential out
  // of the response.
  const { username, token } = req.query;
  if (!username || !token) {
    return res.status(400).json({ error: 'Missing username or token' });
  }

  const { data: player, error: loadErr } = await supabase
    .from('players')
    .select('*')
    .eq('username', username)
    .single();

  if (loadErr || !player) return res.status(404).json({ error: 'Player not found' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session' });

  return res.status(200).json(publicPlayer(player));
}
