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

// ── On-chain config ───────────────────────────────────────────────────────
// The wallet players send their USDC deposits TO. MUST be set correctly or
// every deposit will be rejected. Falls back to the known dev wallet, but set
// DEPOSIT_WALLET in your Vercel env and confirm it is the address you collect
// deposits at.
const DEPOSIT_WALLET = process.env.DEPOSIT_WALLET || 'B8ubxUGnvhDTGGRkkN8DkyAfnoLEfnjTPdXfQn3TnVQa';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Tolerance (USDC) for flagging a mismatch vs the claimed amount. We always
// credit the REAL on-chain amount regardless of what the client claimed.
const AMOUNT_TOLERANCE = 0.001;

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
    params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]
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

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { username, token, amount, tx_hash } = body || {};
  if (!username || !token || !amount || !tx_hash) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const claimedAmount = parseFloat(amount);
  if (isNaN(claimedAmount) || claimedAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount.' });
  }
  if (typeof tx_hash !== 'string' || !SIG.test(tx_hash)) {
    return res.status(400).json({ error: 'Invalid transaction hash.' });
  }

  // Verify session + ban status
  const { data: player, error: fetchErr } = await supabase
    .from('players')
    .select('session_token, tokens, runs, banned')
    .eq('username', username)
    .single();

  if (fetchErr || !player) return res.status(403).json({ error: 'Player not found.' });
  if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session.' });
  if (player.banned) return res.status(403).json({ error: 'Account suspended.' });

  // Reject a tx_hash that was already submitted (replay protection).
  const { data: existing } = await supabase
    .from('deposits')
    .select('id')
    .eq('tx_hash', tx_hash)
    .maybeSingle();
  if (existing) {
    return res.status(400).json({ error: 'This transaction has already been submitted.' });
  }

  // Light DB-based rate limit (one pending deposit per 30s per account).
  const since = new Date(Date.now() - 30000).toISOString();
  const { data: recent } = await supabase
    .from('deposits')
    .select('id')
    .eq('username', username)
    .gte('requested_at', since)
    .limit(1);
  if (recent && recent.length) {
    return res.status(429).json({ error: 'Please wait before submitting another deposit.' });
  }

  // ── ON-CHAIN VERIFICATION ────────────────────────────────────────────────
  // We do NOT trust the client amount. Pull the real transaction, confirm it
  // landed (no error), confirm it sent USDC to OUR deposit wallet, sum the real
  // amount transferred, and credit THAT.
  const tx = await getParsedTx(tx_hash);
  if (!tx) {
    return res.status(400).json({ error: 'Transaction not found on chain yet. Wait a few seconds and retry.' });
  }
  if (tx.meta && tx.meta.err) {
    return res.status(400).json({ error: 'Transaction failed on chain.' });
  }

  const depositATA = await getRealUsdcAccount(DEPOSIT_WALLET);
  if (!depositATA) {
    console.error('Deposit wallet has no USDC account:', DEPOSIT_WALLET);
    return res.status(500).json({ error: 'Deposit address misconfigured. Contact support.' });
  }

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
      return { to: info.destination, amount: parseInt(amt || '0') };
    })
    .filter(t => t.to === depositATA)
    .reduce((s, t) => s + t.amount, 0);

  if (receivedUnits <= 0) {
    return res.status(400).json({ error: 'No USDC payment to the deposit wallet found in this transaction.' });
  }

  // Real, verified amount in USDC (6 decimals).
  const realAmount = receivedUnits / 1e6;

  // Sanity flag only — we credit the real amount regardless.
  if (Math.abs(realAmount - claimedAmount) > AMOUNT_TOLERANCE) {
    console.warn(`Deposit amount mismatch for ${username}: claimed ${claimedAmount}, on-chain ${realAmount}`);
  }

  const { error: insertErr } = await supabase
    .from('deposits')
    .insert({
      username,
      amount: realAmount,          // VERIFIED on-chain amount — safe to credit
      tx_hash,
      tokens_balance: player.tokens || 0,
      runs: player.runs || 0,
      status: 'pending',
      requested_at: new Date().toISOString()
    });

  if (insertErr) {
    console.error('Deposit insert error:', insertErr);
    return res.status(500).json({ error: 'Failed to submit. Try again.' });
  }

  return res.status(200).json({ ok: true, amount: realAmount });
}
