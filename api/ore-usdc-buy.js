import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey } from '@solana/web3.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const DEV_WALLET = 'B8ubxUGnvhDTGGRkkN8DkyAfnoLEfnjTPdXfQn3TnVQa';
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, token, lid, signature } = req.body || {};
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

  // Fetch ore listing
  const { data: listing, error: listErr } = await supabase
    .from('ore_listings')
    .select('*')
    .eq('id', lid)
    .single();
  if (listErr || !listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.seller === username) return res.status(400).json({ error: 'Cannot buy your own listing' });
  if (!listing.seller_wallet) return res.status(400).json({ error: 'Listing has no seller wallet' });

  // Verify Solana transaction
  try {
    const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });

    if (!tx)          return res.status(400).json({ error: 'Transaction not found on chain' });
    if (tx.meta?.err) return res.status(400).json({ error: 'Transaction failed on chain' });

    // Expected USDC amounts
    const totalUsdc   = parseFloat(listing.price) * listing.qty;
    const totalUnits  = Math.round(totalUsdc * 1e6);
    const sellerUnits = Math.round(totalUnits * 0.95);
    const devUnits    = totalUnits - sellerUnits;

    const sellerATA = getATA(listing.seller_wallet, USDC_MINT);
    const devATA    = getATA(DEV_WALLET, USDC_MINT);

    // Parse SPL token transfers
    const allIx = [
      ...(tx.transaction.message.instructions || []),
      ...(tx.meta?.innerInstructions?.flatMap(ii => ii.instructions) || [])
    ];
    const transfers = allIx
      .filter(ix => ix.program === 'spl-token' && ix.parsed?.type === 'transfer')
      .map(ix => ({
        to:     ix.parsed.info.destination,
        amount: parseInt(ix.parsed.info.amount)
      }));

    const sellerTransfer = transfers.find(t => t.to === sellerATA);
    if (!sellerTransfer) return res.status(400).json({ error: 'No transfer to seller found' });
    if (sellerTransfer.amount < sellerUnits * (1 - SLIPPAGE)) {
      return res.status(400).json({ error: 'Seller received incorrect USDC amount' });
    }

    const devTransfer = transfers.find(t => t.to === devATA);
    if (!devTransfer) return res.status(400).json({ error: 'No marketplace fee transfer found' });
    if (devTransfer.amount < devUnits * (1 - SLIPPAGE)) {
      return res.status(400).json({ error: 'Marketplace fee incorrect' });
    }

  } catch (e) {
    console.error('Solana verify error:', e);
    return res.status(500).json({ error: 'Failed to verify transaction: ' + e.message });
  }

  // Delete listing
  const { error: deleteErr } = await supabase
    .from('ore_listings')
    .delete()
    .eq('id', lid);

  if (deleteErr) {
    console.error('Delete ore listing error:', deleteErr);
    return res.status(500).json({ error: 'Failed to claim ore. Contact support with TX: ' + signature });
  }

  // Log the sale
  await supabase.from('sales').insert({
    listing_id: lid,
    seller:     listing.seller,
    buyer:      username,
    price_usdc: parseFloat(listing.price) * listing.qty,
    signature,
    item_data:  { ore_name: listing.ore_name, qty: listing.qty },
    sold_at:    new Date().toISOString()
  }).catch(() => {});

  return res.status(200).json({ ok: true, ore_name: listing.ore_name, qty: listing.qty });
}
