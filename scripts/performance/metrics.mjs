import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// Real timers and I/O; only remote services are replaced with a fixed latency.
export const PROFILE = Object.freeze({ samples: 21, warmup: 2, networkMs: 60, downloadMs: 80 });
export const POLICY = Object.freeze({ maxIncreaseRatio: 0.5, minIncreaseMs: 25 });

export function summarize(samples) {
  assert.ok(samples.length > 0 && samples.every(value => Number.isFinite(value) && value >= 0), 'Invalid timing samples.');
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

export async function measure(id, run, { budgetMs, workload, setup = async () => undefined, cleanup = async () => {} }) {
  const samplesMs = [];
  let observations;
  for (let index = 0; index < PROFILE.warmup + PROFILE.samples; index++) {
    const fixture = await setup();
    try {
      const started = performance.now();
      observations = await run(fixture);
      const elapsed = performance.now() - started;
      if (index >= PROFILE.warmup) samplesMs.push(elapsed);
    } finally { await cleanup(fixture); }
  }
  return { id, ...summarize(samplesMs), samplesMs, budgetMs, workload, observations };
}

export function compare(metrics, baseline, suites) {
  assert.equal(baseline.version, 1, 'Unsupported performance baseline.');
  assert.deepEqual(baseline.profile, PROFILE, 'Performance workload changed; review and explicitly update the baseline.');
  assert.deepEqual(baseline.policy, POLICY, 'Performance regression policy changed.');
  const previous = new Map(baseline.metrics.map(metric => [metric.id, metric]));
  assert.equal(previous.size, baseline.metrics.length, 'Duplicate baseline metric.');
  assert.equal(new Set(metrics.map(metric => metric.id)).size, metrics.length, 'Duplicate performance metric.');
  const selected = id => suites.includes(id.split('.')[0]);
  for (const id of previous.keys()) if (selected(id)) assert.ok(metrics.some(metric => metric.id === id), `Missing performance scenario: ${id}`);
  return metrics.map(metric => {
    const reference = previous.get(metric.id);
    assert.ok(reference, `Missing baseline: ${metric.id}`);
    assert.deepEqual(metric.workload, reference.workload, `Workload changed: ${metric.id}`);
    const measured = summarize(metric.samplesMs);
    assert.equal(metric.samplesMs.length, PROFILE.samples, `Wrong sample count: ${metric.id}`);
    assert.deepEqual(measured, { p50Ms: metric.p50Ms, p95Ms: metric.p95Ms }, `Incorrect timing summary: ${metric.id}`);
    assert.ok(Number.isFinite(reference.p95Ms) && reference.p95Ms >= 0, `Invalid baseline: ${metric.id}`);
    const deltaMs = metric.p95Ms - reference.p95Ms;
    const toleranceMs = Math.max(reference.p95Ms * POLICY.maxIncreaseRatio, POLICY.minIncreaseMs);
    const budgetMs = Math.min(metric.budgetMs, reference.budgetMs);
    assert.ok(Number.isFinite(budgetMs) && budgetMs > 0, `Invalid budget: ${metric.id}`);
    const failed = metric.p95Ms > budgetMs || deltaMs > toleranceMs;
    return { id: metric.id, p50Ms: metric.p50Ms, p95Ms: metric.p95Ms, baselineP95Ms: reference.p95Ms,
      deltaMs, changePercent: reference.p95Ms === 0 ? null : deltaMs / reference.p95Ms * 100,
      limitMs: Math.min(budgetMs, reference.p95Ms + toleranceMs),
      status: failed ? 'regressed' : deltaMs < -toleranceMs ? 'improved' : 'passed' };
  });
}

export function assertBudgets(metrics) {
  for (const metric of metrics) {
    assert.ok(Number.isFinite(metric.budgetMs) && metric.budgetMs > 0, `Invalid budget: ${metric.id}`);
    assert.ok(metric.p95Ms <= metric.budgetMs,
      `${metric.id}: P95 ${metric.p95Ms.toFixed(2)} ms exceeds ${metric.budgetMs} ms; baseline was not updated.`);
  }
}
