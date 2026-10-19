import type { RuntimeApi } from 'steamharness/runtime-api';

const steamharness = (globalThis as unknown as { steamharness: RuntimeApi }).steamharness;
const answer = steamharness.createOutputNode<{ message: string }, unknown>({
  name: 'round-answer',
  async *stream(input, context) {
    const history = await context.conversation.getValue();
    const round = history.messages.filter(message => message.role === 'assistant').length + 1;
    const text = `Round ${round}: ${input.message}`;
    yield steamharness.createOutputItemChunk({ type: 'output_item_start', item: { id: 'answer', title: 'Output', contentType: 'markdown', content: '', collapsed: false } });
    yield steamharness.createOutputItemChunk({ type: 'output_item_delta', itemId: 'answer', delta: text });
    yield steamharness.createOutputItemChunk({ type: 'output_item_end', itemId: 'answer' });
    await context.conversation.appendMessage({ role: 'user', content: input.message });
    await context.conversation.appendMessage({ role: 'assistant', content: text });
  },
  format: stream => steamharness.createOutputPayload({ items: stream.items }),
});
const conversation = steamharness.defineProject<{ message: string }, unknown>({
  name: 'round-conversation',
  async run(input, context) { return (await steamharness.runStreamNode(answer, input, context)).output; },
});
export const executor = steamharness.defineExecutor({
  projectType: 'conversation', workflow: conversation,
  createInput: context => ({ message: steamharness.parseConversationDefaultInputArgs(context.args).message }),
});
