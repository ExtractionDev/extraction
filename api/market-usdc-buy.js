import { createClient } from '@supabase/supabase-js';
import { PublicKey } from '@solana/web3.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const DEV_WALLET = 'B8ubxUGnvhDTGGRkkN8DkyAfnoLEfnjTPdXfQn3TnVQa';
const FEE_WALLET = '72MJWgvcqEb43mbuSTiHme6oYr4rEvwc7f3kaETHdNaN';
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { username, token, lid, signature } = body || {};
    if (!username || !token || !lid || !signature) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const { data: player, error: playerErr } = await supabase
      .from('players').select('session_token').eq('username', username).single();
    if (playerErr || !player) return res.status(403).json({ error: 'Player not found' });
    if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session' });

    const { data: listing, error: listErr } = await supabase
      .from('listings').select('*').eq('id', lid).single();
    if (listErr || !listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.seller === username) return res.status(400).json({ error: 'Cannot buy your own listing' });
    if (!listing.seller_wallet) return res.status(400).json({ error: 'Listing has no seller wallet' });

    const tx = await getParsedTx(signature);
    if (!tx) return res.status(400).json({ error: 'Transaction not found on chain yet. If USDC was deducted, contact support with your TX signature.' });
    if (tx.meta && tx.meta.err) {
      const errDetail = JSON.stringify(tx.meta.err);
      const logs = (tx.meta.logMessages || []).slice(-5).join(' | ');
      return res.status(400).json({ error: 'Transaction failed on chain: ' + errDetail, logs: logs });
    }

    const totalUnits  = Math.round(parseFloat(listing.price) * 1e6);
    const sellerATA = getATA(listing.seller_wallet, USDC_MINT);
    const feeATA    = getATA(FEE_WALLET, USDC_MINT);

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
    const feeReceived    = transfers.filter(t => t.to === feeATA).reduce((s, t) => s + t.amount, 0);

    // Seller + fee together must cover the full price (within slippage)
    if ((sellerReceived + feeReceived) < totalUnits * (1 - SLIPPAGE)) {
      return res.status(400).json({ error: 'Payment incorrect. Seller got ' + sellerReceived + ', fee got ' + feeReceived + ', needed ' + totalUnits });
    }
    if (sellerReceived <= 0) {
      return res.status(400).json({ error: 'No transfer to seller found in transaction' });
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
