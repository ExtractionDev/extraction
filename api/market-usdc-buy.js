import { createClient } from '@supabase/supabase-js';
import { PublicKey } from '@solana/web3.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const DEV_WALLET   = 'B8ubxUGnvhDTGGRkkN8DkyAfnoLEfnjTPdXfQn3TnVQa';
const USDC_MINT    = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROG   = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOC_PROG   = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS';
const SLIPPAGE     = 0.01; // allow 1% rounding slippage on amounts

// Derive Associated Token Account address
function getATA(walletAddress, mintAddress) {
  const wallet = new PublicKey(walletAddress);
  const mint   = new PublicKey(mintAddress);
  const [ata]  = PublicKey.findProgramAddressSync(
    [wallet.toBytes(), new PublicKey(TOKEN_PROG).toBytes(), mint.toBytes()],
    new PublicKey(ASSOC_PROG)
  );
  return ata.toBase58();
}

// Fetch a parsed transaction via raw RPC with fallback across endpoints
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
    // Retry a couple times per endpoint — the tx may need a moment to propagate
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (!r.ok) break; // try next RPC
        const d = await r.json();
        if (d.error) break;
        if (d.result) return d.result; // found it
        // result is null — tx not yet visible, wait and retry same endpoint
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

    // Verify session
    const { data: player, error: playerErr } = await supabase
      .from('players')
      .select('session_token')
      .eq('username', username)
      .single();
    if (playerErr || !player) return res.status(403).json({ error: 'Player not found' });
    if (player.session_token !== token) return res.status(403).json({ error: 'Invalid session' });

    // Fetch listing
    const { data: listing, error: listErr } = await supabase
      .from('listings')
      .select('*')
      .eq('id', lid)
      .single();
    if (listErr || !listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.seller === username) return res.status(400).json({ error: 'Cannot buy your own listing' });
    if (!listing.seller_wallet) return res.status(400).json({ error: 'Listing has no seller wallet' });

    // Verify transaction on Solana (multi-RPC fallback)
    const tx = await getParsedTx(signature);
    if (!tx)          return res.status(400).json({ error: 'Transaction not found on chain yet. If USDC was deducted, contact support with your TX signature.' });
    if (tx.meta?.err) return res.status(400).json({ error: 'Transaction failed on chain' });

    // Expected amounts (USDC has 6 decimals)
    const totalUnits  = Math.round(parseFloat(listing.price) * 1e6);
    const sellerUnits = Math.round(totalUnits * 0.95);
    const devUnits    = totalUnits - sellerUnits;

    // Expected ATAs
    const sellerATA = getATA(listing.seller_wallet, USDC_MINT);
    const devATA    = getATA(DEV_WALLET, USDC_MINT);

    // Parse all SPL token transfers from the transaction
    const allIx = [
      ...(tx.transaction.message.instructions || []),
      ...((tx.meta?.innerInstructions || []).flatMap(ii => ii.instructions) || [])
    ];

    const transfers = allIx
      .filter(ix => ix.program === 'spl-token' && (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked'))
      .map(ix => ({
        to:     ix.parsed.info.destination,
        amount: parseInt(ix.parsed.info.amount ?? ix.parsed.info.tokenAmount?.amount ?? '0')
      }));

    // Check seller received 95% (within 1% slippage)
    const sellerTransfer = transfers.find(t => t.to === sellerATA);
    if (!sellerTransfer) {
      return res.status(400).json({ error: 'No transfer to seller found in transaction' });
    }
    if (sellerTransfer.amount < sellerUnits * (1 - SLIPPAGE)) {
      return res.status(400).json({ error: 'Seller received incorrect USDC amount' });
    }

    // Check dev received 5%
    const devTransfer = transfers.find(t => t.to === devATA);
    if (!devTransfer) {
      return res.status(400).json({ error: 'No marketplace fee transfer found in transaction' });
    }
    if (devTransfer.amount < devUnits * (1 - SLIPPAGE)) {
      return res.status(400).json({ error: 'Marketplace fee incorrect' });
    }

    // Transfer item to buyer — delete listing
    const { error: deleteErr } = await supabase
      .from('listings')
      .delete()
      .eq('id', lid);
    if (deleteErr) {
      console.error('Delete listing error:', deleteErr);
      return res.status(500).json({ error: 'Failed to claim item. Contact support with TX: ' + signature });
    }

    // Log the sale (non-fatal)
    try {
      await supabase.from('sales').insert({
        listing_id: lid,
        seller:     listing.seller,
        buyer:      username,
        price_usdc: listing.price,
        signature,
        item_data:  listing.item_data,
        sold_at:    new Date().toISOString()
      });
    } catch (e) { /* ignore logging errors */ }

    return res.status(200).json({ ok: true, item: listing.item_data });

  } catch (e) {
    console.error('market-usdc-buy fatal error:', e);
    return res.status(500).json({ error: 'Server error: ' + (e.message || 'unknown') });
  }
}
