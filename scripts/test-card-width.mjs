// node scripts/test-card-width.mjs — sprawdza formułę widthForHours()

const MIN_WIDTH     = 220;
const PX_PER_HOUR   = 60;
const MAX_WIDTH     = 3000;
const DAY_W         = 340;
const PAD           = 6;
const HOURS_PER_DAY = 6;

function spanDays(hours) {
  const halfDays = Math.max(0.5, Math.ceil((hours / HOURS_PER_DAY) * 2) / 2);
  return Math.ceil(halfDays);
}

function widthForHours(hours) {
  if (typeof hours !== 'number' || hours <= 0) return MIN_WIDTH;
  const proportional = hours * PX_PER_HOUR;
  const dayCap       = spanDays(hours) * DAY_W - 2 * PAD;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.min(proportional, dayCap)));
}

const cases = [
  { hours: undefined, expected: 220,  why: 'no hours → min' },
  { hours: 0,         expected: 220,  why: '0h → min' },
  { hours: 0.5,       expected: 220,  why: '<1h → min (1d span, 30px capped to MIN 220)' },
  { hours: 1,         expected: 220,  why: '1h: 60 < MIN → 220' },
  { hours: 2,         expected: 220,  why: '2h: 120 < MIN → 220' },
  { hours: 3,         expected: 220,  why: '3h: 180 < MIN → 220' },
  { hours: 4,         expected: 240,  why: '4h: 240 (1d cap=328)' },
  { hours: 5,         expected: 300,  why: '5h: 300 (1d cap=328)' },
  { hours: 6,         expected: 328,  why: '6h: 360 capped to 1d=328' },
  { hours: 7,         expected: 420,  why: '7h: 1.5d→2d span, prop=420 (2d cap=668)' },
  { hours: 8,         expected: 480,  why: '8h: 480 (2d cap=668)' },
  { hours: 9,         expected: 540,  why: '9h: 540 (2d cap=668)' },
  { hours: 11,        expected: 660,  why: '11h: 660 (2d cap=668)' },
  { hours: 12,        expected: 668,  why: '12h: 720 capped to 2d=668' },
  { hours: 13,        expected: 780,  why: '13h: 2.5d→3d span, prop=780 (3d cap=1008)' },
  { hours: 18,        expected: 1008, why: '18h: 1080 capped to 3d=1008' },
  { hours: 60,        expected: 3000, why: 'extreme → MAX cap' },
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
