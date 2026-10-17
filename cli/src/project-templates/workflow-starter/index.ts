import type { WorkflowRuntimeApi } from 'steamharness/runtime-api';

const workflow = (globalThis as unknown as { workflow: WorkflowRuntimeApi }).workflow;
const main = workflow.defineWorkflow({
  name: 'main',
  async run() {
    return workflow.createOutputPayload({ items: [{ id: 'output', title: 'Output', contentType: 'text', content: 'Ready' }] });
  },
});
export const executor = workflow.defineExecutor({
  projectType: 'workflow', defaultEntrypoint: 'main',
  entrypoints: [workflow.defineEntrypoint({ id: 'main', title: 'Main', workflow: main, createInput: () => ({ errCode: 0, errMessage: '' }) })],
});
