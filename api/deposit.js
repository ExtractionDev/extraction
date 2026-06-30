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
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'getTransaction',
    params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }]
  });
  for (const rpc of rpcs) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (!r.ok) break;
        const d = await r.json();
        if (d.error) break;
        if (d.result) return d.result;
        await new Promise(res => setTimeout(res, 1500));
      } catch (e) { break; }
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
  // NOTE: client-sent `amount` is intentionally IGNORED. We credit the real
  // on-chain amount only. It's accepted for backward compatibility / display.
  const { username, token, tx_hash } = body || {};
  if (!username || !token || !tx_hash) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (typeof tx_hash !== 'string' || !SIG.test(tx_hash)) {
    return res.status(400).json({ error: 'Invalid transaction hash.' });
  }

  // Verify session + ban status
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, tokens, banned')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found.' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session.' });
  if (player.banned) return res.status(403).json({ error: 'Account suspended.' });

  // Replay protection: a given tx can only ever be credited once.
  const { data: existing } = await supabase
    .from('deposits')
    .select('id')
    .eq('tx_hash', tx_hash)
    .maybeSingle();
  if (existing) {
    return res.status(400).json({ error: 'This transaction has already been submitted.' });
  }

  // ── On-chain verification ────────────────────────────────────────────────
  const depositATA = await getRealUsdcAccount(DEPOSIT_WALLET);
  if (!depositATA) {
    console.error('Deposit wallet has no USDC account on chain.');
    return res.status(500).json({ error: 'Deposits temporarily unavailable.' });
  }

  const tx = await getParsedTx(tx_hash);
  if (!tx) {
    return res.status(400).json({ error: 'Transaction not found / not finalized yet. Try again in a moment.' });
  }
  if (tx.meta && tx.meta.err) {
    return res.status(400).json({ error: 'Transaction failed on chain.' });
  }

  // Sum every USDC transfer whose destination is OUR deposit USDC account.
  const innerIx = (tx.meta && tx.meta.innerInstructions) ? tx.meta.innerInstructions : [];
  const allIx = [
    ...((tx.transaction.message.instructions) || []),
    ...(innerIx.flatMap(ii => ii.instructions) || [])
  ];
  const receivedUnits = allIx
    .filter(ix => ix.program === 'spl-token' && ix.parsed &&
                  (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferChecked'))
    .map(ix => {
      const info = ix.parsed.info;
      let amt = info.amount;
      if (amt == null && info.tokenAmount) amt = info.tokenAmount.amount;
      return { to: info.destination, amount: parseInt(amt || '0', 10) };
    })
    .filter(t => t.to === depositATA)
    .reduce((s, t) => s + t.amount, 0);

  // USDC has 6 decimals. Convert base units → USDC → $EXT.
  const usdcReceived = receivedUnits / 1e6;
  if (!(usdcReceived > 0)) {
    return res.status(400).json({ error: 'No USDC to your deposit wallet found in this transaction.' });
  }
  const extToCredit = Math.floor(usdcReceived * EXT_PER_USDC);

  // Record the deposit FIRST (status credited) — the unique tx_hash row is the
  // replay guard. If the insert races and fails on the unique constraint, we
  // must NOT credit.
  const { error: insertErr } = await supabase
    .from('deposits')
    .insert({
      username,
      amount: usdcReceived,      // REAL on-chain USDC, not the client's claim
      ext_credited: extToCredit,
      tx_hash,
      tokens_balance: player.tokens || 0,
      status: 'credited',
      requested_at: new Date().toISOString()
    });

  if (insertErr) {
    // Likely the unique tx_hash constraint firing on a concurrent submit.
    console.error('Deposit insert error (NOT crediting):', insertErr.message);
    return res.status(400).json({ error: 'This transaction has already been submitted.' });
  }

  // Credit atomically only after the replay row is safely recorded.
  const { data: newBalRaw, error: creditErr } = await supabase
    .rpc('credit_tokens', { p_username: username, p_amount: extToCredit });
  if (creditErr) {
    console.error('credit_tokens failed AFTER recording deposit:', creditErr.message,
                  '— manual credit needed for', username, 'tx', tx_hash, 'EXT', extToCredit);
    return res.status(500).json({ error: 'Deposit recorded but crediting failed — contact support with your TX signature.' });
  }

  const newBalance = parseFloat(newBalRaw) || ((player.tokens || 0) + extToCredit);
  return res.status(200).json({ ok: true, usdc: usdcReceived, credited: extToCredit, newBalance });
}
