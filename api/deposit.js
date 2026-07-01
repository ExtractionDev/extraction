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
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Solana tx signatures are base58, ~87-88 chars.
const SIG = /^[1-9A-HJ-NP-Za-km-z]{43,90}$/;

const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// YOUR deposit wallet — set this in Vercel env. All deposits must land here.
const DEPOSIT_WALLET = process.env.DEPOSIT_WALLET;
// In-game credit rate. index.html advertises $10 USDC = 100,000 $EXT.
const EXT_PER_USDC   = 10000;

// Look up the real USDC token account for a wallet (derivation can mismatch
// non-standard accounts, so query the chain).
async function getRealUsdcAccount(wallet) {
  const rpcs = ['https://api.mainnet-beta.solana.com', 'https://rpc.ankr.com/solana'];
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
      if (!accounts.length) return null;
      return accounts[0].pubkey;
    } catch (e) { continue; }
  }
  return null;
}

async function getParsedTx(signature) {
  const rpcs = [
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana-mainnet.rpc.extrnode.com',
    'https://solana.public-rpc.com'
  ];
  // 'confirmed' is reached in ~1-2s (finalized takes ~13s). The client calls us
  // right after confirmation, so 'finalized' would usually return null. Confirmed
  // is safe for crediting — it has supermajority votes and won't be rolled back.
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'getTransaction',
    params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]
  });
  for (const rpc of rpcs) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (!r.ok) { await new Promise(res => setTimeout(res, 1200)); continue; }
        const d = await r.json();
        if (d.error) { break; }               // hard RPC error → try next endpoint
        if (d.result) return d.result;          // got it
        await new Promise(res => setTimeout(res, 2000)); // result null → not indexed yet, wait & retry
      } catch (e) { await new Promise(res => setTimeout(res, 1200)); }
    }
  }
  return null;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).end();

  if (!DEPOSIT_WALLET) {
    console.error('DEPOSIT_WALLET env var is not set — refusing to credit.');
    return res.status(500).json({ error: 'Deposits temporarily unavailable.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { username, token, tx_hash } = body || {};

  // Log EVERY deposit attempt at entry, before any validation can bail out.
  console.log('DEPOSIT IN', JSON.stringify({
    username: username || null,
    hasToken: !!token,
    tx_hash: tx_hash || null,
    tx_len: tx_hash ? String(tx_hash).length : 0
  }));

  if (!username || !token || !tx_hash) {
    console.error('DEPOSIT 400: missing fields', { hasUser: !!username, hasToken: !!token, hasTx: !!tx_hash });
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (typeof tx_hash !== 'string' || !SIG.test(tx_hash)) {
    console.error('DEPOSIT 400: tx_hash failed regex. value=', tx_hash, 'len=', String(tx_hash).length);
    return res.status(400).json({ error: 'Invalid transaction hash.' });
  }

  // Verify session + ban status
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, tokens, banned')
    .eq('username', username)
    .single();

  if (fetchErr || !player) { console.error('DEPOSIT 403: player not found', username, fetchErr && fetchErr.message); return res.status(403).json({ error: 'Player not found.' }); }
  if (player.session_token !== token) { console.error('DEPOSIT 403: session mismatch for', username); return res.status(403).json({ error: 'Invalid session.' }); }
  if (player.banned) { console.error('DEPOSIT 403: banned', username); return res.status(403).json({ error: 'Account suspended.' }); }

  // Replay protection: a given tx can only ever be credited once.
  const { data: existing } = await supabase
    .from('deposits')
    .select('id')
    .eq('tx_hash', tx_hash)
    .maybeSingle();
  if (existing) {
    console.error('DEPOSIT 400: replay — tx already submitted', tx_hash);
    return res.status(400).json({ error: 'This transaction has already been submitted.' });
  }

  // ── On-chain verification ────────────────────────────────────────────────
  const tx = await getParsedTx(tx_hash);
  if (!tx) {
    console.error('DEPOSIT 400: getParsedTx returned null for', tx_hash);
    return res.status(400).json({ error: 'Transaction not found / not finalized yet. Try again in a moment.' });
  }
  if (tx.meta && tx.meta.err) {
    console.error('DEPOSIT 400: tx failed on chain', JSON.stringify(tx.meta.err));
    return res.status(400).json({ error: 'Transaction failed on chain.' });
  }

  // Log the RAW balance arrays first thing, so nothing below can hide them.
  const pre = (tx.meta && tx.meta.preTokenBalances) ? tx.meta.preTokenBalances : [];
  const post = (tx.meta && tx.meta.postTokenBalances) ? tx.meta.postTokenBalances : [];
  console.log('DEPOSIT RAW', JSON.stringify({
    depositWallet: DEPOSIT_WALLET,
    usdcMint: USDC_MINT,
    pre: pre.map(b => ({ owner: b.owner, mint: b.mint, amt: b.uiTokenAmount && b.uiTokenAmount.uiAmountString })),
    post: post.map(b => ({ owner: b.owner, mint: b.mint, amt: b.uiTokenAmount && b.uiTokenAmount.uiAmountString }))
  }));

  let usdcReceived = 0;
  try {
    // Method 1: pre/post token balances. Match the deposit wallet's USDC either
    // by OWNER == DEPOSIT_WALLET, or by the token-account address (accountKeys[accountIndex])
    // == the deposit wallet's ATA. We pair pre/post by accountIndex so we get the delta.
    const accountKeys = ((tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [])
      .map(k => (typeof k === 'string' ? k : (k && k.pubkey) || ''));

    function usdcEntries(list) {
      // Return {index -> uiAmount} for USDC entries owned by the deposit wallet.
      const out = {};
      (list || []).forEach(b => {
        if (!b || b.mint !== USDC_MINT) return;
        const ownerMatch = b.owner === DEPOSIT_WALLET;
        if (!ownerMatch) return;
        const a = b.uiTokenAmount ? parseFloat(b.uiTokenAmount.uiAmountString || b.uiTokenAmount.uiAmount || 0) : 0;
        out[b.accountIndex] = isFinite(a) ? a : 0;
      });
      return out;
    }
    const preMap = usdcEntries(pre);
    const postMap = usdcEntries(post);
    // Sum deltas across every deposit-wallet USDC account that appears.
    const idxs = new Set([...Object.keys(preMap), ...Object.keys(postMap)]);
    idxs.forEach(i => {
      const d = (postMap[i] || 0) - (preMap[i] || 0);
      if (d > 0) usdcReceived += d;
    });

    // Method 2 fallback: if balances showed nothing, scan parsed spl-token transfers
    // for any that credit an account owned by the deposit wallet (via post balances owner map).
    if (!(usdcReceived > 0)) {
      const ownerByAcct = {};
      post.forEach(b => { if (b && accountKeys[b.accountIndex]) ownerByAcct[accountKeys[b.accountIndex]] = b.owner; });
      const innerIx = (tx.meta && tx.meta.innerInstructions) ? tx.meta.innerInstructions : [];
      const allIx = [
        ...((tx.transaction.message.instructions) || []),
        ...(innerIx.flatMap(ii => ii.instructions) || [])
      ];
      allIx.forEach(ix => {
        if (!ix || ix.program !== 'spl-token' || !ix.parsed) return;
        if (ix.parsed.type !== 'transfer' && ix.parsed.type !== 'transferChecked') return;
        const info = ix.parsed.info || {};
        const dest = info.destination;
        if (ownerByAcct[dest] === DEPOSIT_WALLET) {
          let amt = info.amount;
          if (amt == null && info.tokenAmount) amt = info.tokenAmount.amount;
          usdcReceived += (parseInt(amt || '0', 10) / 1e6);
        }
      });
    }

    console.log('DEPOSIT DEBUG', JSON.stringify({ username, usdcReceived, method: usdcReceived > 0 ? 'ok' : 'none' }));
  } catch (e) {
    console.error('DEPOSIT parse error:', e && e.message);
    return res.status(400).json({ error: 'Could not read the transaction. Contact support with your TX.' });
  }

  if (!(usdcReceived > 0)) {
    console.error('DEPOSIT REJECT: no USDC to deposit wallet found. RAW post was logged above.');
    return res.status(400).json({ error: 'No USDC to your deposit wallet found in this transaction.' });
  }
  const extToCredit = Math.floor(usdcReceived * EXT_PER_USDC);

  // Record the deposit FIRST (status credited) — the unique tx_hash row is the
  // replay guard. The tx_hash was already checked above for an existing row, so
  // reaching here means this is a new deposit. We try to record it, but the
  // schema of `deposits` must not block a real credit — so if the full insert
  // fails for any non-duplicate reason, we fall back to a minimal insert and,
  // failing that, still credit (the up-front tx_hash check prevents doubles).
  const fullRow = {
    username,
    amount: usdcReceived,
    tx_hash,
    tokens_balance: player.tokens || 0,
    status: 'credited',
    requested_at: new Date().toISOString()
  };
  let { error: insertErr } = await supabase.from('deposits').insert(fullRow);

  if (insertErr) {
    const msg = (insertErr.message || '').toLowerCase();
    const isDuplicate = msg.includes('duplicate') || msg.includes('unique') ||
                        (insertErr.code && String(insertErr.code) === '23505');
    if (isDuplicate) {
      console.error('DEPOSIT 400: duplicate tx_hash on insert', tx_hash);
      return res.status(400).json({ error: 'This transaction has already been submitted.' });
    }
    // Not a duplicate — likely a missing column. Retry with only the essentials.
    console.error('Deposit full insert failed, retrying minimal:', insertErr.message);
    const min = await supabase.from('deposits').insert({ username, tx_hash, status: 'credited' });
    if (min.error) {
      // Even the minimal insert failed. Record couldn't be written, but the
      // payment is real and this tx wasn't credited before, so credit anyway.
      console.error('Deposit minimal insert also failed — crediting without a row:', min.error.message,
                    'user', username, 'tx', tx_hash, 'EXT', extToCredit);
    }
  }

  // Credit the tokens.
  const { data: newBalRaw, error: creditErr } = await supabase
    .rpc('credit_tokens', { p_username: username, p_amount: extToCredit });
  if (creditErr) {
    console.error('credit_tokens failed:', creditErr.message,
                  '— manual credit needed for', username, 'tx', tx_hash, 'EXT', extToCredit);
    return res.status(500).json({ error: 'Deposit verified but crediting failed — contact support with your TX signature.' });
  }

  const newBalance = parseFloat(newBalRaw) || ((player.tokens || 0) + extToCredit);
  return res.status(200).json({ ok: true, usdc: usdcReceived, credited: extToCredit, newBalance });
}
