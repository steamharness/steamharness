import type { RuntimeApi } from 'steamharness/runtime-api';

const workflow = (globalThis as unknown as { workflow: RuntimeApi }).workflow;
const conversation = workflow.defineWorkflow<{ message: string }, unknown>({
  name: 'conversation',
  async run(input, context) {
    await context.conversation.appendMessage({ role: 'user', content: input.message });
    await context.conversation.appendMessage({ role: 'assistant', content: input.message });
    return workflow.createOutputPayload({ items: [{ id: 'answer', title: 'Output', contentType: 'text', content: input.message, collapsed: false }] });
  },
});
export const executor = workflow.defineExecutor({
  projectType: 'conversation', workflow: conversation,
  createInput: context => ({ message: workflow.parseConversationDefaultInputArgs(context.args).message }),
});
