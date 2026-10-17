const workflow = globalThis.workflow;
const approval = workflow.createToolApprovalGate();
const write = approval.wrap('write', () => 'Approved tool executed');
const timerNode = workflow.createTimerNode({ name: 'fixture-timer', title: 'Fixture timer' });
const question = workflow.createUserInputNode({
  name: 'question-form', title: 'Two questions',
  params: [
    { name: 'choice', type: 'string', required: true, control: 'radio', step: 1, label: 'Choose a format', options: [{ value: 'brief', label: 'Brief' }, { value: 'full', label: 'Full' }] },
    { name: 'notes', type: 'string', required: true, control: 'textarea', step: 2, label: 'Notes' },
  ],
});
const planApproval = workflow.createUserInputNode({
  name: 'approve-decision', title: 'Approve the plan', metadata: { type: 'agent-plan-approval', version: '1.0.0' },
  params: [
    { name: 'decision', type: 'string', required: true, control: 'radio', options: [{ value: 'approve', label: 'Execute plan' }, { value: 'decline', label: 'Revise plan' }] },
    { name: 'instructions', type: 'string', control: 'textarea' },
  ],
});
const planOutput = workflow.createOutputNode({
  name: 'plan-stream',
  async *stream(_input, context) {
    yield workflow.createOutputItemChunk({ type: 'output_item_start', item: { id: 'plan', title: 'Plan', contentType: 'markdown', content: '1. Inspect project\n2. Apply the change', metadata: { kind: 'agent-notice', plan: true }, collapsed: false } });
    const answer = await workflow.runNode(planApproval, {}, context);
    yield workflow.createOutputItemChunk({ type: 'output_item_start', item: { id: 'answer', title: 'Answer', contentType: 'markdown', content: `Plan decision: ${answer.values.decision}` } });
  },
  format(stream) { return workflow.createOutputPayload({ items: stream.items }); },
});
const activityOutput = workflow.createOutputNode({
  name: 'agent-activity-stream',
  async *stream(input, context) {
    const wait = async (duration) => {
      for (let elapsed = 0; elapsed < duration; elapsed += 100) {
        context.abortSignal.throwIfAborted(); await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const item = (id, tool, input, status, result = {}) => ({
      id, title: tool, contentType: 'json', collapsed: true,
      metadata: { kind: 'agent-part', partType: 'tool', status },
      content: { type: 'tool', tool, callId: id, input, status, ...result },
    });
    if (input.message !== 'activity') {
      const call = item('activity-pending', input.message === 'activity-wait' ? 'write' : 'bash', input.message === 'activity-wait' ? { path: 'report.txt' } : { command: 'git status --short' }, 'running');
      yield workflow.createOutputItemChunk({ type: 'output_item_start', item: call });
      if (input.message === 'activity-wait') { await write(context); }
      else { await wait(input.message === 'activity-fail' ? 500 : 10000); }
      if (input.message === 'activity-fail') { throw new Error('Activity fixture failed'); }
      const finished = item(call.id, call.content.tool, call.content.input, 'success', { output: { content: [{ type: 'text', text: 'Approved tool executed' }] } });
      yield workflow.createOutputItemChunk({ type: 'output_item_delta', itemId: call.id, item: finished, delta: finished.content });
      yield workflow.createOutputItemChunk({ type: 'output_item_end', itemId: call.id });
    } else {
      yield workflow.createOutputItemChunk({ type: 'output_item_start', item: { id: 'activity-intro', contentType: 'markdown', content: '\u6211\u5148\u67e5\u770b\u9879\u76ee\u76ee\u5f55\u548c\u914d\u7f6e\uff0c\u518d\u786e\u8ba4\u5bf9\u8bdd\u5de5\u4f5c\u7ad9\u7684\u8fd0\u884c\u5165\u53e3\u3002', metadata: { kind: 'agent-part', partType: 'text' } } });
      yield workflow.createOutputItemChunk({ type: 'output_item_end', itemId: 'activity-intro' });
      const calls = [
        ['read', { path: 'package.json' }, 'Project: conversation-features'],
        ['list', { path: '.' }, 'index.ts\npackage.json'],
        ['grep', { path: '.', pattern: 'defineExecutor|createOutputNode' }, 'index.ts: export const executor = workflow.defineExecutor(...)'],
        ['bash', { command: 'git status --short' }, 'Working tree is clean'],
        ['read', { path: 'index.ts', offset: 1, limit: 40 }, 'const workflow = globalThis.workflow;'],
        ['bash', { command: "rg --files -g 'AGENTS.md' -g 'README*' -g 'package.json' -g '*conversation*' -g '!node_modules/**' -g '!upstream/**'" }, 'package.json\nindex.ts'],
        ['read', { path: 'package.json' }, 'Project type: conversation'],
        ['read', { path: 'index.ts', offset: 41, limit: 40 }, 'const activityOutput = workflow.createOutputNode(...);'],
        ['read', { path: 'src/agent/very-long-directory-name/another-directory-name/missing-conversation-configuration.ts' }, undefined],
        ['bash', { command: 'git branch --show-current' }, 'main'],
      ];
      for (const [index, [tool, args, output]] of calls.entries()) {
        const id = `activity-${index}`; const running = item(id, tool, args, 'running');
        yield workflow.createOutputItemChunk({ type: 'output_item_start', item: running });
        await wait(index === 0 ? 4000 : 100);
        const finished = item(id, tool, args, output === undefined ? 'failed' : 'success', output === undefined
          ? { error: { message: 'File not found', code: 'ENOENT' } }
          : { output: { content: [{ type: 'text', text: output }], details: { tool } } });
        yield workflow.createOutputItemChunk({ type: 'output_item_delta', itemId: id, item: finished, delta: finished.content });
        yield workflow.createOutputItemChunk({ type: 'output_item_end', itemId: id });
      }
    }
    yield workflow.createOutputItemChunk({ type: 'output_item_start', item: { id: 'activity-answer', contentType: 'markdown', content: '\u5df2\u67e5\u770b\u5f53\u524d\u9879\u76ee\u3002\u5bf9\u8bdd\u5de5\u4f5c\u7ad9\u901a\u8fc7 `defineExecutor` \u6ce8\u518c\uff0c\u5e76\u4f7f\u7528\u7ed3\u6784\u5316\u4e8b\u4ef6\u5c55\u793a Agent \u7684\u6267\u884c\u8fc7\u7a0b\u3002\n\n| \u6587\u4ef6 | \u4f5c\u7528 |\n| --- | --- |\n| `package.json` | \u9879\u76ee\u6807\u8bc6\u4e0e\u4f9d\u8d56 |\n| `index.ts` | \u5bf9\u8bdd\u5165\u53e3\u4e0e\u5de5\u5177\u914d\u7f6e |', metadata: { kind: 'agent-answer' } } });
    yield workflow.createOutputItemChunk({ type: 'output_item_end', itemId: 'activity-answer' });
  },
  format(stream) { return workflow.createOutputPayload({ items: stream.items }); },
});
const task = workflow.defineWorkflow({
  name: 'conversation-features',
  async run(input, context) {
    let text = input.message;
    if (text === 'approval') { text = await write(context); }
    if (text === 'question') { text = JSON.stringify((await workflow.runNode(question, {}, context)).values); }
    if (text === 'plan') { return (await workflow.runStreamNode(planOutput, input, context)).output; }
    if (['activity', 'activity-stop', 'activity-wait', 'activity-fail'].includes(text)) { return (await workflow.runStreamNode(activityOutput, input, context)).output; }
    if (text === 'slow') {
      for (let index = 0; index < 40; index++) { context.abortSignal.throwIfAborted(); await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    if (text === 'knowledge') {
      const document = await workflow.createKnowledgeDocument(context.storage.local, { title: 'Migration note', markdown: 'Stored knowledge content' });
      text = document.id;
    }
    if (text === 'timer') {
      const timer = await workflow.runNode(timerNode, {}, context);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await workflow.endTimer(timer, context, { message: 'Completed timer' });
      text = '- [x] Completed task\n- [ ] Next task';
    }
    if (text === 'generated') {
      const file = await context.files.createFile({ name: 'generated.txt', mimeType: 'text/plain', buffer: 'Core generated content' });
      const image = await context.files.createFile({ name: 'generated.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAAAdUlEQVR4nOzQAQ3AIADAMPLcCxIRixkUwAy0EvrvuQZ33+BJUBAUBAVBQVAQFAQFQUFQEBQEBUFBUBAUBAVBQVAQFAQFQUFQEBQEBUFBUBAUBAVBQVAQFAQFQUFQEBQEBUFBUBAUBAVBQVAQFAQFQUFQEBQOAAAA//8Bm/JXAAAABklEQVQDANEoAdyIqg10AAAAAElFTkSuQmCC', 'base64') });
      text = `[Generated file](${file.path})\n\n![Generated image](${image.path})`;
      // A short silent PCM WAV checks media loading without a remote asset or playback.
      const wave = Buffer.alloc(1644);
      wave.write('RIFF'); wave.writeUInt32LE(1636, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16);
      wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28);
      wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(1600, 40);
      const audio = await context.files.createFile({ name: 'generated.wav', mimeType: 'audio/wav', buffer: wave });
      return workflow.createOutputPayload({ items: [
        { id: 'answer', contentType: 'markdown', content: text },
        { id: 'audio', contentType: 'audio', content: { src: audio.path, name: audio.name, mimeType: audio.mimeType }, collapsed: false },
      ] });
    }
    for (const file of [...input.images, ...input.videos, ...input.files]) {
      const resolved = await context.files.resolveFile(file);
      text += `\nFile: ${file.name}, ${file.mimeType}, bytes=${(await resolved.readBuffer()).length}`;
    }
    const previous = await context.storage.local.kv.conversation.getValue('turns') ?? 0;
    await context.storage.local.kv.conversation.setValue('turns', previous + 1);
    await context.storage.local.kv.setValue('project-note', 'Retained project value');
    return workflow.createOutputPayload({ items: [{ id: 'answer', title: 'Answer', contentType: 'markdown', content: `${text}\nTurn ${previous + 1}` }] });
  },
});
export const executor = workflow.defineExecutor({
  projectType: 'conversation', workflow: task,
  conversation: { attachments: { images: true, videos: true, files: true }, inputQueue: { enabled: true } },
  tools: [{ name: 'write', label: 'Write', description: 'A fixture tool', enabled: true, autoApprove: false }],
  params: [{ kind: 'mode', name: 'mode', flag: '--mode', label: 'Agent', defaultValue: 'plan', options: [{ value: 'plan', label: 'Plan' }, { value: 'build', label: 'Build' }] }],
  createInput(context) { return workflow.parseConversationDefaultInputArgs(context.args); },
});
