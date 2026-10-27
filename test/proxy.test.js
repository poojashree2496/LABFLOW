const test = require('node:test');
const assert = require('node:assert');
const { run, ATTEMPTS } = require('../dev/proxy');

// Each proxy attempt in a phone-app class: honest Asha attends, the trick never ends as attended.
const EXPECT = {
  photo: { meena: ['flagged', ['outside_geofence', 'stale_code']] },
  fakegps: { meena: ['flagged', ['mock_location']] },
  leftphone: { ravi: ['partial', []] },
  swap: { karthik: ['absent', []], meena: ['flagged', ['unapproved_device']] },
  walkout: { ravi: ['absent', []] },
  emulator: { meena: ['flagged', ['frozen_location']] },
  noapp: { divya: ['flagged', ['no_app']] }
};

test('proxy attempts: every trick is caught, the honest student attends', async () => {
  assert.deepStrictEqual(ATTEMPTS.map((a) => a.id), Object.keys(EXPECT));
  for (const a of ATTEMPTS) {
    const r = await run(a.id), by = Object.fromEntries(r.cast.map((c) => [c.key, c]));
    assert.strictEqual(by.asha.status, 'present', a.id + ': Asha');
    assert.ok(by.asha.checks.length >= 2 && by.asha.checks.every((x) => x === 'passed'), a.id + ': Asha passes every fingerprint check');
    for (const [k, [status, flags]] of Object.entries(EXPECT[a.id])) {
      assert.strictEqual(by[k].status, status, a.id + ': ' + k);
      assert.deepStrictEqual(by[k].flags.slice().sort(), flags, a.id + ': ' + k + ' flags');
    }
    assert.strictEqual(r.frames[r.frames.length - 1].students.length, r.cast.length);
  }
  // the phone left in the lab answers nothing: both random checks and the teacher's check are missed
  const left = (await run('leftphone')).cast.find((c) => c.key === 'ravi');
  assert.deepStrictEqual(left.checks, ['missed', 'missed', 'missed']); assert.ok(left.coverage > 90);
});
