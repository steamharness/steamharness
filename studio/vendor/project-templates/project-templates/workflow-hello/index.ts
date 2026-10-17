import type { WorkflowRuntimeApi } from 'workflow-code/runtime-api';

const workflow = (globalThis as unknown as { workflow: WorkflowRuntimeApi }).workflow;
const answer = workflow.createOutputNode({
  name: 'hello', async *stream() { yield 'Hello'; },
  format: stream => workflow.createOutputPayload({ items: stream.items }),
});
const helloWorkflow = workflow.defineWorkflow({
  name: 'hello',
  async run(input, context) {
    return (await workflow.runStreamNode(answer, input, context)).output;
  },
});
export const executor = workflow.defineExecutor({
  projectType: 'workflow', defaultEntrypoint: 'main',
  entrypoints: [workflow.defineEntrypoint({ id: 'main', title: 'Hello', workflow: helloWorkflow, createInput: () => ({ errCode: 0, errMessage: '' }) })],
});
