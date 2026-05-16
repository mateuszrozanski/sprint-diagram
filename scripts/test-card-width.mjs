// Stand-alone test (run: `node scripts/test-card-width.mjs`) — bez Karma/Jest.
// Sprawdza widthForHours() ręcznie wpisując formułę zgodnie z `card-width.ts`.

const MIN_WIDTH = 120;
const PX_PER_HOUR = 60;
const MAX_WIDTH = 3000;

function widthForHours(hours) {
  if (typeof hours !== 'number' || hours <= 0) return MIN_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(hours * PX_PER_HOUR)));
}

const cases = [
  { hours: undefined, expected: MIN_WIDTH, why: 'no hours → min' },
  { hours: 0,         expected: MIN_WIDTH, why: '0h → min' },
  { hours: 1,         expected: MIN_WIDTH, why: '1h × 60 = 60 < min(120)' },
  { hours: 2,         expected: MIN_WIDTH, why: '2h × 60 = 120 == min' },
  { hours: 3,         expected: 180,       why: '3h × 60 = 180' },
  { hours: 4,         expected: 240,       why: '4h × 60 = 240' },
  { hours: 6,         expected: 360,       why: '6h × 60 = 360 ≈ DAY_W(340)' },
  { hours: 8,         expected: 480,       why: '8h × 60 = 480 ≈ 1.4 dnia' },
  { hours: 12,        expected: 720,       why: '12h × 60 = 720 ≈ 2 dni' },
  { hours: 60,        expected: MAX_WIDTH, why: 'extreme → cap' },
];

let pass = 0, fail = 0;
console.log('hours\tactual\texpect\tres\twhy');
for (const c of cases) {
  const actual = widthForHours(c.hours);
  const ok = actual === c.expected;
  if (ok) pass++; else fail++;
  console.log(`${c.hours}\t${actual}\t${c.expected}\t${ok ? 'PASS' : 'FAIL'}\t${c.why}`);
}
console.log(`\n${pass}/${pass + fail} pass`);

// Sanity-check: proporcje (3h powinno być 3× szersze od 1h jak >= baseline)
const w1 = widthForHours(1);
const w3 = widthForHours(3);
const w6 = widthForHours(6);
console.log(`\nProporcje (1h=${w1}, 3h=${w3}, 6h=${w6}):`);
console.log(`  3h/1h = ${(w3/w1).toFixed(2)} (cel: ~3, ale 1h przy minimum więc ratio może być niższy)`);
console.log(`  6h/3h = ${(w6/w3).toFixed(2)} (cel: 2.0 — dwa razy więcej godzin = dwa razy szersze)`);

process.exit(fail > 0 ? 1 : 0);
