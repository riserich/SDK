// Devnet quote-parity check for the v2 SDK: for each market, quote a buy/sell,
// build the SDK transaction, simulate it against the live program (nothing is
// signed or sent) and compare the realized token / cash delta to the quote,
// to the raw unit. Run: RPC=<devnet rpc url> npm run build && node tests/devnet-parity.js
const { RiseProSDK, v2 } = require('../dist/index.js');
const DEVNET_V2_PROGRAM_ID = v2.DEVNET_V2_PROGRAM_ID;
const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT } = require('@solana/spl-token');

const WALLET = new PublicKey(process.env.WALLET || '7KMCpqVch6huFr1GmEk1KY8w5htxwCuNwuX6wSQm7doQ');
const MARKETS = (process.env.MARKETS || [
  'AFAFJZx6g1m5eaK2qPYsyMwmgzN4fCQ8kYAHe4CU5qZU', // custom curve, self-healing descent tiers
  'ErvebRuhKKFpvR3AR7J1R7dzpXhEggXuHiP2JqZNZb7h', // expo preset, glide 100%
  'CzS44gQ9BHdKYhDHSuWBjPao7LMZRfswpUBcFzUPSKX9', // live ramp, capacity-clamped exits
  'EwEFqSf8PaSP2axkqtkYtSfaATQiWzpu4WT7TPazYHVH', // live ramp
  'GrP3TSCJt9fdHtM524NJtyUkzQf8y8NRUmL7qbpHdzXh', // SOL collateral
].join(',')).split(',').map((s) => new PublicKey(s.trim()));

const amountOf = (acc) => (acc ? Buffer.from(acc.data[0], 'base64').readBigUInt64LE(64) : 0n);

async function simulate(sdk, tx, addrs) {
  const sim = await sdk.connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: { encoding: 'base64', addresses: addrs.map((a) => a.toBase58()) },
  });
  const err = (sim.value.logs || []).find((l) => l.includes('Error Code'));
  return { err: sim.value.err ? err || JSON.stringify(sim.value.err) : null, accounts: sim.value.accounts || [], cu: sim.value.unitsConsumed };
}

async function balance(conn, ata) {
  const info = await conn.getAccountInfo(ata);
  return info ? info.data.readBigUInt64LE(64) : 0n;
}

async function run() {
  if (!DEVNET_V2_PROGRAM_ID) throw new Error('DEVNET_V2_PROGRAM_ID not exported');
  const sdk = new RiseProSDK({ rpcUrl: process.env.RPC, programId: DEVNET_V2_PROGRAM_ID });
  let ok = 0, bad = 0, skipped = 0;
  for (const marketAddr of MARKETS) {
    const m = await sdk.getMarket(marketAddr);
    const isSol = m.mintMainPk.equals(NATIVE_MINT);
    const tokenAta = getAssociatedTokenAddressSync(m.mintTokenPk, WALLET, true, TOKEN_2022_PROGRAM_ID);
    const cashAta = getAssociatedTokenAddressSync(m.mintMainPk, WALLET, true, TOKEN_PROGRAM_ID);
    const tokPre = await balance(sdk.connection, tokenAta);
    const cashPre = isSol ? 0n : await balance(sdk.connection, cashAta);
    const unit = 10n ** BigInt(m.tokenDecimals);
    console.log(`\n${marketAddr.toBase58().slice(0, 6)}… supply ${m.tokenSupply} ${isSol ? '(SOL)' : ''} spot ${sdk.spotPriceNumber(m).toFixed(6)}`);

    const buys = isSol ? [unit / 100n, unit / 10n] : [5n * unit, 500n * unit, 50_000n * unit];
    for (const cash of buys) {
      let q;
      try { q = sdk.quoteBuy(m, cash); } catch (e) { console.log(`  buy ${cash}: quote refused (${e.message})`); skipped++; continue; }
      const tx = await sdk.buildBuyTransaction(m, WALLET, cash, q.tokenOut);
      const s = await simulate(sdk, tx, [tokenAta]);
      if (s.err) { console.log(`  buy ${cash}: SIM FAIL ${s.err}`); bad++; continue; }
      const got = amountOf(s.accounts[0]) - tokPre;
      const match = got === q.tokenOut;
      match ? ok++ : bad++;
      console.log(`  buy  ${String(cash).padStart(14)}: quote ${q.tokenOut} | chain ${got} ${match ? '✓' : '✗ MISMATCH'}  (${s.cu} CU)`);
    }

    if (tokPre === 0n) { console.log('  sells skipped: wallet holds no tokens'); skipped++; continue; }
    for (const pct of [1n, 10n, 50n, 100n]) {
      const tin = (tokPre * pct) / 100n;
      if (tin === 0n) continue;
      let q;
      try { q = sdk.quoteSell(m, tin); } catch (e) { console.log(`  sell ${pct}%: quote refused (${e.message})`); skipped++; continue; }
      const tx = await sdk.buildSellTransaction(m, WALLET, tin, q.payout);
      if (isSol) {
        const s = await simulate(sdk, tx, []);
        s.err ? bad++ : ok++;
        console.log(`  sell ${String(pct).padStart(3)}%: ${s.err ? 'SIM FAIL ' + s.err : 'simulates OK (payout ≥ quote enforced on-chain)'} (${s.cu} CU)`);
        continue;
      }
      const s = await simulate(sdk, tx, [cashAta]);
      if (s.err) { console.log(`  sell ${pct}%: SIM FAIL ${s.err}`); bad++; continue; }
      const got = amountOf(s.accounts[0]) - cashPre;
      const match = got === q.payout;
      match ? ok++ : bad++;
      console.log(`  sell ${String(pct).padStart(3)}%: quote ${q.payout}${q.bookShortfall > 0n ? ' (clamped)' : ''} | chain ${got} ${match ? '✓' : '✗ MISMATCH'}  (${s.cu} CU)`);
    }
  }
  console.log(`\nRESULT: ${ok} exact, ${bad} failed/mismatched, ${skipped} skipped`);
  process.exit(bad ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
