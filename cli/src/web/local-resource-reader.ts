import { randomUUID } from 'node:crypto';
import { readEntrypointOutput } from 'steamharness';
import type { Project, Runtime } from './workflow-types';

import { parseWorkflowResourceReader } from './resource-reader-contract';
export type { WorkflowResourceReader } from './resource-reader-contract';

/** Reinspect on every request. Saved tool results never authorize an operation. */
export async function readLocalWorkflowResource(runtime: Runtime, owner: Project, entryId: string, value: unknown, abortSignal?: AbortSignal): Promise<unknown> {
  const reader = parseWorkflowResourceReader(value);
  abortSignal?.throwIfAborted();
  const inspected = await runtime.inspect([owner.folderPath], entryId);
  const target = inspected.projects.find(project => project.id === owner.id && project.entryId === entryId);
  if (!target || target.projectType !== 'workflow' || !target.entrypoints.some(operation => operation.id === reader.entrypointId && operation.readOnly === true)) {
    throw new Error('Resource previews require a declared read-only Workflow operation in the same project.');
  }
  const runId = randomUUID();
  const report = await runtime.run({ project: { ...target, uri: owner.uri }, runId, conversationId: runId, entrypointId: reader.entrypointId,
    args: reader.args ?? [], readOnly: true, abortSignal }, () => {});
  if (report.status !== 'success') throw new Error(report.error?.message ?? report.result?.error?.message ?? 'Resource reading failed.');
  return readEntrypointOutput(report.result?.data);
}
