import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey } from '@solana/web3.js';

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

  // Fetch listing
  const { data: listing, error: listErr } = await supabase
    .from('listings')
    .select('*')
    .eq('id', lid)
    .single();
  if (listErr || !listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.seller === username) return res.status(400).json({ error: 'Cannot buy your own listing' });
  if (!listing.seller_wallet) return res.status(400).json({ error: 'Listing has no seller wallet' });

  // Verify transaction on Solana
  try {
    const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    const tx = await conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });

    if (!tx)           return res.status(400).json({ error: 'Transaction not found on chain' });
    if (tx.meta?.err)  return res.status(400).json({ error: 'Transaction failed on chain' });

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
      ...(tx.meta?.innerInstructions?.flatMap(ii => ii.instructions) || [])
    ];

    const transfers = allIx
      .filter(ix => ix.program === 'spl-token' && ix.parsed?.type === 'transfer')
      .map(ix => ({
        from:   ix.parsed.info.source,
        to:     ix.parsed.info.destination,
        amount: parseInt(ix.parsed.info.amount)
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

  } catch (e) {
    console.error('Solana verify error:', e);
    return res.status(500).json({ error: 'Failed to verify transaction: ' + e.message });
  }

  // Transfer item to buyer in Supabase — delete listing, give item to buyer
  const { error: deleteErr } = await supabase
    .from('listings')
    .delete()
    .eq('id', lid);

  if (deleteErr) {
    console.error('Delete listing error:', deleteErr);
    return res.status(500).json({ error: 'Failed to claim item. Contact support with TX: ' + signature });
  }

  // Log the sale
  await supabase.from('sales').insert({
    listing_id:    lid,
    seller:        listing.seller,
    buyer:         username,
    price_usdc:    listing.price,
    signature,
    item_data:     listing.item_data,
    sold_at:       new Date().toISOString()
  }).catch(() => {}); // non-fatal

  return res.status(200).json({ ok: true, item: listing.item_data });
}
