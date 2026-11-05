import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.resolve('steamharness'));
const ai = await import(pathToFileURL(require.resolve('@earendil-works/pi-ai')).href);
const provider = ai.fauxProvider({ models: [{ id: 'fixture', name: 'Fixture', contextWindow: 8192, maxTokens: 2048 }] });
const models = ai.createModels(); models.setProvider(provider.provider);

const steamharness = globalThis.steamharness;
const question = steamharness.createUserInputNode({
  name: 'question-form', title: 'Two questions', params: [
    { name: 'choice', type: 'string', required: true, control: 'radio', step: 1, label: 'Choose a format', options: [{ value: 'brief', label: 'Brief' }, { value: 'full', label: 'Full' }] },
    { name: 'notes', type: 'string', required: true, control: 'textarea', step: 2, label: 'Notes' },
  ],
});
provider.setResponses(Array.from({ length: 128 }, () => request => {
  const user = request.messages.findLastIndex(message => message.role === 'user');
  const text = typeof request.messages[user]?.content === 'string' ? request.messages[user].content
    : request.messages[user]?.content.filter(part => part.type === 'text').map(part => part.text).join('') ?? '';
  const tool = request.messages.slice(user + 1).find(message => message.role === 'toolResult');
  if (text.startsWith('activity') && !tool) return ai.fauxAssistantMessage([
    ai.fauxText('我先检查当前项目。'), ai.fauxToolCall(text.startsWith('activity-wait') ? 'fixture_write' : 'fixture_read', { message: text }),
  ], { stopReason: 'toolUse' });
  if (tool) return ai.fauxAssistantMessage('Approved tool executed\n\n已查看当前项目。Bot 通过 `defineBot` 注册，执行过程由 Core 提供。');
  if (text.startsWith('plan')) return ai.fauxAssistantMessage('1. Inspect project\n2. Apply the change');
  return ai.fauxAssistantMessage(text || 'Ready');
}));
export const executor = steamharness.defineBot({
  name: 'conversation-features',
  agent: { models, resolvedModel: models.getModel('faux', 'fixture'), tools: [],
    paramOptions: { fields: { provider: false, model: false, effort: false, permissionPolicy: false } },
    createTools(context) {
      return ['fixture_read', 'fixture_write'].map(name => ({ name, label: name === 'fixture_write' ? 'Write' : 'Read', description: 'Offline UI fixture action.',
        parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        async execute(_id, input, signal) {
          const duration = input.message.startsWith('activity-slow') ? 10000 : 300;
          for (let elapsed = 0; elapsed < duration; elapsed += 100) { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 100)); }
          if (input.message.startsWith('activity-fail')) throw new Error('Activity fixture failed');
          return { content: [{ type: 'text', text: 'Approved tool executed' }], details: {} };
        },
      }));
    },
  },
  tools: [{ name: 'fixture_read', label: 'Read', enabled: true, autoApprove: true }, { name: 'fixture_write', label: 'Write', enabled: true, autoApprove: false, approvalMode: 'always' }],
  conversation: { attachments: { images: true, videos: true, files: true } },
  async prepareInput(input, context) {
    let text = input.prompt;
    if (text === 'ask' || text === 'question') {
      const result = await steamharness.runNode(question, {}, context);
      text = `Answer: ${result.values.choice} / ${result.values.notes}`;
    }
    if (text === 'timer') {
      const timer = await steamharness.runNode(steamharness.createTimerNode({ name: 'fixture-timer', title: 'Fixture timer' }), {}, context);
      await steamharness.endTimer(timer, context, { status: 'success', message: 'Completed timer' });
      text = '- [x] Completed task\n- [ ] Next task';
    }
    if (text === 'generated') {
      const file = await context.files.createFile({ name: 'generated.txt', mimeType: 'text/plain', buffer: 'Core generated content' });
      text = `[Generated file](${file.path})`;
    }
    const files = steamharness.parseConversationDefaultInputArgs(context.args);
    for (const file of [...files.images, ...files.videos, ...files.files]) {
      const resolved = await context.files.resolveFile(file);
      text += `\nFile: ${file.name}, ${file.mimeType}, bytes=${(await resolved.readBuffer()).length}`;
    }
    const state = await context.conversation.getValue();
    const key = `fixture-turn:${input.requestId}`;
    const turn = state.values[key] ?? Number(state.values.turns ?? 0) + 1;
    await context.conversation.setValue(key, turn); await context.conversation.setValue('turns', turn);
    return { ...input, prompt: `${text}\nTurn ${turn}`, ...(text === 'plan' ? { agent: 'plan' } : {}) };
  },
});
export default executor;
