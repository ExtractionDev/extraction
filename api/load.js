import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== CLIENT VERSION / FORCED UPDATE =====
// One number to bump per forced-update deploy. Must match CLIENT_BUILD in
// index.html. Served to clients via GET /api/load?version=1, and enforced on
// the paid-entry path below (stale clients get 426 and reload).
const CURRENT_BUILD = 20260701;   // <-- bump this each forced-update deploy
const CLIENT_VERSION = '0.3.1';   // display only


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
    const { username, token, entryFee, action, build } = body || {};

    if (!username || !token) {
      return res.status(400).json({ error: 'Missing username or token' });
    }

    // Verify the player's session once, up front
    const { data: player, error: pErr } = await supabase
      .from('players')
      .select('session_token, tokens, banned')
      .eq('username', username)
      .single();

    if (pErr || !player) return res.status(403).json({ error: 'Player not found' });
    if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session' });
    if (player.banned) return res.status(403).json({ error: 'Account suspended.' });

    // Lightweight gate for free-run entry: if we reach here the session is valid
    // and NOT banned (the check above already 403's banned users). No side effects.
    // Read-only free-run count for the UI label. Does NOT consume a run.
    if (action === 'freecount') {
      const FREE_MAX_DAILY = 10; // keep in sync with index.html
      const today = new Date(new Date().toISOString().slice(0,10)); // UTC date
      let used = 0;
      try {
        const { data: fr } = await supabase
          .from('players')
          .select('free_runs_used, free_runs_date')
          .eq('username', username)
          .single();
        if (fr && fr.free_runs_date) {
          const stored = new Date(fr.free_runs_date);
          // Same UTC day → count is current; otherwise it resets to 0.
          if (stored.toISOString().slice(0,10) === today.toISOString().slice(0,10)) {
            used = fr.free_runs_used || 0;
          }
        }
      } catch (e) { /* default used=0 */ }
      return res.status(200).json({ ok: true, freeRunsLeft: Math.max(0, FREE_MAX_DAILY - used) });
    }

    if (action === 'checkban') {
      // Server-authoritative free-run limit. localStorage on the client is not
      // trusted — the daily count lives here and cannot be reset by the browser.
      const FREE_MAX_DAILY = 10; // keep in sync with index.html
      const { data: usedAfter, error: frErr } = await supabase
        .rpc('consume_free_run', { p_username: username, p_max: FREE_MAX_DAILY });
      if (frErr) {
        console.error('consume_free_run failed:', frErr.message);
        return res.status(500).json({ error: 'Try again shortly.' });
      }
      if (usedAfter === -1) {
        return res.status(200).json({ ok: false, error: 'No free runs left today! Come back tomorrow or spend $EXT to enter.' });
      }
      // Optional flag-for-review backstop (does NOT ban, does NOT block play).
      // Skips anyone with a real deposited balance so paying users are never flagged.
      if (usedAfter >= FREE_MAX_DAILY && (player.tokens || 0) <= 0) {
        try {
          await supabase.from('players')
            .update({ review_flag: 'maxed free runs ' + new Date().toISOString().slice(0,10) })
            .eq('username', username);
        } catch (e) { /* non-fatal */ }
      }
      return res.status(200).json({ ok: true, freeRunsLeft: FREE_MAX_DAILY - usedAfter });
    }

    // ---------- DAILY STREAK CLAIM (24h rolling cooldown) ----------
    if (action === 'claim_streak') {
      const STREAK_REWARDS = { 1: 500, 2: 750, 3: 1000, 4: 1500, 5: 2000, 6: 3000, 7: 5000 };
      const now = Date.now();
      // Re-fetch claim fields (player above may not include them).
      let claimRow = null;
      try {
        const cr = await supabase
          .from('players')
          .select('login_streak, last_streak_claim')
          .eq('username', username)
          .single();
        claimRow = cr.data;
      } catch (e) { claimRow = null; }

      const lastClaimMs = claimRow && claimRow.last_streak_claim ? new Date(claimRow.last_streak_claim).getTime() : 0;
      const prevStreak = (claimRow && claimRow.login_streak) || 0;
      const elapsed = now - lastClaimMs;
      const DAY = 24 * 3600 * 1000;

      if (lastClaimMs && elapsed < DAY) {
        const msLeft = DAY - elapsed;
        return res.status(200).json({ ok: false, cooldown: true, msLeft,
          error: 'Already claimed. Come back later.' });
      }

      // Determine new streak day: within 48h of last claim = continue, else reset.
      let newStreak;
      if (lastClaimMs && elapsed <= 2 * DAY) {
        newStreak = prevStreak >= 7 ? 1 : prevStreak + 1;
      } else {
        newStreak = 1; // missed the window (or first ever) → restart
      }
      const reward = STREAK_REWARDS[newStreak] || 0;

      // Persist claim state first (so a failed credit can't be double-claimed).
      const { error: updErr } = await supabase.from('players').update({
        login_streak: newStreak,
        last_streak_claim: new Date(now).toISOString()
      }).eq('username', username);
      if (updErr) {
        console.error('claim_streak update failed:', updErr.message);
        return res.status(500).json({ ok: false, error: 'Could not record claim. Try again.' });
      }

      // Credit the reward.
      const { data: newBalRaw, error: creditErr } = await supabase
        .rpc('credit_tokens', { p_username: username, p_amount: reward });
      if (creditErr) {
        console.error('claim_streak credit failed:', creditErr.message);
        return res.status(500).json({ ok: false, error: 'Claim recorded but credit failed — contact support.' });
      }
      const newBalance = parseFloat(newBalRaw) || 0;
      return res.status(200).json({ ok: true, streak: newStreak, reward, newBalance, nextMs: DAY });
    }

    // ---------- JACKPOT PULL ----------
    if (action === 'jackpot') {
      // Anti-drain gate: a pull requires a paid entry that hasn't been used yet.
      // This atomically consumes one pull "ticket" (set when the entry fee was
      // paid). No ticket → no pull. Since 80% of every entry fee feeds the pool,
      // pulls are self-funding and the endpoint can't be scripted to drain it.
      const { data: eligible, error: elErr } = await supabase
        .rpc('claim_jackpot_pull', { p_username: username });
      if (elErr) return res.status(500).json({ error: 'Eligibility check failed: ' + elErr.message });
      if (!eligible) return res.status(403).json({ error: 'No jackpot pull available — enter a paid run first.' });

      // Win roll — server-side; the client cannot influence it.
      const WIN_CHANCE = (0.01 + Math.random() * 0.05);
      const won = Math.random() < WIN_CHANCE;
      if (!won) {
        return res.status(200).json({ ok: true, won: false });
      }

      // Award the pool atomically (lock + read + zero + credit in one txn).
      const { data: wonRaw, error: awardErr } = await supabase
        .rpc('award_jackpot', { p_username: username });
      if (awardErr) return res.status(500).json({ error: 'Award failed: ' + awardErr.message });

      const amount = parseFloat(wonRaw) || 0;
      const newTokens = (player.tokens || 0) + amount;

      // Log the win (non-fatal)
      if (amount > 0) {
        try {
          await supabase.from('jackpot_wins').insert({
            username, amount, won_at: new Date().toISOString()
          });
        } catch (e) { /* ignore logging errors */ }
      }

      return res.status(200).json({ ok: true, won: true, amount, newTokens });
    }

    // ---------- DUNGEON ENTRY FEE ----------
    // Forced-update gate: a stale client must not start a paid run. Reject with
    // 426 so the client reloads onto the current build.
    if (!build || build < CURRENT_BUILD) {
      return res.status(426).json({ error: 'stale_client', reload: true });
    }
    if (!entryFee) return res.status(400).json({ error: 'Missing entry fee' });
    const fee = parseFloat(entryFee);
    if (isNaN(fee) || fee <= 0) return res.status(400).json({ error: 'Invalid entry fee' });

    // ATOMIC debit — closes the concurrent double-entry / one-fee-two-runs race.
    // (The old read-check-write let two simultaneous entries both pass the balance
    // check and write the same post-fee value, so the player paid once but entered
    // twice and got two jackpot tickets.) debit_tokens subtracts only if funded.
    const { data: newBalRaw, error: debitErr } = await supabase
      .rpc('debit_tokens', { p_username: username, p_amount: fee });
    if (debitErr) {
      console.error('debit_tokens (entry fee) failed:', debitErr.message);
      return res.status(500).json({ error: 'Try again shortly.' });
    }
    if (newBalRaw == null) return res.status(400).json({ error: 'Insufficient EXT' });
    const newTokens = parseFloat(newBalRaw) || 0;

    // Record the entry fee just paid so save.js can credit the refinery payout
    // (entry fee x 1.65 max) without it being throttled, and can't be faked by
    // anyone who never paid. save.js clears last_entry_fee once it's refined.
    await supabase.from('players').update({
      last_entry_fee: fee,
      last_entry_at: new Date().toISOString(),
      jackpot_eligible_at: new Date().toISOString()  // grants ONE jackpot pull for this paid run
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
  // GET — handles: version check, blockhash proxy, pool amount, player load
  // =====================================================================

  // ---------- VERSION / FORCED-UPDATE CHECK (public, no auth) ----------
  // Client polls /api/load?version=1 to learn the current build. Bump
  // CURRENT_BUILD (top of file) on any deploy you want to force clients onto.
  if (req.query.version) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ build: CURRENT_BUILD, version: CLIENT_VERSION });
  }

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
  if (player.banned) return res.status(403).json({ error: 'Account suspended.' });

  return res.status(200).json(publicPlayer(player));
}
