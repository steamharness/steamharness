import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';
import { config } from '@vscode/l10n';
import { readFile } from 'node:fs/promises';

register();
config({ contents: await readFile(new URL('../extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', import.meta.url), 'utf8') });
const { agentActivity, activeAgentActivity, activityGroupSummary, activityValueText } = await import('../extensions/studio-workstation/webview/agent-activity.ts');
const tool = (name, input = {}, status = 'success', details = {}) => ({
  id: 'call', contentType: 'json', collapsed: true,
  metadata: { kind: 'agent-part', partType: 'tool', status },
  content: { type: 'tool', status, tool: name, input, ...details },
});
const message = (status, items, extra = {}) => ({ role: 'assistant', content: '', status, items, ...extra });

test('tool summaries expose real file paths, search terms and commands with Desktop aliases', () => {
  const cases = [
    ['read', { path: 'README.md' }, 'read', 'README.md', '\u5df2\u8bfb\u53d6'],
    ['mcp_read', { file_path: 'src/main.ts' }, 'read', 'src/main.ts', '\u5df2\u8bfb\u53d6'],
    ['grep', { directory: 'src', pattern: 'createAgent' }, 'search', 'src \u4e2d \u201ccreateAgent\u201d', '\u5df2\u641c\u7d22'],
    ['glob', { pattern: '**/*.ts' }, 'search', '\u201c**/*.ts\u201d', '\u5df2\u641c\u7d22'],
    ['ls', { cwd: 'src' }, 'list', 'src \u4e2d\u7684\u6587\u4ef6', '\u5df2\u5217\u51fa'],
    ['bash', { command: 'git status --short' }, 'command', 'git status --short', '\u5df2\u8fd0\u884c'],
    ['exec_command', { cmd: 'rg --files' }, 'command', 'rg --files', '\u5df2\u8fd0\u884c'],
    ['edit', { filePath: 'src/main.ts' }, 'edit', 'src/main.ts', '\u5df2\u7f16\u8f91'],
    ['custom_tool', { action: 'run' }, 'tool', 'custom_tool', '\u5df2\u8c03\u7528\u5de5\u5177'],
  ];
  for (const [name, input, kind, target, label] of cases) {
    const activity = agentActivity(tool(name, input));
    assert.equal(activity.kind, kind); assert.equal(activity.target, target);
    assert.equal(activity.label, label); assert.equal(activity.title, `${label} ${target}`);
    assert.deepEqual(activity.sections[0].value, input);
  }
});

test('unfinished calls follow approval, cancellation, timeout and failure instead of spinning forever', () => {
  const item = tool('bash', { command: 'git status' }, 'running');
  for (const [status, expected] of [['running', 'running'], ['waiting_for_input', 'waiting'], ['aborted', 'stopped'], ['success', 'stopped'], ['failed', 'failed'], ['timed_out', 'failed']]) {
    assert.equal(agentActivity(item, message(status, [item])).status, expected);
  }
  assert.equal(agentActivity(item, message('running', [item], { pendingInput: { requestId: 'approval' } })).status, 'waiting');
  assert.equal(agentActivity(tool('read', { path: 'README.md' }), message('aborted', [])).status, 'success');
  assert.equal(agentActivity(tool('read', {}, 'failed'), message('success', [])).status, 'failed');
  assert.equal(agentActivity({ ...item, metadata: { ...item.metadata, status: 'success' } }).status, 'success');
});

test('current activity and group summaries retain progress and failures for concurrent calls', () => {
  const done = tool('read', { path: 'README.md' });
  const running = tool('bash', { command: 'npm test' }, 'running');
  const failed = tool('read', { path: 'missing.ts' }, 'failed');
  const current = message('running', [done, running, failed]);
  assert.equal(activeAgentActivity(current).title, '\u6b63\u5728\u8fd0\u884c npm test');
  assert.deepEqual(activityGroupSummary(current.items.map((item) => agentActivity(item, current))), { title: '\u6b63\u5728\u8fd0\u884c \u00b7 1/3 \u9879', status: 'running' });
  const finished = message('success', [done, tool('bash', running.content.input), failed]);
  assert.equal(activeAgentActivity(finished), undefined);
  assert.deepEqual(activityGroupSummary(finished.items.map((item) => agentActivity(item, finished))), { title: '\u8fd0\u884c\u8bb0\u5f55 \u00b7 3 \u9879\uff0c1 \u9879\u5931\u8d25', status: 'failed' });
  assert.equal(activityGroupSummary([agentActivity(running, message('aborted', []))]).status, 'stopped');
});

test('ordinary JSON, answers and plans retain their original presentation', () => {
  const content = tool('read').content;
  for (const item of [
    { content, contentType: 'json' },
    { content: 'Final answer', contentType: 'markdown', metadata: { kind: 'agent-answer' } },
    { content: 'Plan', metadata: { kind: 'agent-notice', plan: true } },
    { content: { type: 'text', text: 'Answer' }, metadata: { kind: 'agent-part', partType: 'text' } },
    { content: { type: 'plan' }, metadata: { kind: 'agent-part', partType: 'plan' } },
  ]) { assert.equal(agentActivity(item), undefined); }
  assert.equal(agentActivity({ ...tool('read'), content: JSON.stringify(content) }).kind, 'read');
  assert.equal(agentActivity({ ...tool('read'), content: '{broken' }), undefined);
});

test('details preserve raw arguments, results, attachments and nested errors', () => {
  const output = { content: [{ type: 'text', text: 'Line 1' }, { type: 'text', text: 'Line 2' }], details: { lineCount: 2 } };
  const error = { name: 'CommandError', data: { message: 'Permission denied', exitCode: 1 } };
  const attachments = [{ type: 'file', name: 'report.txt' }];
  const activity = agentActivity(tool('custom_tool', {}, 'failed', { rawInput: 'raw argument', output, error, attachments }));
  assert.deepEqual(activity.sections.map((section) => section.value), ['raw argument', output, error, attachments]);
  assert.equal(activity.sections[2].error, true);
  assert.equal(activityValueText(output), 'Line 1\n\nLine 2\n\n' + JSON.stringify(output.details, null, 2));
  assert.match(activityValueText(error), /Permission denied/);
  const empty = { content: [], details: { count: 0 } };
  const media = { content: [{ type: 'image', data: 'image-data' }] };
  for (const value of [empty, media, null, false, 0]) { assert.equal(activityValueText(value), JSON.stringify(value, null, 2)); }
});

test('Agent and OpenCode reasoning, recovery and errors use the same activity list', () => {
  const content = { type: 'reasoning', text: 'Checking the project', status: 'success' };
  for (const kind of ['agent-part', 'opencode-part']) {
    const activity = agentActivity({ content, metadata: { kind, partType: 'reasoning' } });
    assert.equal(activity.title, '\u601d\u8003\u5b8c\u6210');
    assert.equal(activity.sections[0].value, content.text);
  }
  const error = { message: 'Provider failed', error: { data: { message: 'Retry exhausted' } } };
  const activity = agentActivity({ content: error, metadata: { kind: 'agent-error' } });
  assert.equal(activity.status, 'failed'); assert.deepEqual(activity.sections[0].value, error);
  for (const [kind, type] of [['opencode-todo', 'todo'], ['opencode-stream-recovery', 'retry'], ['opencode-retry', 'retry'], ['opencode-diff', 'patch']]) {
    assert.equal(agentActivity({ content: { status: 'success' }, metadata: { kind } }).kind, type);
  }
});
