import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PROFILE, POLICY, assertBudgets, compare, measure, summarize } from '../performance/metrics.mjs';

const metric = (id, ms, budgetMs = 1000) => ({ id, ...summarize(Array(PROFILE.samples).fill(ms)), samplesMs: Array(PROFILE.samples).fill(ms), budgetMs, workload: { items: 10 } });
const baseline = metrics => ({ version: 1, profile: { ...PROFILE }, policy: { ...POLICY }, metrics });

test('P95 catches a slow tail even when the median stays fast and ignores one isolated outlier', () => {
  assert.deepEqual(summarize(Array.from({ length: 21 }, (_, index) => 21 - index)), { p50Ms: 11, p95Ms: 20 });
  assert.deepEqual(summarize([...Array(20).fill(5), 1000]), { p50Ms: 5, p95Ms: 5 });
  const samplesMs = [...Array(19).fill(5), 100, 100];
  const tail = { ...metric('harness.tail', 5), samplesMs, ...summarize(samplesMs) };
  assert.equal(tail.p50Ms, 5);
  assert.equal(compare([tail], baseline([metric('harness.tail', 5)]), ['harness'])[0].status, 'regressed');
});

test('performance gate catches large slowdowns and hard budget violations while tolerating small timing noise', () => {
  const reference = baseline([metric('harness.cold', 100), metric('harness.warm', 0.2), metric('harness.ceiling', 100, 140)]);
  const comparisons = compare([metric('harness.cold', 170), metric('harness.warm', 3), metric('harness.ceiling', 145, 140)], reference, ['harness']);
  assert.deepEqual(comparisons.map(value => value.status), ['regressed', 'passed', 'regressed']);
  assert.equal(comparisons[0].limitMs, 150);
  assert.equal(comparisons[2].limitMs, 140);
  assert.equal(compare([metric('cli.cold', 50)], baseline([metric('cli.cold', 120)]), ['cli'])[0].status, 'improved');
  assert.equal(compare([metric('cli.cold', 130)], baseline([metric('cli.cold', 100)]), ['cli'])[0].status, 'passed');
  assert.equal(compare([metric('cli.warm', 60)], baseline([metric('cli.warm', 0.2)]), ['cli'])[0].status, 'regressed');
});

test('performance gate rejects missing scenarios, changed workloads, invalid samples and duplicate metrics', () => {
  const first = metric('harness.first', 10), second = metric('cli.second', 10), reference = baseline([first, second]);
  assert.throws(() => compare([], reference, ['harness']), /Missing performance scenario/);
  assert.equal(compare([first], reference, ['harness']).length, 1, 'Partial checks retain other suites in the baseline');
  assert.throws(() => compare([{ ...first, workload: { items: 100 } }], reference, ['harness']), /Workload changed/);
  assert.throws(() => compare([first, first], reference, ['harness']), /Duplicate performance/);
  assert.throws(() => compare([first], baseline([first, first]), ['harness']), /Duplicate baseline/);
  assert.throws(() => compare([{ ...first, p95Ms: 0 }], reference, ['harness']), /Incorrect timing summary/);
  assert.throws(() => summarize([NaN]), /Invalid timing/);
  assert.throws(() => summarize([]), /Invalid timing/);
  assert.throws(() => compare([first], { ...reference, profile: { ...PROFILE, networkMs: 0 } }, ['harness']), /workload changed/);
  assert.throws(() => assertBudgets([metric('harness.slow', 200, 100)]), /baseline was not updated/);
});

test('measurement includes actual async waits, records P50/P95 and cleans up failed probes', async () => {
  let setups = 0, cleanups = 0;
  const result = await measure('harness.real-clock', async fixture => { assert.equal(fixture, 'ready'); await delay(3); return { completed: true }; }, {
    budgetMs: 1000, workload: { timerMs: 3 },
    setup: async () => { setups++; return 'ready'; }, cleanup: async () => { cleanups++; },
  });
  assert.equal(setups, PROFILE.samples + PROFILE.warmup); assert.equal(cleanups, setups);
  assert.equal(result.samplesMs.length, PROFILE.samples); assert.ok(result.p50Ms >= 2);
  assert.ok(result.p95Ms >= result.p50Ms); assert.deepEqual(result.observations, { completed: true });
  await assert.rejects(measure('harness.failed', async () => { throw new Error('Probe failed'); }, {
    budgetMs: 1000, workload: {}, cleanup: async () => { cleanups++; },
  }), /Probe failed/);
  assert.equal(cleanups, setups + 1);
});
