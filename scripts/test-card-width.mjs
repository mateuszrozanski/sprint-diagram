// node scripts/test-card-width.mjs — sprawdza formułę widthForHours()

const DAY_W         = 340;
const HOURS_PER_DAY = 6;
const MIN_WIDTH     = 220;
const PX_PER_HOUR   = DAY_W / HOURS_PER_DAY; // 56.6666...
const MAX_WIDTH     = 3000;

function widthForHours(hours) {
  if (typeof hours !== 'number' || hours <= 0) return MIN_WIDTH;
  const proportional = Math.round(hours * PX_PER_HOUR);
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, proportional));
}

const cases = [
  { hours: undefined, expected: 220,  why: 'no hours → min' },
  { hours: 0,         expected: 220,  why: '0h → min' },
  { hours: 0.5,       expected: 220,  why: '0.5h: 28 → MIN 220' },
  { hours: 1,         expected: 220,  why: '1h: 57 → MIN 220' },
  { hours: 2,         expected: 220,  why: '2h: 113 → MIN 220' },
  { hours: 3,         expected: 220,  why: '3h: 170 → MIN 220' },
  { hours: 4,         expected: 227,  why: '4h: round(4 × 56.67) = 227 (67% kolumny)' },
  { hours: 5,         expected: 283,  why: '5h: 283 (83% kolumny)' },
  { hours: 6,         expected: 340,  why: '6h: 340 = DAY_W (1 kolumna)' },
  { hours: 7,         expected: 397,  why: '7h: 397 (1.17 kolumny)' },
  { hours: 8,         expected: 453,  why: '8h: 453 (1.33 kolumny)' },
  { hours: 9,         expected: 510,  why: '9h: 510 (1.5 kolumny)' },
  { hours: 11,        expected: 623,  why: '11h: 623 (1.83 kolumny)' },
  { hours: 12,        expected: 680,  why: '12h: 680 = 2 × DAY_W' },
  { hours: 13,        expected: 737,  why: '13h: 737 (2.17 kolumny)' },
  { hours: 18,        expected: 1020, why: '18h: 1020 = 3 × DAY_W' },
  { hours: 60,        expected: 3000, why: '60h: 3400 → MAX cap' },
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
