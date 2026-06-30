import { createClient } from '@supabase/supabase-js';
import { PublicKey } from '@solana/web3.js';

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

const DEV_WALLET = 'B8ubxUGnvhDTGGRkkN8DkyAfnoLEfnjTPdXfQn3TnVQa';
const FEE_WALLET = '72MJWgvcqEb43mbuSTiHme6oYr4rEvwc7f3kaETHdNaN';
const FEE_RATE   = 0.05; // 5% marketplace fee, taken OUT of the listing price (buyer pays price; seller nets price*(1-FEE_RATE))
const USDC_MINT  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOC_PROG = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS';
const SLIPPAGE   = 0.01;

function getATA(walletAddress, mintAddress) {
  const [ata] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(walletAddress).toBytes(),
      new PublicKey(TOKEN_PROG).toBytes(),
      new PublicKey(mintAddress).toBytes()
    ],
    new PublicKey(ASSOC_PROG)
  );
  return ata.toBase58();
}

async function getRealUsdcAccount(wallet) {
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
      if (!accounts.length) return null;
      return accounts[0].pubkey;
    } catch(e) { continue; }
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
      } catch (e) {
        console.warn('getTransaction failed:', rpc, e.message);
        break;
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { username, token, lid, signature } = body || {};
    if (!username || !token || !lid || !signature) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const { data: player, error: playerErr } = await supabase
      .from('players').select('session_token, banned').eq('username', username).single();
    if (playerErr || !player) return res.status(403).json({ error: 'Player not found' });
    if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session' });
    if (player.banned) return res.status(403).json({ error: 'Account suspended.' });

    const { data: listing, error: listErr } = await supabase
      .from('listings').select('*').eq('id', lid).single();
    if (listErr || !listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.seller === username) return res.status(400).json({ error: 'Cannot buy your own listing' });
    if (!listing.seller_wallet) return res.status(400).json({ error: 'Listing has no seller wallet' });

    // Replay protection: a given on-chain payment can only ever claim ONE item.
    const { data: usedSig } = await supabase
      .from('sales').select('id').eq('signature', signature).maybeSingle();
    if (usedSig) return res.status(400).json({ error: 'This transaction has already been used.' });

    const tx = await getParsedTx(signature);
    if (!tx) return res.status(400).json({ error: 'Transaction not found on chain yet. If USDC was deducted, contact support with your TX signature.' });
    if (tx.meta && tx.meta.err) {
      const errDetail = JSON.stringify(tx.meta.err);
      const logs = (tx.meta.logMessages || []).slice(-5).join(' | ');
      return res.status(400).json({ error: 'Transaction failed on chain: ' + errDetail, logs: logs });
    }

    const totalUnits  = Math.round(parseFloat(listing.price) * 1e6);
    // Use the REAL on-chain USDC account (derivation can mismatch non-standard accounts)
    const sellerATA = await getRealUsdcAccount(listing.seller_wallet);
    if (!sellerATA) return res.status(400).json({ error: 'Seller has no USDC account' });
    const feeATA    = await getRealUsdcAccount(FEE_WALLET);

    const innerIx = (tx.meta && tx.meta.innerInstructions) ? tx.meta.innerInstructions : [];
    const allIx = [
      ...((tx.transaction.message.instructions) || []),
      ...(innerIx.flatMap(ii => ii.instructions) || [])
    ];
    const transfers = allIx
      .filter(ix => ix.program === 'spl-token' && ix.parsed && (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferChecked'))
      .map(ix => {
        const info = ix.parsed.info;
        let amt = info.amount;
        if (amt == null && info.tokenAmount) amt = info.tokenAmount.amount;
        return { to: info.destination, amount: parseInt(amt || '0') };
      });

    const sellerReceived = transfers.filter(t => t.to === sellerATA).reduce((s, t) => s + t.amount, 0);
    const feeReceived    = feeATA ? transfers.filter(t => t.to === feeATA).reduce((s, t) => s + t.amount, 0) : 0;

    // OPTION B fee model: buyer pays exactly the listing price.
    // The fee is taken OUT of the seller's cut, so the expected split is:
    //   seller gets price * (1 - FEE_RATE)   e.g. $0.95 on a $1.00 item
    //   fee wallet gets price * FEE_RATE     e.g. $0.05
    // We verify THREE things so a buyer can't cheat either side:
    //   1. seller received at least their cut (minus slippage)
    //   2. fee wallet received at least the fee (minus slippage)
    //   3. seller + fee together cover the full price (buyer didn't underpay overall)
    const expectedSeller = Math.round(totalUnits * (1 - FEE_RATE));
    const expectedFee    = totalUnits - expectedSeller; // remainder, avoids rounding drift
    const minSeller      = Math.floor(expectedSeller * (1 - SLIPPAGE));
    const minFee         = Math.floor(expectedFee * (1 - SLIPPAGE));
    const minTotal       = Math.floor(totalUnits * (1 - SLIPPAGE));

    if (sellerReceived < minSeller) {
      return res.status(400).json({ error: 'Payment to seller incorrect. Seller got ' + sellerReceived + ', needed ' + expectedSeller });
    }
    if (feeReceived < minFee) {
      return res.status(400).json({ error: 'Marketplace fee incorrect. Fee wallet got ' + feeReceived + ', needed ' + expectedFee });
    }
    if ((sellerReceived + feeReceived) < minTotal) {
      return res.status(400).json({ error: 'Total payment incorrect. Paid ' + (sellerReceived + feeReceived) + ', needed ' + totalUnits });
    }

    const { error: deleteErr } = await supabase.from('listings').delete().eq('id', lid);
    if (deleteErr) {
      console.error('Delete listing error:', deleteErr);
      return res.status(500).json({ error: 'Failed to claim item. Contact support with TX: ' + signature });
    }

    try {
      await supabase.from('sales').insert({
        listing_id: lid, seller: listing.seller, buyer: username,
        price_usdc: listing.price, signature, item_data: listing.item_data,
        sold_at: new Date().toISOString()
      });
    } catch (e) { /* ignore */ }

    return res.status(200).json({ ok: true, item: listing.item_data });

  } catch (e) {
    console.error('market-usdc-buy fatal error:', e);
    return res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
}
