import type { RuntimeApi } from 'steamharness/runtime-api';
import type { RunOutputPayload } from 'steamharness';

const workflow = (globalThis as unknown as { workflow: RuntimeApi }).workflow;
interface Input {
  errCode: number; errMessage: string; subject: string; style: string; rounds: number;
  review: boolean; delay: number; note: string; files: unknown[]; fail: boolean;
}
function inputFiles(value: unknown): unknown[] {
  if (Array.isArray(value)) { return value; }
  if (typeof value !== 'string' || !value) { return []; }
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
}
const prepareNode = workflow.createInputNode<Input>({
  name: 'prepare',
  parse(input) { console.log(`Preparing ${input.subject}`); return input; },
});
const conciseNode = workflow.createInputNode<Input>({ name: 'concise', parse: input => ({ ...input, note: 'Brief summary' }) });
const detailedNode = workflow.createInputNode<Input>({ name: 'detailed', parse: input => ({ ...input, note: 'Detailed summary' }) });
const step = workflow.createInputNode<Input>({
  name: 'iteration',
  async parse(input, context) {
    context.abortSignal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, input.delay));
    if (input.fail) { throw new Error('Offline failure example'); }
    console.log(`Iteration for ${input.subject}`); return input;
  },
});
const previewNode = workflow.createOutputNode<Input, RunOutputPayload>({
  name: 'preview',
  async *stream(input, context) {
    const text = `## ${input.subject}\n\n${input.note}\n\n\u5df2\u5b8c\u6210 ${input.rounds} \u8f6e\u672c\u5730\u5904\u7406\u3002`;
    yield workflow.createOutputItemChunk({ type: 'output_item_start', item: { id: 'preview', title: 'Preview', contentType: 'markdown', content: '' } });
    for (const delta of text.match(/.{1,5}|\n/g) ?? []) {
      context.abortSignal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, input.delay));
      yield workflow.createOutputItemChunk({ type: 'output_item_delta', itemId: 'preview', delta });
    }
    yield workflow.createOutputItemChunk({ type: 'output_item_end', itemId: 'preview' });
  },
  format: stream => workflow.createOutputPayload({ items: stream.items }),
});
const reviewNode = workflow.createUserInputNode<Input>({
  name: 'review', title: '\u786e\u8ba4\u5bfc\u51fa', description: '\u5ba1\u6838\u7ed3\u679c',
  params: [
    { name: 'approved', type: 'boolean', label: '\u6279\u51c6\u5bfc\u51fa', required: true },
    { name: 'notes', type: 'string', control: 'textarea', label: '\u5907\u6ce8' },
  ], defaultValues: { approved: true },
});
const exportResult = workflow.createOutputNode<Input, RunOutputPayload>({
  name: 'export',
  async format(input, context) {
    const text = `${input.subject}\n${input.note}\nRounds: ${input.rounds}\nFiles: ${input.files.length}\n`;
    const file = await context.files.createFile({ name: 'workflow-result.txt', mimeType: 'text/plain', buffer: new TextEncoder().encode(text) });
    return workflow.createOutputPayload({ items: [{ id: 'export', title: 'Export', contentType: 'markdown', content: `[workflow-result.txt](${file.path ?? file.url ?? file.id})` }] });
  },
});
const report = workflow.defineWorkflow<Input, RunOutputPayload>({
  name: 'studio-report',
  async run(input, context) {
    const prepared = await workflow.runNode(prepareNode, input, context);
    const selected = await workflow.runIf(prepared, context, {
      name: 'Style', branches: [{ label: 'Brief', condition: value => value.style === 'brief', run: (value, branchContext) => workflow.runNode(conciseNode, value, branchContext) }],
      else: { label: 'Detailed', run: (value, branchContext) => workflow.runNode(detailedNode, value, branchContext) },
    });
    const looped = await workflow.runFor(selected, context, {
      name: 'Rounds', items: () => Array.from({ length: Math.min(10, Math.max(1, input.rounds)) }, (_, index) => index),
      run: (value, _item, _index, loopContext) => workflow.runNode(step, value, loopContext),
    });
    const output = await workflow.runStreamNode(previewNode, looped, context);
    if (input.review) {
      const decision = await workflow.runNode(reviewNode, looped, context);
      if (!decision.values.approved) { return output.output!; }
    }
    const exported = await workflow.runNode(exportResult, looped, context);
    return workflow.createOutputPayload({ items: [...output.output!.items, ...exported.items] });
  },
});
const echo = workflow.defineWorkflow<Input, RunOutputPayload>({
  name: 'studio-echo', async run(input, context) { return (await workflow.runStreamNode(previewNode, input, context)).output!; },
});
export const executor = workflow.defineExecutor({
  projectType: 'workflow', defaultEntrypoint: 'report', entrypoints: [
    workflow.defineEntrypoint({
      id: 'report', title: '\u751f\u6210\u62a5\u544a', description: '\u79bb\u7ebf\u62a5\u544a\u5904\u7406', group: { id: 'reports', title: '\u62a5\u544a', order: 1 }, workflow: report,
      params: [
        { name: 'subject', flag: '--subject', type: 'string', label: '\u4e3b\u9898', required: true, defaultValue: '\u672c\u5730\u5de5\u4f5c\u6d41' },
        { name: 'files', flag: '--files', type: 'file', label: '\u8f93\u5165\u6587\u4ef6', multiple: true, accept: ['.txt', '.json'] },
        { kind: 'quick', id: 'style', label: '\u62a5\u544a\u6837\u5f0f', summary: ['style'], fields: [
          { name: 'style', flag: '--style', type: 'string', label: '\u6837\u5f0f', control: 'select', defaultValue: 'brief', options: [{ value: 'brief', label: '\u7b80\u6d01' }, { value: 'detailed', label: '\u8be6\u7ec6' }] },
          { name: 'format', flag: '--format', type: 'string', label: '\u683c\u5f0f', control: 'select', options: [] },
        ] },
        { kind: 'auxiliary', id: 'execution', label: '\u6267\u884c\u53c2\u6570', fields: [
          { name: 'rounds', flag: '--rounds', type: 'number', label: '\u5904\u7406\u8f6e\u6570', defaultValue: '2' },
          { name: 'delay', flag: '--delay', type: 'number', label: '\u6b65\u9aa4\u5ef6\u65f6 (ms)', defaultValue: '50' },
          { name: 'review', flag: '--review', type: 'boolean', label: '\u4eba\u5de5\u5ba1\u6838', defaultValue: 'true' },
          { name: 'fail', flag: '--fail', type: 'boolean', label: '\u6a21\u62df\u5931\u8d25', defaultValue: 'false' },
        ] },
      ],
      resolveParams(context) {
        const style = context.paramValues.style || 'brief';
        return { params: { format: { value: `${style}-text`, resolvedOptions: [{ value: `${style}-text`, label: `${style} text` }] } } };
      },
      createInput: context => ({ errCode: 0, errMessage: '', subject: String(context.paramValues.subject), style: String(context.paramValues.style || 'brief'), rounds: Number(context.paramValues.rounds || 2),
        review: String(context.paramValues.review ?? 'true') === 'true', delay: Math.max(0, Math.min(2000, Number(context.paramValues.delay ?? 50))), note: '', files: inputFiles(context.paramValues.files), fail: String(context.paramValues.fail ?? 'false') === 'true' }),
    }),
    workflow.defineEntrypoint({
      id: 'echo', title: '\u6d41\u5f0f\u9884\u89c8', group: { id: 'utilities', title: '\u5de5\u5177', order: 2 }, workflow: echo,
      params: [{ name: 'subject', flag: '--subject', type: 'string', label: '\u4e3b\u9898', defaultValue: '\u6d41\u5f0f\u8f93\u51fa', required: true }],
      createInput: context => ({ errCode: 0, errMessage: '', subject: String(context.paramValues.subject), note: 'Offline preview', rounds: 1, review: false, delay: 25, style: 'brief', files: [], fail: false }),
    }),
  ],
});
