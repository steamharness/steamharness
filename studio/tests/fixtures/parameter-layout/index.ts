import type { RuntimeApi } from 'steamharness/runtime-api';

const steamharness = (globalThis as unknown as { steamharness: RuntimeApi }).steamharness;
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.resolve('steamharness'));
const ai = await import(pathToFileURL(require.resolve('@earendil-works/pi-ai')).href);
const provider = ai.fauxProvider({ models: [{ id: 'fixture', name: 'Fixture', contextWindow: 8192, maxTokens: 2048 }] });
const models = ai.createModels(); models.setProvider(provider.provider);
provider.setResponses(Array.from({ length: 64 }, () => request => ai.fauxAssistantMessage(String(request.messages.filter(message => message.role === 'user').at(-1)?.content ?? 'Ready'))));

export const executor = steamharness.defineBot({
  agent: { models, resolvedModel: models.getModel('faux', 'fixture'), tools: [],
    paramOptions: { fields: { provider: false, model: false, effort: false, plan: false, permissionPolicy: false } } },
  params: [
    { kind: 'auxiliary', id: 'writing', label: 'Writing', fields: [
      { name: 'subject', flag: '--subject', type: 'string', label: 'Subject', defaultValue: 'Draft', required: true },
      { name: 'creativity', flag: '--creativity', type: 'number', label: 'Creativity', defaultValue: '0.2' },
      { name: 'citations', flag: '--citations', type: 'boolean', label: 'Citations', defaultValue: 'false' },
      { name: 'notes', flag: '--notes', type: 'string', label: 'Notes', control: 'textarea' },
    ] },
    { kind: 'mode', name: 'taskMode', flag: '--task-mode', label: 'Mode', options: [
      { value: 'ask', label: 'Ask' }, { value: 'build', label: 'Build' },
    ] },
    { kind: 'quick', id: 'format', label: 'Format', summary: ['format'], fields: [
      { name: 'format', flag: '--format', type: 'string', control: 'select', label: 'Format', required: true, defaultValue: 'markdown', options: [
        { value: 'markdown', label: 'Markdown' }, { value: 'json', label: 'JSON' },
      ] },
      { name: 'detail', flag: '--detail', type: 'string', control: 'select', label: 'Detail', options: [] },
    ] },
    { kind: 'quick', id: 'audience', label: 'Audience', summary: ['audience'], fields: [
      { name: 'audience', flag: '--audience', type: 'string', control: 'checkboxes', label: 'Audience', multiple: true, options: [
        { value: 'reader', label: 'Reader' }, { value: 'developer', label: 'Developer' }, { value: 'hidden', label: 'Hidden option' },
      ] },
    ] },
  ],
  resolveParams(context) {
    const format = context.paramValues.format || 'markdown';
    return { params: {
      detail: { value: `${format}-detail`, resolvedOptions: [{ value: `${format}-detail`, label: `${format} detail` }, { value: `${format}-disabled`, label: 'Disabled option' }],
        options: { [`${format}-disabled`]: { disabled: true } } },
      citations: { disabled: format === 'json' },
      notes: { visible: context.paramValues.taskMode === 'build' },
      audience: { options: { hidden: { visible: false } } },
    } };
  },
  prepareInput(input, context) {
    return { ...context.paramValues, message: steamharness.parseConversationDefaultInputArgs(context.args).message };
  },
});
