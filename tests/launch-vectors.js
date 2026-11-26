// Launch-curve parity against the program's mirror vectors (risepro-program
// instructions/launch/mod.rs `launch_curve_vectors_for_the_backend_mirror`):
//
//   cargo test -p rise --lib launch_curve_vectors -- --nocapture 2>/dev/null | grep '^VEC' > tests/fixtures/launch-vectors.txt
//   npm run build && node tests/launch-vectors.js [vectors.txt]
//
// Checks the SDK's launch maths bit for bit: the pristine curve (PRICE, TFC),
// the effective curve at raised states (OVL, OPRICE, OFILL, OSELL) and fills on
// refitted curves (RPRICE, RTFC, curves taken from the REFIT lines). The refit
// solver itself (RPROB / REXP / RAMP) is not part of the SDK and is skipped.
const { readFileSync } = require('fs');
const path = require('path');
const { v2 } = require('../dist/index.js');

const file = process.argv[2] || path.join(__dirname, 'fixtures', 'launch-vectors.txt');
const SALE_CAP = 719_000_000_000_000_000n;
const RAMP_SCALAR = 2n << 64n;

let params;
let pristine;
const refitted = new Map();
const counts = {};
let ok = 0;
let bad = 0;
let skipped = 0;
const check = (kind, line, got, want) => {
  counts[kind] = counts[kind] || { ok: 0, bad: 0 };
  if (String(got) === String(want)) { ok++; counts[kind].ok++; return; }
  bad++; counts[kind].bad++;
  if (bad <= 10) console.log(`MISMATCH ${line}\n  sdk ${got}`);
};
const rampAt = (f, x1) => {
  const ch = pristine.c;
  const d = v2.deriveX2(ch, f, x1, RAMP_SCALAR);
  const x2 = d > x1 ? d : 0n;
  const mX1 = ch.price(x1);
  return { o: new v2.Overlay(ch, f, x1, RAMP_SCALAR, x2, mX1), x2, mX1, top: x2 > x1 ? x2 : x1 };
};

for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
  const [, kind, ...a] = line.trim().split(' ');
  const n = a.map((v) => (/^-?[0-9]+$/.test(v) ? BigInt(v) : 0n));
  switch (kind) {
    case 'PARAMS':
      params = n;
      pristine = new v2.LaunchCurve(params, SALE_CAP, 0n);
      check(kind, line, pristine.c.isPristine(), true);
      break;
    case 'RAISED': check(kind, line, v2.ceilQ64(pristine.c.area(SALE_CAP)), a[0]); break;
    case 'LOG2': check(kind, line, v2.log2Q64(n[0]), a[1]); break;
    case 'PRICE': check(kind, line, pristine.price(n[0]), a[1]); break;
    case 'TFC': { const f = pristine.tokensForCash(n[0], n[1]); check(kind, line, `${f.t} ${f.cost}`, `${a[2]} ${a[3]}`); break; }
    case 'OVL': { const r = rampAt(n[0], n[1]); check(kind, line, `${r.x2} ${r.mX1}`, `${a[2]} ${a[3]}`); break; }
    case 'OPRICE': { const { o } = rampAt(n[0], n[1]); check(kind, line, `${o.effPrice(n[2])} ${o.effArea(n[2])}`, `${a[3]} ${a[4]}`); break; }
    case 'OFILL': {
      const r = rampAt(n[0], n[1]);
      const f = v2.launchFillOn(r.o, pristine, r.top, n[2], n[3]);
      check(kind, line, `${f.t} ${f.cost}`, `${a[4]} ${a[5]}`);
      break;
    }
    case 'OSELL': check(kind, line, rampAt(n[0], n[1]).o.cashForTokens(n[2], n[3]), a[4]); break;
    case 'REFIT': refitted.set(`${a[0]} ${a[1]}`, new v2.LaunchCurve(n.slice(3, 7), SALE_CAP, n[1])); skipped++; break;
    case 'RPRICE': { const c = refitted.get(`${a[0]} ${a[1]}`).c; check(kind, line, `${c.price(n[2])} ${c.area(n[2])}`, `${a[3]} ${a[4]}`); break; }
    case 'RTFC': { const f = refitted.get(`${a[0]} ${a[1]}`).tokensForCash(n[2], n[3]); check(kind, line, `${f.t} ${f.cost}`, `${a[4]} ${a[5]}`); break; }
    default: skipped++;
  }
}
for (const [k, v] of Object.entries(counts)) console.log(`${k.padEnd(7)} ${v.ok} match, ${v.bad} mismatch`);
console.log(`launch vectors: ${ok} match, ${bad} mismatch, ${skipped} skipped (refit solver)`);
process.exit(bad === 0 && ok > 0 ? 0 : 1);
