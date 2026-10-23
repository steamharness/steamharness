import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';
import { runInNewContext } from 'node:vm';
register();
const { TraceStore } = await import('../extensions/studio-workstation/src/workflow-trace-store.ts');
const { traceRows, filterTraceRows } = await import('../extensions/studio-workstation/webview/trace-model.ts');
const { projectFrameHtml } = await import('../extensions/studio-workstation/src/workflow-webview.ts');
const project = (id, projectType = 'conversation') => ({ id, name: id, uri: `file:///${id}`, projectType });
const snapshot = (project, extra = {}) => ({ project, ...extra });
const send = (binding, snapshot) => binding.receive({ type: 'workflow-trace', version: 1, kind: 'state', snapshot });

test('trace connections reject late data, mismatched project identities and stale disposal', () => {
  const store = new TraceStore(), a = project('a'), b = project('b'); store.update([a, b], a);
  const old = store.bind(a, 1, () => {}), next = store.bind(a, 1, () => {});
  send(old, snapshot(a, { activeId: 'stale' })); assert.equal(store.state().snapshot, undefined);
  send(next, snapshot(b)); assert.equal(store.state().snapshot, undefined);
  send(next, snapshot(a, { activeId: 'correct' })); old.dispose(); assert.equal(store.hasConnection(a.uri), true);
  assert.equal(store.state().snapshot.activeId, 'correct');
  store.select(b.uri); assert.equal(store.state().snapshot, undefined);
  store.update([b]); send(next, snapshot(a)); assert.equal(store.availableProjects().length, 1);
});

test('trace instances share live runs and connection replacement while keeping project and run selections independent', () => {
  const store = new TraceStore(), a = project('a', 'workflow'), b = project('b', 'workflow'); store.update([a, b], a);
  const original = store.bind(a, 1, () => {}); send(original, snapshot(a, { runs: [{ id: 'old' }], run: { id: 'latest' } }));
  const second = store.fork(); second.select(b.uri);
  assert.equal(store.selection.projectUri, a.uri); assert.equal(second.selection.projectUri, b.uri);
  second.select(a.uri, { runId: 'old' });
  const replaced = store.bind(a, 1, () => {}); original.dispose();
  send(replaced, snapshot(a, { runs: [{ id: 'old' }], run: { id: 'new', logs: 'live output' } }));
  assert.equal(second.hasConnection(a.uri), true); assert.equal(second.selection.runId, 'old');
  assert.equal(second.state().snapshot.run.logs, 'live output'); assert.equal(store.selection.runId, undefined);
  replaced.dispose(); assert.equal(second.state().status, 'closed');
});
test('a new trace instance starts at the default project without inheriting another view target', () => {
  const store = new TraceStore(), a = project('a', 'workflow'), b = project('b', 'workflow');
  store.update([a, b], a);
  store.select(b.uri, { runId: 'historical', sessionId: 'old-session', messageId: 'old-message' });
  const second = store.fork(); second.update([a, b], a);
  assert.deepEqual(second.selection, { projectUri: a.uri });
  assert.deepEqual(store.selection, { projectUri: b.uri, runId: 'historical', sessionId: 'old-session', messageId: 'old-message' });
});

