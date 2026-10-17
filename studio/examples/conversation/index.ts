import type { WorkflowRuntimeApi } from 'workflow-code/runtime-api';

const workflow = (globalThis as unknown as { workflow: WorkflowRuntimeApi }).workflow;

const answer = workflow.createOutputNode<{ message: string }, unknown>({
  name: 'local-answer',
  async *stream(input, context) {
    const history = await context.conversation.getValue();
    const turn = history.messages.filter((message) => message.role === 'user').length + 1;
    const text = [
      `\u6536\u5230\u4e86\u4f60\u7684\u7b2c **${turn}** \u6761\u6d88\u606f\uff1a${input.message}`,
      '',
      '\u8fd9\u662f\u672c\u5730\u6f14\u793a\u7684\u56fa\u5b9a\u56de\u590d\uff0c\u672a\u8c03\u7528\u6a21\u578b\u3002',
    ].join('\n');
    yield workflow.createOutputItemChunk({ type: 'output_item_start', item: { id: 'answer', title: 'Output', content: '', contentType: 'markdown', collapsed: false } });
    for (const delta of text.match(/.{1,8}|\n/g) ?? []) {
      context.abortSignal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 60));
      yield workflow.createOutputItemChunk({ type: 'output_item_delta', itemId: 'answer', delta });
    }
    yield workflow.createOutputItemChunk({ type: 'output_item_end', itemId: 'answer' });
    await context.conversation.appendMessage({ role: 'user', content: input.message });
    await context.conversation.appendMessage({ role: 'assistant', content: text });
  },
  format(stream) { return workflow.createOutputPayload({ items: stream.items }); },
});

const conversation = workflow.defineWorkflow<{ message: string }, unknown>({
  name: 'studio-conversation',
  async run(input, context) {
    const result = await workflow.runStreamNode(answer, input, context);
    return result.output;
  },
});

export const executor = workflow.defineExecutor({
  projectType: 'conversation',
  workflow: conversation,
  createInput(context) {
    return { message: workflow.parseConversationDefaultInputArgs(context.args).message };
  },
});
