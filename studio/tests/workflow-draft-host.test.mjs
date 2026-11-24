import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [path.join(import.meta.dirname, '../extensions/studio-workstation/src/workflow-draft-host.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/package.json');" },
  plugins: [{ name: 'draft-vscode', setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
      export const commands = { executeCommand: () => globalThis.draftHost.trusted };
      export const Uri = { file: directory => ({ toString: () => directory }) };
      export const window = {
        showOpenDialog: () => { globalThis.draftHost.picked++; return globalThis.draftHost.parents; },
        showInputBox: () => { globalThis.draftHost.named++; return globalThis.draftHost.name; },
        showInformationMessage: async () => undefined,
        showErrorMessage: async () => undefined,
      };` }));
  } }] });
const { bindDraftSave } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('native save revalidates its local source, handles cancellation and only acknowledges a durable draft', async t => {
  const token = 'a'.repeat(64), stepId = 'c'.repeat(24), requestId = randomUUID(), sessionId = randomUUID(), messageId = 'bot-response';
  const body = { type: 'workflow-save-draft', version: 1, requestId, sessionId, messageId, stepId, options: { outputName: 'report.json', groupBy: 'status' } };
  const replies = [], creates = [], requests = [];
  let listener, available = true;
  const server = createServer(async (request, response) => {
    let content = ''; for await (const chunk of request) content += chunk;
    requests.push({ url: request.url, auth: request.headers.authorization, body: JSON.parse(content) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ steps: available ? [{ id: stepId, kind: 'json-summary-v1', outputName: 'summary.json' }] : [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const draftHost = globalThis.draftHost = { trusted: true, picked: 0, named: 0, parents: undefined, name: undefined };
  t.after(() => { delete globalThis.draftHost; });
  const address = `http://127.0.0.1:${server.address().port}/entries/main/#session=${token}`;
  const binding = bindDraftSave({ project: { entryId: 'main', folderPath: '/isolated/bot' }, address: () => address, active: () => true,
    webview: { onDidReceiveMessage: callback => { listener = callback; return { dispose() {} }; }, postMessage: async response => { replies.push(response.workflowDraftSaved); } },
    create: async input => { creates.push(input); return { directory: '/isolated/new/report' }; }, open: async () => {} });
  t.after(() => binding.dispose());
  await listener({ ...body, stepId: 'b'.repeat(24) });
  assert.equal(draftHost.picked, 0);
  assert.equal(replies.at(-1).status, 'failed');

  await listener(body);
  assert.equal(replies.at(-1).status, 'cancelled');
  assert.equal(creates.length, 0);
  draftHost.parents = [{ scheme: 'file', fsPath: '/isolated/new' }];
  await listener(body);
  assert.equal(replies.at(-1).status, 'cancelled');
  assert.equal(creates.length, 0);

  Object.defineProperty(draftHost, 'name', { configurable: true, get() { available = false; return 'report'; } });
  await listener(body);
  assert.equal(replies.at(-1).status, 'failed');
  assert.equal(creates.length, 0);
  Object.defineProperty(draftHost, 'name', { value: 'report' });
  available = true;
  await listener(body);
  assert.deepEqual(creates, [{ name: 'report', parentDirectory: '/isolated/new', options: { groupBy: 'status', outputName: 'report.json' } }]);
  assert.deepEqual(replies.at(-1), { version: 1, requestId, status: 'saved', detail: '/isolated/new/report' });
  assert.ok(requests.every(request => request.url === '/entries/main/api/workflow-draft' && request.auth === `Bearer ${token}`
    && request.body.sessionId === sessionId && request.body.messageId === messageId && Object.keys(request.body).length === 2));
});
