// node scripts/test-card-width.mjs — sprawdza formułę widthForHours()

const MIN_WIDTH = 220;
const PX_PER_HOUR = 60;
const MAX_WIDTH = 3000;

function widthForHours(hours) {
  if (typeof hours !== 'number' || hours <= 0) return MIN_WIDTH;
  const extra = Math.max(0, hours - 1) * PX_PER_HOUR;
  return Math.min(MAX_WIDTH, Math.round(MIN_WIDTH + extra));
}

const cases = [
  { hours: undefined, expected: 220, why: 'no hours → min' },
  { hours: 0,         expected: 220, why: '0h → min' },
  { hours: 0.5,       expected: 220, why: '<1h → min (baseline)' },
  { hours: 1,         expected: 220, why: '1h = baseline (everything fits)' },
  { hours: 2,         expected: 280, why: '1h baseline + 60 = 280' },
  { hours: 3,         expected: 340, why: '+ 2*60 = 340' },
  { hours: 4,         expected: 400, why: '+ 3*60 = 400' },
  { hours: 6,         expected: 520, why: '+ 5*60 = 520' },
  { hours: 8,         expected: 640, why: '+ 7*60 = 640' },
  { hours: 12,        expected: 880, why: '+ 11*60 = 880 (~2.5d)' },
  { hours: 60,        expected: 3000,why: 'extreme → MAX cap' },
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
process.exit(fail > 0 ? 1 : 0);
