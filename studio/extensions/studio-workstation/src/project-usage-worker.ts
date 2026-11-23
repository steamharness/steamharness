import { parentPort, workerData } from 'node:worker_threads';
import { readProjectUsage, type UsageJob } from './project-usage-reader';

void readProjectUsage(workerData as UsageJob).then(result => parentPort?.postMessage(result));
