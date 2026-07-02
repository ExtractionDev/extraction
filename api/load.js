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

// ── Pet Gacha (server-authoritative; folded into load.js to avoid a new
//    serverless function). RNG, $1 USDC verification, the once-daily limit and
//    granting all happen here — the client wheel only animates the result. ────
const GACHA_USDC_MINT   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const GACHA_WALLET_ADDR = process.env.GACHA_WALLET || process.env.DEPOSIT_WALLET; // where the $1 lands
const GACHA_COST_USDC   = 1.0;
const GACHA_SLIPPAGE    = 0.02;
const GACHA_DAY_MS      = 24 * 60 * 60 * 1000;
const GACHA_SIG_RE      = /^[1-9A-HJ-NP-Za-km-z]{43,90}$/;
const GACHA_MAX_TX_AGE_SEC = 15 * 60; // freshness window for paid spins
const GACHA_VALID_ORES  = ['Coal','Copper','Iron','Silver','Gold','Mystrile'];
const GACHA_PET_PRIZES = [
  { type:'pet', key:'gnomeo',  name:'Gnomeo',      p: 1/100 },
  { type:'pet', key:'fox',     name:'Fox',         p: 1/200 },
  { type:'pet', key:'whale',   name:'Trollawhalo', p: 1/300 },
  { type:'pet', key:'sanchez', name:'Sanchez',     p: 1/400 }
];
const GACHA_ORE_TABLE = [
  { key:'Coal',     weight:26, min:10, max:20 },
  { key:'Copper',   weight:24, min:10, max:20 },
  { key:'Iron',     weight:22, min:10, max:20 },
  { key:'Silver',   weight:13, min:5,  max:10 },
  { key:'Gold',     weight:9,  min:5,  max:10 },
  { key:'Mystrile', weight:6,  min:1,  max:3  }
];
function gachaBuildDistribution() {
  const petSum = GACHA_PET_PRIZES.reduce((s, x) => s + x.p, 0);
  const oreBudget = Math.max(0, 1 - petSum);
  const wSum = GACHA_ORE_TABLE.reduce((s, o) => s + o.weight, 0);
  const dist = GACHA_PET_PRIZES.map(x => ({ ...x }));
  GACHA_ORE_TABLE.forEach(o => dist.push({ type:'ore', key:o.key, name:o.key, min:o.min, max:o.max, p: oreBudget * (o.weight / wSum) }));
  return dist;
}
function gachaRoll() {
  const dist = gachaBuildDistribution();
  const r = Math.random();
  let acc = 0;
  for (const seg of dist) {
    acc += seg.p;
    if (r < acc) {
      if (seg.type === 'ore') {
        const qty = seg.min + Math.floor(Math.random() * (seg.max - seg.min + 1));
        return { type:'ore', key: seg.key, name: seg.name, qty };
      }
      return { type:'pet', key: seg.key, name: seg.name };
    }
  }
  const last = dist[dist.length - 1];
  return { type:'ore', key: last.key, name: last.name, qty: last.min + Math.floor(Math.random() * (last.max - last.min + 1)) };
}
async function gachaGetParsedTx(signature) {
  const rpcs = [
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana-mainnet.rpc.extrnode.com',
    'https://solana.public-rpc.com'
  ];
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'getTransaction',
    params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]
  });
  for (const rpc of rpcs) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (!r.ok) { await new Promise(res => setTimeout(res, 1200)); continue; }
        const d = await r.json();
        if (d.error) break;
        if (d.result) return d.result;
        await new Promise(res => setTimeout(res, 2000));
      } catch (e) { await new Promise(res => setTimeout(res, 1200)); }
    }
  }
  return null;
}
// Whole-token USDC that landed in accounts OWNED by `wallet`. Mirrors the proven
// dual-method logic in deposit.js: (1) pre/post token-balance deltas, and
// (2) a transfer-scan fallback for non-standard/derived accounts that method 1
// can miss (this is why a single-method check was returning paid:0).
function gachaUsdcReceived(tx, wallet) {
  const pre  = (tx.meta && tx.meta.preTokenBalances)  ? tx.meta.preTokenBalances  : [];
  const post = (tx.meta && tx.meta.postTokenBalances) ? tx.meta.postTokenBalances : [];
  const accountKeys = ((tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [])
    .map(k => (typeof k === 'string' ? k : (k && k.pubkey) || ''));

  // Method 1: pre/post token-balance deltas for USDC accounts owned by `wallet`.
  const entries = list => {
    const out = {};
    (list || []).forEach(b => {
      if (!b || b.mint !== GACHA_USDC_MINT || b.owner !== wallet) return;
      const a = b.uiTokenAmount ? parseFloat(b.uiTokenAmount.uiAmountString || b.uiTokenAmount.uiAmount || 0) : 0;
      out[b.accountIndex] = isFinite(a) ? a : 0;
    });
    return out;
  };
  const preMap = entries(pre), postMap = entries(post);
  let received = 0;
  new Set([...Object.keys(preMap), ...Object.keys(postMap)]).forEach(i => {
    const d = (postMap[i] || 0) - (preMap[i] || 0);
    if (d > 0) received += d;
  });

  // Method 2 fallback: scan spl-token transfers whose destination account is
  // owned by `wallet` (via the post-balance owner map).
  if (!(received > 0)) {
    const ownerByAcct = {};
    post.forEach(b => { if (b && accountKeys[b.accountIndex]) ownerByAcct[accountKeys[b.accountIndex]] = b.owner; });
    const innerIx = (tx.meta && tx.meta.innerInstructions) ? tx.meta.innerInstructions : [];
    const allIx = [
      ...((tx.transaction && tx.transaction.message && tx.transaction.message.instructions) || []),
      ...(innerIx.flatMap(ii => ii.instructions) || [])
    ];
    allIx.forEach(ix => {
      if (!ix || ix.program !== 'spl-token' || !ix.parsed) return;
      if (ix.parsed.type !== 'transfer' && ix.parsed.type !== 'transferChecked') return;
      const info = ix.parsed.info || {};
      const dest = info.destination;
      if (ownerByAcct[dest] === wallet) {
        let amt = info.amount;
        if (amt == null && info.tokenAmount) amt = info.tokenAmount.amount;
        received += (parseInt(amt || '0', 10) / 1e6);
      }
    });
  }
  return received;
}
async function gachaSpinsInLastDay(username) {
  const since = new Date(Date.now() - GACHA_DAY_MS).toISOString();
  const { data } = await supabase
    .from('gacha_spins').select('created_at')
    .eq('username', username).gte('created_at', since)
    .order('created_at', { ascending: false }).limit(1);
  return (data && data.length) ? data[0] : null;
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
      .select('session_token, tokens, banned, last_entry_fee')
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
    // The whole cooldown check + streak update + credit now happens inside the
    // claim_streak SQL function under a row lock (SELECT ... FOR UPDATE), so two
    // concurrent claims can't both pass the cooldown and double-credit.
    if (action === 'claim_streak') {
      const { data: result, error: csErr } = await supabase
        .rpc('claim_streak', { p_username: username });
      if (csErr) {
        console.error('claim_streak rpc failed:', csErr.message);
        return res.status(500).json({ ok: false, error: 'Could not record claim. Try again.' });
      }
      if (!result || !result.ok) {
        return res.status(200).json({
          ok: false,
          cooldown: !!(result && result.cooldown),
          msLeft: result && result.ms_left,
          error: 'Already claimed. Come back later.'
        });
      }
      return res.status(200).json({
        ok: true,
        streak: result.streak,
        reward: result.reward,
        nextMs: 24 * 3600 * 1000
      });
    }

    // ---------- JACKPOT PULL ----------
    if (action === 'jackpot') {
      // Anti-drain gate: a pull requires a paid entry that hasn't been used yet.
      // This atomically consumes one pull "ticket" (set when the entry fee was
      // paid). No ticket → no pull. Since 50% of every entry fee feeds the pool,
      // pulls are self-funding and the endpoint can't be scripted to drain it.
      const { data: eligible, error: elErr } = await supabase
        .rpc('claim_jackpot_pull', { p_username: username });
      if (elErr) return res.status(500).json({ error: 'Eligibility check failed: ' + elErr.message });
      if (!eligible) return res.status(403).json({ error: 'No jackpot pull available — enter a paid run first.' });

      // Win roll — server-side; the client cannot influence it.
      const WIN_CHANCE = 0.25; // 25% jackpot payout on finding + mining Excalibur
      const won = Math.random() < WIN_CHANCE;
      if (!won) {
        return res.status(200).json({ ok: true, won: false });
      }

      // Pay out a share of the pool based on the entry fee that earned this pull
      // (server-recorded in last_entry_fee — can't be faked by the client). Flat
      // ~4–7.5% for any entry up to 20K; above 20K it scales up on a log curve to
      // ~40% at a 100K entry.
      const entryFeePaid = Math.max(1000, Math.min(100000, parseFloat(player.last_entry_fee) || 1000));
      const SCALE_START = 20000;
      const tFee = entryFeePaid <= SCALE_START ? 0
        : (Math.log10(entryFeePaid) - Math.log10(SCALE_START)) / (Math.log10(100000) - Math.log10(SCALE_START));
      const centerPct = 0.0575 + tFee * (0.40 - 0.0575);       // flat 5.75% ≤20K, then → 40% at 100K
      const pct = Math.max(0.04, Math.min(0.40, centerPct + (Math.random() - 0.5) * 0.035));

      // award_jackpot reads the pool, credits the winner, and decrements the pool
      // in ONE transaction under a row lock (SELECT ... FOR UPDATE), and clamps
      // the payout so the pool can never go negative. This closes the concurrent
      // over-drain where two winners both read the same pool and both got paid
      // while the pool was only decremented once.
      const { data: payoutRaw, error: awErr } = await supabase
        .rpc('award_jackpot', { p_username: username, p_pct: pct });
      if (awErr) return res.status(500).json({ error: 'Award failed: ' + awErr.message });
      const payout = Math.floor(parseFloat(payoutRaw) || 0);

      const amount = payout;
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

    // ---------- PET GACHA SPIN ----------
    // Session already verified above. First spin per account is FREE; every spin
    // after costs $1 USDC. No daily cooldown. RNG + granting happen here.
    if (action === 'gacha_spin') {
      if (!GACHA_WALLET_ADDR) {
        console.error('GACHA: no GACHA_WALLET / DEPOSIT_WALLET set — refusing to spin.');
        return res.status(500).json({ error: 'Gacha temporarily unavailable.' });
      }

      const freeSig = 'free:' + username;
      const { data: freeRow } = await supabase
        .from('gacha_spins').select('id').eq('signature', freeSig).maybeSingle();
      const freeAvailable = !freeRow;

      const reward = gachaRoll();

      if (freeAvailable) {
        // FREE first-ever spin — no payment. Claim the slot atomically: the unique
        // `signature` constraint guarantees exactly one free spin per account even
        // if two requests race.
        const claim = await supabase.from('gacha_spins')
          .insert({ username, signature: freeSig, reward, created_at: new Date().toISOString() });
        if (claim.error) {
          const msg = (claim.error.message || '').toLowerCase();
          if (msg.includes('duplicate') || msg.includes('unique') || String(claim.error.code) === '23505') {
            return res.status(402).json({ error: 'Free spin already used — each additional spin costs $1 USDC.', needsPayment: true });
          }
          console.error('GACHA free claim failed:', claim.error.message);
          return res.status(500).json({ error: 'Spin failed. Try again.' });
        }
      } else {
        // PAID spin — verify a $1 USDC transaction.
        const signature = body && body.signature;
        if (!signature || typeof signature !== 'string' || !GACHA_SIG_RE.test(signature)) {
          return res.status(400).json({ error: 'Invalid transaction signature.' });
        }
        const { data: usedSig } = await supabase
          .from('gacha_spins').select('id').eq('signature', signature).maybeSingle();
        if (usedSig) return res.status(400).json({ error: 'This transaction has already been used.' });

        const gtx = await gachaGetParsedTx(signature);
        if (!gtx) return res.status(400).json({ error: 'Transaction not found / not confirmed yet. Try again in a moment.' });
        if (gtx.meta && gtx.meta.err) return res.status(400).json({ error: 'Transaction failed on chain.' });

        // Freshness gate: reject payments not made recently. Combined with the
        // unique(signature) constraint this limits replay of an old $1 transfer.
        if (gtx.blockTime && (Date.now() / 1000 - gtx.blockTime) > GACHA_MAX_TX_AGE_SEC) {
          return res.status(400).json({ error: 'Payment is too old — pay and confirm, then spin promptly.' });
        }

        const paid = gachaUsdcReceived(gtx, GACHA_WALLET_ADDR);
        try {
          const _post = (gtx.meta && gtx.meta.postTokenBalances) ? gtx.meta.postTokenBalances : [];
          console.log('GACHA RAW', JSON.stringify({
            username, spinWallet: GACHA_WALLET_ADDR, paid,
            post: _post.map(b => ({ owner: b.owner, mint: b.mint, amt: b.uiTokenAmount && b.uiTokenAmount.uiAmountString }))
          }));
        } catch (e) {}
        if (!(paid >= GACHA_COST_USDC * (1 - GACHA_SLIPPAGE))) {
          console.error('GACHA underpaid:', JSON.stringify({ username, paid, signature }));
          return res.status(400).json({ error: 'Spin costs $1 USDC. Payment to the spin wallet was not found or was too small.' });
        }
      }

      // ── Grant the reward ──────────────────────────────────────────────────
      const { data: gp2 } = await supabase
        .from('players').select('ore_stash, owned_pets').eq('username', username).single();
      let newOreStash  = (gp2 && gp2.ore_stash)  || {};
      let newOwnedPets = (gp2 && gp2.owned_pets) || {};

      if (reward.type === 'ore' && GACHA_VALID_ORES.includes(reward.key)) {
        const cur = { ...((gp2 && gp2.ore_stash) || {}) };
        cur[reward.key] = Math.max(0, Math.floor(cur[reward.key] || 0)) + reward.qty;
        const { error: oErr } = await supabase.from('players').update({ ore_stash: cur }).eq('username', username);
        if (oErr) {
          console.error('GACHA ore grant failed:', oErr.message, '— manual grant needed for', username, JSON.stringify(reward));
          return res.status(500).json({ error: 'Spin succeeded but granting failed — contact support with your details.' });
        }
        newOreStash = cur;
      } else if (reward.type === 'pet') {
        const cur = { ...((gp2 && gp2.owned_pets) || {}) };
        cur[reward.key] = true;
        const { error: pgErr } = await supabase.from('players').update({ owned_pets: cur }).eq('username', username);
        if (pgErr) {
          console.error('GACHA pet grant failed:', pgErr.message, '— manual grant needed for', username, JSON.stringify(reward));
          return res.status(500).json({ error: 'Spin succeeded but granting failed — contact support with your details.' });
        }
        newOwnedPets = cur;
      }

      // For PAID spins, record the payment signature now (free was recorded above).
      if (!freeAvailable) {
        const signature = body && body.signature;
        const { error: recErr } = await supabase.from('gacha_spins')
          .insert({ username, signature, reward, created_at: new Date().toISOString() });
        if (recErr) console.error('GACHA paid record failed AFTER grant — reconcile:', recErr.message, username, signature, JSON.stringify(reward));
      }

      return res.status(200).json({ ok: true, reward, free: freeAvailable, ore_stash: newOreStash, owned_pets: newOwnedPets });
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

    // Entry split: 40% burn / 10% dev / 50% jackpot pool.
    // (Was 10/10/80 — the 80% pool recirculated to a winner with no burn, so the
    // house only permanently removed 10%. Halving the pool feed and burning the
    // difference plugs that leak: 50% of every entry is now destroyed on entry.)
    const poolAdd = fee * 0.50;    // recirculates via jackpot
    const removedAdd = fee * 0.50; // 40% burn + 10% dev — removed from player circulation

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

  // ---------- EXCALIBUR CHAMPIONS ----------
  // Global jackpot-winner podium: return the biggest recorded wins so every
  // player sees the same champions (was localStorage-only before, so a win never
  // showed for anyone but the winner's own browser).
  if (req.query.champions) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/jackpot_wins?select=username,amount,won_at&order=amount.desc&limit=20`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await r.json();
      const list = Array.isArray(rows) ? rows.map(w => ({
        name: w.username || 'Anonymous',
        amount: parseFloat(w.amount) || 0,
        ts: w.won_at ? Date.parse(w.won_at) : 0
      })) : [];
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ rows: list });
    } catch (e) {
      return res.status(200).json({ rows: [] });
    }
  }

  // ---------- PET GACHA ELIGIBILITY (auth) ----------
  // The first spin per account is FREE; every spin after costs $1 USDC. There is
  // no daily cooldown — the client uses `firstFree` to decide whether to charge.
  if (req.query.gacha_status) {
    const { username, token } = req.query;
    if (!username || !token) return res.status(400).json({ error: 'Missing credentials' });
    const { data: gp, error: gErr } = await supabase
      .from('players').select('session_token, banned').eq('username', username).single();
    if (gErr || !gp) return res.status(403).json({ error: 'Player not found' });
    if (gp.session_token !== token) return res.status(403).json({ error: 'Invalid session' });
    if (gp.banned) return res.status(403).json({ error: 'Account suspended.' });
    const { data: freeRow } = await supabase
      .from('gacha_spins').select('id').eq('signature', 'free:' + username).maybeSingle();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, firstFree: !freeRow, costUsdc: GACHA_COST_USDC });
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
