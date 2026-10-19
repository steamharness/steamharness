import type { RuntimeApi } from 'steamharness/runtime-api';

const steamharness = (globalThis as unknown as { steamharness: RuntimeApi }).steamharness;
const conversation = steamharness.defineProject<{ message: string }, unknown>({
  name: 'conversation',
  async run(input, context) {
    await context.conversation.appendMessage({ role: 'user', content: input.message });
    await context.conversation.appendMessage({ role: 'assistant', content: input.message });
    return steamharness.createOutputPayload({ items: [{ id: 'answer', title: 'Output', contentType: 'text', content: input.message, collapsed: false }] });
  },
});
export const executor = steamharness.defineExecutor({
  projectType: 'conversation', workflow: conversation,
  createInput: context => ({ message: steamharness.parseConversationDefaultInputArgs(context.args).message }),
});