test('assistant frames create independent conversations and restore the last selection across new service ports', () => {
  const render = (mode, saved, port = 3000) => {
    const listeners = {}, child = { postMessage() {} }, frame = { contentWindow: child, addEventListener() {} };
    let state;
    const html = projectFrameHtml(`http://127.0.0.1:${port}/#session=token`, 'Assistant', 'file:///project', 'dark', 'nonce', 'en', undefined, mode);
    runInNewContext(html.match(/<script nonce="nonce">([\s\S]*?)<\/script>/)[1], {
      URL, acquireVsCodeApi: () => ({ getState: () => saved, setState: value => { state = JSON.parse(JSON.stringify(value)); }, postMessage() {} }),
      document: { getElementById: () => frame }, addEventListener: (type, listener) => { listeners[type] = listener; },
    });
    return { url: new URL(frame.src), state: () => state, select: (id, create, extra = {}) => listeners.message({
      source: child, origin: `http://127.0.0.1:${port}`, data: { type: 'workflow-navigation', version: 1, id, create }, ...extra,
    }) };
  };
  const first = render('new'), second = render('new');
  const id = first.url.searchParams.get('conversationId');
  assert.ok(id); assert.notEqual(id, second.url.searchParams.get('conversationId'));
  assert.equal(first.url.searchParams.get('createConversation'), '1');
  assert.equal(first.url.hash, '#session=token');
  assert.equal(first.state().conversationView.conversation.create, true);
  const selected = '12345678-1234-1234-1234-123456789abc';
  for (const extra of [{ source: {} }, { origin: 'http://foreign' }]) { first.select(selected, false, extra); }
  first.select('invalid', false); first.select(selected, 'true');
  assert.equal(first.state().conversationView.conversation.id, id);
  first.select(id, false); first.select(selected, false);
  const restored = render('restore', first.state(), 4000);
  assert.equal(restored.url.searchParams.get('projectView'), first.url.searchParams.get('projectView'));
  assert.equal(restored.url.searchParams.get('conversationId'), selected);
  assert.equal(restored.url.searchParams.has('createConversation'), false);
  assert.equal(second.state().conversationView.conversation.create, true);
  const pending = render('restore', second.state());
  assert.equal(pending.url.searchParams.get('conversationId'), second.url.searchParams.get('conversationId'));
  assert.equal(pending.url.searchParams.get('createConversation'), '1');
  const legacy = render('restore', { projectUri: 'file:///project' });
  assert.equal(legacy.url.searchParams.has('conversationId'), false);
  const changed = render('new', { ...first.state(), projectUri: 'file:///other' });
  assert.notEqual(changed.url.searchParams.get('conversationId'), selected);
});
test('Kanban and a background assistant do not add a trace tab to an ordinary workspace', () => {
  const store = new TraceStore(), assistant = { ...project('assistant'), assistant: { standalone: true } };
  store.update([project('board', 'kanban')]); const binding = store.bind(assistant, 1, () => {});
  send(binding, snapshot(assistant)); assert.equal(store.availableProjects().length, 0);
  assert.equal(binding.receive({ type: 'workflow-trace', version: 1, kind: 'open', target: { messageId: 'reply' } }), true);
  assert.equal(store.availableProjects().length, 1); assert.equal(store.state().selection.messageId, 'reply');
  binding.dispose(); assert.equal(store.availableProjects().length, 0);
});
test('Workflow history stays independent of editor selection and survives partial history pages', () => {
  const store = new TraceStore(), a = project('a', 'workflow'), sent = []; store.update([a]);
  const binding = store.bind(a, 1, message => sent.push(message));
  send(binding, snapshot(a, { runs: [{ id: 'old' }], run: { id: 'latest' }, history: { query: '', hasMore: true } }));
  store.select(a.uri, { runId: 'old' }); store.request('run', 'old');
  assert.equal(sent[0].traceCommand.runId, 'old');
  binding.receive({ type: 'workflow-trace', version: 1, kind: 'run', runId: 'old', run: { id: 'old', logs: 'old logs' } });
  send(binding, snapshot(a, { runs: [{ id: 'latest' }], run: { id: 'latest' }, history: { query: 'filtered', hasMore: false } }));
  assert.equal(store.state().run.logs, 'old logs'); assert.equal(store.state().snapshot.run.id, 'latest');
  binding.dispose(); assert.equal(store.state().status, 'closed'); assert.equal(store.state().run.logs, 'old logs');
});
test('streamed tools are reconciled once with final items and retain actual timings, arguments and results', () => {
  const item = { id: 'tool-1', metadata: { kind: 'agent-part', partType: 'tool', status: 'success' },
    content: { type: 'tool', tool: 'bash', input: { command: 'git status' }, output: 'clean', status: 'success' } };
  const data = snapshot(project('a'), { activeId: 's', sessions: [{ id: 's', messages: [
    { id: 'user', role: 'user', content: 'Inspect', createdAt: 1000 },
    { id: 'answer', role: 'assistant', status: 'success', items: [item], events: [
      { type: 'node_chunk', timestamp: new Date(1100).toISOString(), chunk: { type: 'output_item_start', item } },
      { type: 'node_chunk', timestamp: new Date(1300).toISOString(), chunk: { type: 'output_item_end', itemId: item.id } },
    ], report: { nodes: [], logs: 'Raw log\nsecond line' } },
  ] }] });
  const rows = traceRows(data, { sessionId: 's', messageId: 'answer' }); const tool = rows.find(row => row.lane === 'tool');
  assert.equal(rows.filter(row => row.lane === 'tool').length, 1); assert.equal(tool.durationMs, 200);
  assert.match(tool.preview, /git status/); assert.match(tool.preview, /clean/);
  assert.equal(rows[0].preview, 'Inspect'); assert.match(rows.at(-1).preview, /second line/);
  assert.equal(filterTraceRows(rows, 'SECOND LINE', 'duration').length, 1);
  assert.ok(!filterTraceRows(rows, '', 'calls').some(row => row.lane === 'input' || row.lane === 'log'));
});
test('pending nodes and tool calls reflect paused, failed and stopped runs without invented time', () => {
  for (const [status, expected] of [['waiting_for_input', 'waiting'], ['failed', 'failed'], ['aborted', 'stopped']]) {
    const rows = traceRows(snapshot(project('a', 'workflow'), { run: { id: 'run', title: 'Run', status,
      nodes: [{ executionId: 'node', name: 'Node', status: 'running' }],
      items: [{ id: 'call', metadata: { kind: 'agent-part', partType: 'tool', status: 'running' }, content: { type: 'tool', tool: 'read', input: { path: 'README' }, status: 'running' } }] } }), {});
    for (const row of rows.filter(row => row.lane !== 'input')) { assert.equal(row.status, expected); assert.equal(row.start, undefined); assert.equal(row.durationMs, undefined); }
  }
});
test('selecting one conversation reply does not leak other rounds or sessions', () => {
  const data = snapshot(project('a'), { activeId: 's', sessions: [{ id: 's', messages: [
    { role: 'user', content: 'first' }, { id: 'first', role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second' }, { id: 'second', role: 'assistant', content: 'second answer' },
  ] }, { id: 'other', messages: [{ role: 'user', content: 'private-other' }] }] });
  const text = JSON.stringify(traceRows(data, { messageId: 'second' }));
  assert.match(text, /second answer/); assert.doesNotMatch(text, /first answer|private-other/);
});

test('reopening the CLI reloads a selected historical trace and failed lookups stop retrying', () => {
  const store = new TraceStore(), a = project('a', 'workflow'), requests = []; store.update([a]); store.select(a.uri, { runId: 'old' });
  let binding = store.bind(a, 1, message => requests.push(message));
  const data = snapshot(a, { runs: [{ id: 'old' }], run: { id: 'latest', status: 'running' }, running: true });
  send(binding, data); assert.equal(requests.length, 1); assert.equal(store.state().loading, true);
  send(binding, data); assert.equal(requests.length, 1);
  binding.receive({ type: 'workflow-trace', version: 1, kind: 'run', runId: 'old', error: 'missing' });
  send(binding, data); assert.equal(requests.length, 1); assert.equal(store.state().error, 'missing');
  binding.dispose(); assert.equal(store.state().loading, false); assert.equal(store.state().snapshot.running, false);
  assert.equal(store.state().snapshot.run.status, 'interrupted');
  binding = store.bind(a, 1, message => requests.push(message)); send(binding, data); assert.equal(requests.length, 2);
});

test('model classification uses Core metadata and preserves node display names', () => {
  const data = snapshot(project('a', 'workflow'), { run: { id: 'r', status: 'success', title: 'Run', nodes: [
    { executionId: 'model', name: 'output', kind: 'stream', metadata: { type: 'llm-stream', title: 'Draft' }, status: 'success' },
    { executionId: 'parse', name: 'input', metadata: { type: 'input', title: 'iteration' }, status: 'success' },
  ], items: [{ content: 'Local result' }] } });
  const rows = traceRows(data, {});
  assert.equal(rows.find(row => row.lane === 'model').title, 'Draft');
  assert.equal(rows.find(row => row.title === 'iteration').lane, 'node');
  assert.equal(rows.find(row => row.preview === 'Local result').lane, 'output');
});

test('the outer webview configures an immediately loaded frame and validates trace and account messages', () => {
  const html = projectFrameHtml('http://127.0.0.1:3000/', 'Example', 'file:///project', 'dark', 'nonce', 'zh-cn');
  const listeners = {}, sent = [], frameMessages = [], contextMenus = [], child = { postMessage: (...args) => frameMessages.push(args) };
  let frameContext;
  const frame = { contentWindow: child, addEventListener: (name, callback) => { listeners[name] = callback; },
    setAttribute: (_key, value) => { frameContext = JSON.parse(value); },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 300 }),
    dispatchEvent: event => contextMenus.push({ type: event.type, ...event }),
    set src(value) {
      assert.equal(new URL(value).searchParams.get('projectLocale'), 'zh-CN');
      assert.equal(typeof listeners.load, 'function');
      assert.equal(typeof listeners.message, 'function');
      listeners.load();
    },
  };
  const document = { activeElement: frame, documentElement: { dataset: { vscodeNativeClipboard: '1' } }, getElementById: () => frame };
  runInNewContext(html.match(/<script nonce="nonce">([\s\S]*?)<\/script>/)[1], {
    acquireVsCodeApi: () => ({ setState() {}, postMessage: message => sent.push(message) }),
    document,
    addEventListener: (name, callback) => { listeners[name] = callback; },
    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(frameMessages)), [[{ type: 'workflow-host', theme: 'dark', locale: 'zh-CN', traceVersion: 1, clipboardVersion: 1, nativePasteVersion: 1, resourceVersion: 1, recoveryVersion: 1, dropVersion: 1, pathPickerVersion: 1, pathOpenVersion: 1, fileIconsVersion: 1 }, 'http://127.0.0.1:3000']]);
  assert.equal(sent.shift().type, 'workflow-drop-target');
  assert.equal(sent.shift().type, 'workflow-frame-ready');
  const data = { type: 'workflow-trace', version: 1, kind: 'open' };
  listeners.message({ source: {}, origin: 'http://127.0.0.1:3000', data });
  listeners.message({ source: child, origin: 'http://foreign', data });
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: { ...data, version: 2 } });
  assert.equal(sent.length, 0);
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data }); assert.equal(sent.length, 1);
  const account = { type: 'workflow-account', version: 1 };
  listeners.message({ source: {}, origin: 'http://127.0.0.1:3000', data: account });
  listeners.message({ source: child, origin: 'http://foreign', data: account });
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: { ...account, version: 2 } });
  assert.equal(sent.length, 1);
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: account });
  assert.equal(sent.length, 2); assert.equal(sent[1].type, 'workflow-account');
  const clipboard = { type: 'workflow-clipboard', version: 1, command: 'writeText', requestId: 'copy-1', text: 'native' };
  listeners.message({ source: {}, origin: 'http://127.0.0.1:3000', data: clipboard });
  listeners.message({ source: child, origin: 'http://foreign', data: clipboard });
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: { ...clipboard, version: 2 } });
  assert.equal(sent.length, 2);
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: clipboard });
  assert.equal(sent.length, 3); assert.equal(sent[2].requestId, 'copy-1');
  const reply = { type: 'workflow-host', clipboard: { version: 1, requestId: 'copy-1', ok: true } };
  listeners.message({ source: {}, data: reply });
  assert.equal(frameMessages.at(-1)[0], reply); assert.equal(frameMessages.at(-1)[1], 'http://127.0.0.1:3000');
  const resource = { type: 'workflow-resource', version: 1, request: { type: 'resource', cardId: 'saved-card', action: 'window' } };
  listeners.message({ source: child, origin: 'http://foreign', data: resource });
  assert.equal(sent.length, 3);
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: resource });
  assert.equal(sent.length, 4); assert.equal(sent[3].request.cardId, 'saved-card');
  const recovery = { type: 'workflow-reconnect', version: 1, requestId: 'retry-1' };
  listeners.message({ source: {}, origin: 'http://127.0.0.1:3000', data: recovery });
  listeners.message({ source: child, origin: 'http://foreign', data: recovery });
  assert.equal(sent.length, 4);
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: recovery });
  assert.equal(sent.pop(), recovery);
  const picker = { type: 'workflow-path-picker', version: 1, kind: 'folders', requestId: 'picker-1', target: 'conversation:2' };
  const beforePicker = sent.length;
  listeners.message({ source: {}, origin: 'http://127.0.0.1:3000', data: picker });
  listeners.message({ source: child, origin: 'http://foreign', data: picker });
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: { ...picker, version: 2 } });
  assert.equal(sent.length, beforePicker);
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: picker });
  assert.equal(sent.pop(), picker);
  const pathOpen = { type: 'workflow-path-open', version: 1, requestId: 'open-1', path: '/Desktop/a b.docx' };
  const beforeOpen = sent.length;
  listeners.message({ source: {}, origin: 'http://127.0.0.1:3000', data: pathOpen });
  listeners.message({ source: child, origin: 'http://foreign', data: pathOpen });
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: { ...pathOpen, version: 2 } });
  assert.equal(sent.length, beforeOpen);
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: pathOpen });
  assert.equal(sent.pop(), pathOpen);
  const fileIcons = { type: 'workflow-file-icons', version: 1, requestId: 'icons-1', files: [{ path: '/src/index.ts', kind: 'file' }] };
  const beforeIcons = sent.length;
  listeners.message({ source: {}, origin: 'http://127.0.0.1:3000', data: fileIcons });
  listeners.message({ source: child, origin: 'http://foreign', data: fileIcons });
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: { ...fileIcons, version: 2 } });
  assert.equal(sent.length, beforeIcons);
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: fileIcons });
  assert.equal(sent.pop(), fileIcons);
  const dropTarget = { type: 'workflow-drop-target', version: 1, target: 'conversation:2' };
  listeners.message({ source: {}, origin: 'http://127.0.0.1:3000', data: dropTarget });
  listeners.message({ source: child, origin: 'http://foreign', data: dropTarget });
  assert.equal(sent.length, 4);
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: dropTarget });
  assert.equal(sent.pop(), dropTarget);
  const edit = detail => { let prevented = false; listeners['vscode-webview-exec-command']({ detail, preventDefault: () => { prevented = true; } }); return prevented; };
  assert.equal(edit('paste'), false);
  const capability = { type: 'workflow-edit', version: 1 };
  listeners.message({ source: {}, origin: 'http://127.0.0.1:3000', data: capability });
  listeners.message({ source: child, origin: 'http://foreign', data: capability });
  assert.equal(edit('paste'), false);
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: capability });
  document.activeElement = undefined;
  assert.equal(edit('paste'), false);
  document.activeElement = frame;
  assert.equal(edit('insertHTML'), false);
  for (const command of ['paste', 'copy', 'cut', 'selectAll', 'undo', 'redo']) {
    assert.equal(edit(command), true);
    assert.deepEqual(JSON.parse(JSON.stringify(frameMessages.at(-1))), [{ type: 'workflow-host', editCommand: command }, 'http://127.0.0.1:3000']);
  }
  const nativeClipboard = { text: 'native text', image: new Uint8Array([1, 2, 3]) };
  assert.equal(edit({ command: 'paste', clipboard: nativeClipboard }), true);
  assert.equal(frameMessages.at(-1)[0].clipboardData, nativeClipboard);
  assert.equal(edit({ command: 'copy' }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(frameMessages.at(-1)[0])), { type: 'workflow-host', editCommand: 'copy' });
  listeners.message({ source: child, origin: 'http://127.0.0.1:3000', data: { ...capability, command: 'paste' } });
  assert.deepEqual(JSON.parse(JSON.stringify(contextMenus.shift())), { type: 'vscode-webview-paste', bubbles: true });
  const context = (source, origin, data = {}) => listeners.message({ source, origin, data: { type: 'workflow-contextmenu', version: 1, x: 40, y: 50, editable: true, selection: false, ...data } });
  context({}, 'http://127.0.0.1:3000'); context(child, 'http://foreign');
  context(child, 'http://127.0.0.1:3000', { x: '40' }); context(child, 'http://127.0.0.1:3000', { x: 401 });
  document.activeElement = undefined; context(child, 'http://127.0.0.1:3000'); document.activeElement = frame;
  assert.equal(contextMenus.length, 0);
  context(child, 'http://127.0.0.1:3000');
  assert.deepEqual(frameContext, { preventDefaultContextMenuItems: false, studioFrameSelection: false });
  assert.deepEqual(JSON.parse(JSON.stringify(contextMenus)), [{ type: 'contextmenu', bubbles: true, cancelable: true, clientX: 50, clientY: 70 }]);
  context(child, 'http://127.0.0.1:3000', { editable: false, selection: false }); assert.equal(contextMenus.length, 1);
  context(child, 'http://127.0.0.1:3000', { editable: 'true', selection: 'true' }); assert.equal(contextMenus.length, 1);
  context(child, 'http://127.0.0.1:3000', { editable: false, selection: true });
  assert.deepEqual(frameContext, { preventDefaultContextMenuItems: true, studioFrameSelection: true }); contextMenus.pop();
  document.activeElement = undefined; assert.equal(edit({ command: 'paste', clipboard: nativeClipboard }), true);
  assert.equal(frameMessages.at(-1)[0].restoreFocus, true); assert.equal(edit('paste'), false);
  document.activeElement = frame;
  listeners.load(); assert.equal(edit('paste'), false);
  context(child, 'http://127.0.0.1:3000'); assert.equal(contextMenus.length, 1);
});
