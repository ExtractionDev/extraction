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

// ── $EXT on-chain SPL token ──────────────────────────────────────────────
// The pump.fun mint (contract address) for $EXT.
const EXT_MINT     = '39J4ae3kHkH3TGBANTkmKpHnPQQa61UvR2AScq5Apump';
// pump.fun mints use 6 decimals (same as USDC). Only used by the fallback
// integer-amount path below; the primary read uses uiAmountString and is
// decimals-agnostic. If you ever confirm the mint uses a different number of
// decimals, change this one value.
const EXT_DECIMALS = 6;
// Wallet that must receive the deposit. Falls back to the same DEPOSIT_WALLET
// used for USDC if you don't set a separate one. Set in Vercel env.
const DEPOSIT_WALLET = process.env.EXT_DEPOSIT_WALLET || process.env.DEPOSIT_WALLET;
// How much IN-GAME $EXT to credit per 1 ON-CHAIN $EXT deposited.
// 1 = a true 1:1 bridge (deposit 500 $EXT on chain → get 500 in-game $EXT).
// Override with EXT_CREDIT_RATE in env without editing code if you want.
const EXT_CREDIT_RATE = parseFloat(process.env.EXT_CREDIT_RATE || '1');

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
          params: [wallet, { mint: EXT_MINT }, { encoding: 'jsonParsed' }]
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

  // Verify session + ban status. `wallet` is the wallet linked to this account
  // (if any) — used below to bind the deposit to its rightful depositor.
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, tokens, banned, wallet')
    .eq('username', username)
    .single();

  if (fetchErr || !player) { console.error('DEPOSIT 403: player not found', username, fetchErr && fetchErr.message); return res.status(403).json({ error: 'Player not found.' }); }
  if (player.session_token !== token) { console.error('DEPOSIT 403: session mismatch for', username); return res.status(403).json({ error: 'Invalid session.' }); }
  if (player.banned) { console.error('DEPOSIT 403: banned', username); return res.status(403).json({ error: 'Account suspended.' }); }

  // Fast-path replay check (optimization only). The real guard is the atomic
  // credit_deposit RPC + unique(tx_hash) constraint below.
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
    extMint: EXT_MINT,
    pre: pre.map(b => ({ owner: b.owner, mint: b.mint, amt: b.uiTokenAmount && b.uiTokenAmount.uiAmountString })),
    post: post.map(b => ({ owner: b.owner, mint: b.mint, amt: b.uiTokenAmount && b.uiTokenAmount.uiAmountString }))
  }));

  // ── Identify the paying wallet (the USDC owner whose balance dropped) ─────
  // Used to bind the deposit to its depositor so a stray/other transfer into the
  // deposit wallet can't be claimed by whoever submits the signature first.
  let payer = null;
  {
    const dropByOwner = {};
    const acc = (list, sign) => (list || []).forEach(b => {
      if (!b || b.mint !== EXT_MINT || !b.owner) return;
      const a = parseFloat(b.uiTokenAmount?.uiAmountString || b.uiTokenAmount?.uiAmount || 0) || 0;
      dropByOwner[b.owner] = (dropByOwner[b.owner] || 0) + sign * a;
    });
    acc(pre, 1); acc(post, -1);   // pre minus post = amount that left each owner
    let biggest = 0;
    for (const o of Object.keys(dropByOwner)) {
      if (dropByOwner[o] > biggest) { biggest = dropByOwner[o]; payer = o; }
    }
  }
  // If the player has a linked wallet, require the deposit to come from it. If
  // players.wallet is null (not linked yet) we record the payer and proceed —
  // graceful degradation. To make binding mandatory, store a wallet on the
  // account at login/withdraw and reject here when player.wallet is missing.
  if (player.wallet && payer && player.wallet !== payer) {
    console.error('DEPOSIT 403: payer wallet mismatch', username, 'paid by', payer, 'linked', player.wallet);
    return res.status(403).json({ error: 'This deposit came from a wallet not linked to your account.' });
  }

  let extReceived = 0;
  try {
    // Method 1: pre/post token balances. Match the deposit wallet's USDC either
    // by OWNER == DEPOSIT_WALLET, or by the token-account address (accountKeys[accountIndex])
    // == the deposit wallet's ATA. We pair pre/post by accountIndex so we get the delta.
    const accountKeys = ((tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [])
      .map(k => (typeof k === 'string' ? k : (k && k.pubkey) || ''));

    function extEntries(list) {
      // Return {index -> uiAmount} for USDC entries owned by the deposit wallet.
      const out = {};
      (list || []).forEach(b => {
        if (!b || b.mint !== EXT_MINT) return;
        const ownerMatch = b.owner === DEPOSIT_WALLET;
        if (!ownerMatch) return;
        const a = b.uiTokenAmount ? parseFloat(b.uiTokenAmount.uiAmountString || b.uiTokenAmount.uiAmount || 0) : 0;
        out[b.accountIndex] = isFinite(a) ? a : 0;
      });
      return out;
    }
    const preMap = extEntries(pre);
    const postMap = extEntries(post);
    // Sum deltas across every deposit-wallet USDC account that appears.
    const idxs = new Set([...Object.keys(preMap), ...Object.keys(postMap)]);
    idxs.forEach(i => {
      const d = (postMap[i] || 0) - (preMap[i] || 0);
      if (d > 0) extReceived += d;
    });

    // Method 2 fallback: if balances showed nothing, scan parsed spl-token transfers
    // for any that credit an account owned by the deposit wallet (via post balances owner map).
    if (!(extReceived > 0)) {
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
          extReceived += (parseInt(amt || '0', 10) / Math.pow(10, EXT_DECIMALS));
        }
      });
    }

    console.log('DEPOSIT DEBUG', JSON.stringify({ username, extReceived, method: extReceived > 0 ? 'ok' : 'none' }));
  } catch (e) {
    console.error('DEPOSIT parse error:', e && e.message);
    return res.status(400).json({ error: 'Could not read the transaction. Contact support with your TX.' });
  }

  if (!(extReceived > 0)) {
    console.error('DEPOSIT REJECT: no USDC to deposit wallet found. RAW post was logged above.');
    return res.status(400).json({ error: 'No $EXT transfer to your deposit wallet was found in this transaction.' });
  }
  const extToCredit = Math.floor(extReceived * EXT_CREDIT_RATE);

  // Snapshot the balance BEFORE crediting, for the log's balance_before column.
  const balanceBefore = player.tokens || 0;

  // ── Credit + record atomically ───────────────────────────────────────────
  // credit_deposit inserts the deposit row FIRST (unique(tx_hash) makes a
  // concurrent duplicate fail) and only then credits, in one transaction. This
  // closes the old double-credit race where two requests for the same tx could
  // both pass a separate SELECT check and both credit before either inserted.
  // Returns the new balance, or NULL if this tx was already credited.
  const { data: newBalRaw, error: creditErr } = await supabase.rpc('credit_deposit', {
    p_username:       username,
    p_tx_hash:        tx_hash,
    p_amount:         extReceived,
    p_ext:            extToCredit,
    p_balance_before: balanceBefore,
    p_payer:          payer
  });
  if (creditErr) {
    console.error('credit_deposit failed:', creditErr.message,
                  '— manual credit needed for', username, 'tx', tx_hash, 'EXT', extToCredit);
    return res.status(500).json({ error: 'Deposit verified but crediting failed — contact support with your TX signature.' });
  }
  if (newBalRaw == null) {
    // Lost the race / already credited. Unique(tx_hash) guaranteed one credit.
    console.error('DEPOSIT 400: already credited (race)', tx_hash);
    return res.status(400).json({ error: 'This transaction has already been submitted.' });
  }
  const newBalance = parseFloat(newBalRaw);

  return res.status(200).json({ ok: true, deposited: extReceived, credited: extToCredit, newBalance });
}
