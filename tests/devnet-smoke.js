// Devnet smoke test for the v2 SDK — builds every user-facing transaction
// against live devnet markets and simulates them (sigVerify: false). Nothing
// is ever signed or sent. Run: RPC=<devnet rpc url> npm run test:devnet
//
// Expected: every line prints SUCCESS; quote values and CU figures match the
// Rise backend reference implementation bit for bit.
const { RiseProSDK, Rise } = require('../dist/index.js');
const { PublicKey, VersionedTransaction, Connection } = require('@solana/web3.js');
/* env via process.env */

async function run() {
  const rpc = process.env.RPC;
  const sdk = new RiseProSDK({ rpcUrl: rpc, programId: require('../dist/index.js').v2.DEVNET_V2_PROGRAM_ID });
  const mint = new PublicKey('GSXStgjph4V4Eg98rfygTxgPyWKP3RGYsWD9PQ6rise'); // SAHAND
  const wallet = new PublicKey('7KMCpqVch6huFr1GmEk1KY8w5htxwCuNwuX6wSQm7doQ');

  // 1. getMarket depuis le mint (dérivation PDA)
  const m = await sdk.getMarket(mint);
  console.log('getMarket ✓  address:', m.address.toBase58().slice(0, 8) + '…', ' version:', m.version, ' supply:', m.tokenSupply.toString());
  console.log('spot:', sdk.spotPriceNumber(m).toFixed(8), 'USDC/token');

  // 2. quotes
  const qb = sdk.quoteBuy(m, 10_000_000n);        // 10 USDC
  const qs = sdk.quoteSell(m, 1_000_000n);         // 1 token
  console.log('quoteBuy 10 USDC → tokenOut:', qb.tokenOut.toString());
  console.log('quoteSell 1 token → payout:', qs.payout.toString(), ' bookShortfall:', qs.bookShortfall.toString());

  // 3. positions
  const pos = await sdk.getPosition(m.address, wallet);
  console.log('getPosition ✓  collateral:', pos.collateral.toString(), ' debt:', pos.debt.toString());

  // 4. build + simulate buy et sell
  const conn = new Connection(rpc, 'confirmed');
  for (const [label, txP] of [
    ['buy 10 USDC ', sdk.buildBuyTransaction(m, wallet, 10_000_000n)],
    ['sell 1 token', sdk.buildSellTransaction(m, wallet, 1_000_000n)],
  ]) {
    const tx = await txP;
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    console.log(label, '→ sim:', sim.value.err ? 'ERR ' + JSON.stringify(sim.value.err) : 'SUCCESS', 'CU:', sim.value.unitsConsumed);
    await new Promise(r => setTimeout(r, 500));
  }

  // 5. façade : dispatch auto
  const rise = new Rise({ rpcUrl: rpc, v2ProgramId: require('../dist/index.js').v2.DEVNET_V2_PROGRAM_ID });
  const fm = await rise.getMarket(mint);
  console.log('façade getMarket ✓ version détectée:', fm.version);
}



async function run2() {
  const rpc = process.env.RPC;
  const sdk = new RiseProSDK({ rpcUrl: rpc, programId: require('../dist/index.js').v2.DEVNET_V2_PROGRAM_ID });
  const conn = new Connection(rpc, 'confirmed');
  const wallet = new PublicKey('7KMCpqVch6huFr1GmEk1KY8w5htxwCuNwuX6wSQm7doQ');
  const ricardo = await sdk.getMarket(new PublicKey('8NQCZn8Z5ZmshkHifeEWkgFLsUCBZV9G9ZzF3x648Fi'));
  const pos = await sdk.getPosition(ricardo.address, wallet);
  console.log('position ricardo: collateral', pos.collateral.toString(), 'debt', pos.debt.toString());
  const sahand = await sdk.getMarket(new PublicKey('GSXStgjph4V4Eg98rfygTxgPyWKP3RGYsWD9PQ6rise'));
  const tests = [
    ['deposit 1', sdk.buildDepositTransaction(ricardo, wallet, 1_000_000n)],
    ['withdraw 1', sdk.buildWithdrawTransaction(ricardo, wallet, 1_000_000n)],
    ['borrow 1', sdk.buildBorrowTransaction(ricardo, wallet, 1_000_000n)],
    ['repay 0.1', sdk.buildRepayTransaction(ricardo, wallet, 100_000n)],
    ['levBuy 10+18', sdk.buildLeverageBuyTransaction(ricardo, wallet, 10_000_000n, 18_000_000n)],
    ['levSell 25%', sdk.buildLeverageSellTransaction(ricardo, wallet, pos.collateral / 4n, pos.debt / 4n)],
    ['claimFees', sdk.buildClaimCreatorFeesTransaction(sahand, wallet)],
  ];
  for (const [label, p] of tests) {
    try {
      const tx = await p;
      const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      console.log(label.padEnd(14), '→', sim.value.err ? 'ERR ' + JSON.stringify(sim.value.err).slice(0, 60) : 'SUCCESS', 'CU:', sim.value.unitsConsumed);
    } catch (e) { console.log(label.padEnd(14), '→ BUILD FAIL:', e.message.slice(0, 80)); }
    await new Promise(r => setTimeout(r, 600));
  }
}run().then(run2).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
