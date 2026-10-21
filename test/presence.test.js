const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../dev/presence');

test('presence demo: rescans catch the student who left and the one who faked location', () => {
  const r = run();
  const by = Object.fromEntries(r.cast.map((c) => [c.key, c]));
  assert.deepStrictEqual(r.windows.map((x) => x.kind), ['first', 'second']);
  assert.ok(r.windows[0].from > r.start + 27 * 60000 && r.windows[1].from < r.start + 115 * 60000);
  assert.strictEqual(by.asha.status, 'present'); assert.strictEqual(Math.round(by.asha.minutes), 113);
  assert.strictEqual(by.karthik.status, 'present'); assert.strictEqual(Math.round(by.karthik.minutes), 58);
  assert.strictEqual(by.divya.status, 'present'); assert.ok(by.divya.flags.includes('late'));
  for (const k of ['ravi', 'meena']) { assert.strictEqual(by[k].status, 'missed_rescan'); assert.strictEqual(by[k].minutes, 0); }
  assert.ok(r.frames.some((f) => f.result && f.result.who === 'Ravi' && f.result.code === 'OUTSIDE_GEOFENCE'));
  assert.ok(r.frames.every((f) => !f.result || f.result.ok || f.result.who === 'Ravi'));
});
