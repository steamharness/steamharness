import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE, POLICY, assertBudgets, compare } from './performance/metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const knownSuites = ['harness', 'cli', 'studio'];
const options = { suites: ['harness', 'cli'], update: false,
  baseline: path.join(root, 'scripts/performance/baseline.json'), output: path.join(root, '.release/performance') };
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--') continue;
  if (arg === '--update-baseline') { options.update = true; continue; }
  if (!['--suite', '--baseline', '--output'].includes(arg) || !process.argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${arg}`);
  const value = process.argv[++index];
  if (arg === '--suite') options.suites = value === 'all' ? knownSuites : value.split(',');
  else options[arg.slice(2)] = path.resolve(value);
}
if (!options.suites.length || options.suites.some(suite => !knownSuites.includes(suite)) || new Set(options.suites).size !== options.suites.length) throw new Error('Use --suite harness,cli,studio or --suite all.');
if (options.update && options.suites.length !== knownSuites.length) throw new Error('Update the baseline with --suite all so no scenarios disappear.');

const revision = () => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};
const workingTreeDirty = () => {
  try { return Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
  catch { return null; }
};
const report = { version: 1, recordedAt: new Date().toISOString(), revision: revision(),
  workingTreeDirty: workingTreeDirty(),
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
  profile: PROFILE, policy: POLICY, suites: options.suites, metrics: [], comparisons: [], failures: [] };
await mkdir(options.output, { recursive: true });

function runSuite(suite) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=development', path.join(root, 'scripts/performance/probe.mjs'), suite], {
      cwd: path.join(root, suite), stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL',
    });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) { reject(new Error(`${suite} performance probe failed (${signal ?? code}):\n${errors}\n${output}`)); return; }
      try {
        const metrics = JSON.parse(output);
        if (!Array.isArray(metrics) || !metrics.length || metrics.some(metric => !metric.id.startsWith(`${suite}.`))) throw new Error('Invalid probe output.');
        resolve(metrics);
      } catch (error) { reject(error); }
    });
  });
}

// Run suites sequentially so disk, event loop and compiler work cannot skew each other.
for (const suite of options.suites) {
  try { report.metrics.push(...await runSuite(suite)); }
  catch (error) { report.failures.push(error.message); }
}
try {
  if (!report.failures.length && options.update) {
    assertBudgets(report.metrics);
    const baseline = { ...report, metrics: report.metrics.map(({ samplesMs, observations, ...metric }) => metric) };
    compare(report.metrics, baseline, options.suites);
    const temporary = `${options.baseline}.tmp`;
    await writeFile(temporary, `${JSON.stringify(baseline, null, 2)}\n`);
    await rename(temporary, options.baseline);
  }
  if (!report.failures.length) {
    const baseline = JSON.parse(await readFile(options.baseline, 'utf8'));
    report.comparisons = compare(report.metrics, baseline, options.suites);
    for (const metric of report.comparisons) if (metric.status === 'regressed') report.failures.push(`${metric.id}: P95 ${metric.p95Ms.toFixed(2)} ms, baseline ${metric.baselineP95Ms.toFixed(2)} ms, limit ${metric.limitMs.toFixed(2)} ms.`);
  }
} catch (error) { report.failures.push(error.message); }

const ordered = [...report.comparisons].sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs));
const rows = ordered.map(metric => `| ${metric.id} | ${metric.p50Ms.toFixed(2)} | ${metric.p95Ms.toFixed(2)} | ${metric.baselineP95Ms.toFixed(2)} | ${metric.deltaMs.toFixed(2)} | ${metric.changePercent === null ? '-' : `${metric.changePercent.toFixed(1)}%`} | ${metric.status} |`);
const summary = ['# Performance regression report', '', `Source: ${report.revision ?? 'unknown'}${report.workingTreeDirty ? ' (working tree has changes)' : ''}; Node ${report.environment.node}; ${report.environment.platform}/${report.environment.arch}.`, '',
  'Offline wall-clock measurements with real local I/O and fixed simulated remote latency. These are not live model TTFT or desktop rendering measurements.', '',
  '| Scenario | P50 ms | P95 ms | Baseline P95 ms | Delta ms | Change | Result |', '| --- | ---: | ---: | ---: | ---: | ---: | --- |', ...rows, '',
  ...report.failures.map(failure => `- FAILED: ${failure}`), ''].join('\n');
await writeFile(path.join(options.output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(options.output, 'report.md'), summary);
const history = path.join(options.output, 'history');
await mkdir(history, { recursive: true });
await writeFile(path.join(history, `${report.recordedAt.replace(/[:.]/g, '-')}-${options.suites.join('-')}.json`), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(summary);
if (report.failures.length) process.exitCode = 1;
