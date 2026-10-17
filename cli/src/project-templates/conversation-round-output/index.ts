import type { WorkflowRuntimeApi } from 'workflow-code/runtime-api';

const workflow = (globalThis as unknown as { workflow: WorkflowRuntimeApi }).workflow;
const answer = workflow.createOutputNode<{ message: string }, unknown>({
  name: 'round-answer',
  async *stream(input, context) {
    const history = await context.conversation.getValue();
    const round = history.messages.filter(message => message.role === 'assistant').length + 1;
    const text = `Round ${round}: ${input.message}`;
    yield workflow.createOutputItemChunk({ type: 'output_item_start', item: { id: 'answer', title: 'Output', contentType: 'markdown', content: '', collapsed: false } });
    yield workflow.createOutputItemChunk({ type: 'output_item_delta', itemId: 'answer', delta: text });
    yield workflow.createOutputItemChunk({ type: 'output_item_end', itemId: 'answer' });
    await context.conversation.appendMessage({ role: 'user', content: input.message });
    await context.conversation.appendMessage({ role: 'assistant', content: text });
  },
  format: stream => workflow.createOutputPayload({ items: stream.items }),
});
const conversation = workflow.defineWorkflow<{ message: string }, unknown>({
  name: 'round-conversation',
  async run(input, context) { return (await workflow.runStreamNode(answer, input, context)).output; },
});
export const executor = workflow.defineExecutor({
  projectType: 'conversation', workflow: conversation,
  createInput: context => ({ message: workflow.parseConversationDefaultInputArgs(context.args).message }),
});
