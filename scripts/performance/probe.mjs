import { measure, PROFILE } from './metrics.mjs';

const suite = process.argv[2];
if (!['harness', 'cli', 'studio'].includes(suite)) throw new Error('Unknown performance suite.');
// The monorepo runner supplies instrumentation; package probes import only their own code.
const { runPerformance } = await import(`../../${suite}/scripts/performance.mjs`);
process.stdout.write(JSON.stringify(await runPerformance({ measure, PROFILE })));
