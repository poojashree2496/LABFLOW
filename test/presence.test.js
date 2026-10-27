const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../dev/presence');

test('presence demo: rescans catch the student who left and the one who faked location', () => {
  const r = run();
  const by = Object.fromEntries(r.cast.map((c) => [c.key, c]));
  assert.deepStrictEqual(r.windows.map((x) => x.kind), ['first', 'second']);
  assert.ok(r.windows[0].from > r.start + 27 * 60000 && r.windows[1].from < r.start + 115 * 60000);
  assert.strictEqual(by.asha.status, 'present'); assert.strictEqual(Math.round(by.asha.minutes), 113);
  // attended or not: leaving at 11:00 is not attended, with no flag; arriving 20 minutes late and staying is attended
  assert.strictEqual(by.karthik.status, 'absent'); assert.strictEqual(Math.round(by.karthik.minutes), 58);
  assert.deepStrictEqual(by.karthik.flags, ['short_stay']);
  assert.strictEqual(by.divya.status, 'present'); assert.ok(by.divya.flags.includes('late'));
  assert.strictEqual(by.meena.status, 'missed_rescan'); assert.strictEqual(by.meena.minutes, 0);
  // Ravi's rescan from the canteen is recorded, not refused, but it is flagged and proves no time
  assert.strictEqual(by.ravi.status, 'flagged'); assert.strictEqual(by.ravi.minutes, 0);
  assert.ok(r.frames.some((f) => f.result && f.result.who === 'Ravi' && f.result.ok && f.result.flagged));
  assert.ok(r.frames.every((f) => !f.result || f.result.ok));
});
