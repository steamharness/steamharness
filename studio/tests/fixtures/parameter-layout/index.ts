import type { WorkflowRuntimeApi } from 'steamharness/runtime-api';

const workflow = (globalThis as unknown as { workflow: WorkflowRuntimeApi }).workflow;
const task = workflow.defineWorkflow({
  name: 'parameter-layout',
  run(input) {
    return workflow.createOutputPayload({ items: [{ id: 'answer', contentType: 'text', content: JSON.stringify(input) }] });
  },
});

export const executor = workflow.defineExecutor({
  projectType: 'conversation',
  workflow: task,
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
  createInput(context) {
    return { ...context.paramValues, message: workflow.parseConversationDefaultInputArgs(context.args).message };
  },
});
