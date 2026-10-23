const task = steamharness.defineProject({
  name: 'assistant-new-tab',
  async run(input, context) {
    if (input.message === 'slow') {
      for (let index = 0; index < 1200; index++) {
        context.abortSignal.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return steamharness.createOutputPayload({ items: [{ id: 'answer', contentType: 'markdown', content: input.message }] });
  },
});
export const executor = steamharness.defineExecutor({
  projectType: 'conversation', workflow: task, conversation: { inputQueue: { enabled: true } },
  createInput(context) { return steamharness.parseConversationDefaultInputArgs(context.args); },
});
