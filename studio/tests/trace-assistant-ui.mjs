import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
register();
const { WorkflowTraceStore } = await import('../extensions/studio-workstation/src/workflow-trace-store.ts');
const { ConversationController } = await import('../../cli/src/web/conversation-controller.ts');
const { startWebServer } = await import('../../cli/src/web/server.ts');

const root = fileURLToPath(new URL('../', import.meta.url));
const assistant = path.join(root, '../build-in/build-in-developer-assistant');
const loader = createRequire(path.join(assistant, 'node_modules/@steamharness/cli/package.json')).resolve('tsx');
const directory = await mkdtemp(path.join(tmpdir(), 'workflow-trace-assistant-'));
const target = { kind: 'folder', folderId: 'fixture' };
await writeFile(path.join(directory, 'workspace.json'), JSON.stringify({ schemaVersion: 2, primaryTarget: target, warnings: [], roots: [{ target, name: 'Fixture', rootPath: directory, role: 'primary', depth: 0 }] }));
async function worker(phase) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, '--conditions=development',
    path.join(assistant, '__tests__/fixtures/durable-assistant-worker.ts'), directory, 'approval-session', phase], {
    cwd: assistant, env: { ...process.env, STEAMHARNESS_DEVELOPER_ASSISTANT_HOST: 'vscode', STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR: directory,
      STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST: path.join(directory, 'workspace.json'), STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER: '', STEAMHARNESS_DEVELOPER_ASSISTANT_CODE_MODE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const result = new Promise((resolve, reject) => {
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => { if (['waiting', 'done'].includes(message.type)) resolve(message); });
    child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error(`Assistant failed (${code}): ${stderr}`)); });
  });
  const exit = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try { const value = await result; assert.equal((await exit)[0], 0); return value; }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
}
const decisions = [], sessionId = crypto.randomUUID(); let unexpectedRuns = 0;
const project = { id: crypto.randomUUID(), uri: pathToFileURL(directory).href, folderPath: directory, name: 'Actual Project Assistant', projectType: 'conversation',
  fields: [], entrypoints: [], conversation: { durable: { enabled: true }, recovery: { enabled: true }, userInput: { hideComposer: false } } };
const runtime = { available: true, inspect: async () => ({ projects: [project], errors: [] }), resolveParams: async () => ({ params: {} }),
  run: async () => { unexpectedRuns++; throw new Error('This proof must not execute an additional model.'); },
  cancel() {}, dispose() {}, uploadFiles: async () => [], deleteFiles: async () => {}, deleteConversation: async () => {}, cancelConversation: async () => {} };
function projectStage(result) {
  const controller = new ConversationController(project, runtime, { activeId: sessionId, sessions: [{ id: sessionId, title: 'Plan proof', agent: result.snapshot,
    messages: [{ role: 'user', content: 'Create a reading plan' }, { id: 'reply', role: 'assistant', runId: 'original-run', content: '',
      status: result.type === 'waiting' ? 'waiting_for_input' : 'success', items: [], pendingInput: result.request, resolvedInputs: structuredClone(decisions) }] }] }, { save: async () => {}, changed() {}, log() {} });
  return controller.current;
}
const store = new WorkflowTraceStore(); store.update([project]);
let app, server, browser, page, binding;
const errors = [];
async function publish() { await page?.evaluate(value => document.getElementById('trace').contentWindow.postMessage(value, '*'), store.state()); }
try {
  const initial = await worker('plan');
  app = await startWebServer({ projectDir: directory, dataDir: path.join(directory, 'web'), runtime, host: { surface: 'editor' } });
  app.controller.sessions.splice(0, app.controller.sessions.length, projectStage(initial)); app.controller.activeId = sessionId;
  const dist = path.join(root, 'extensions/studio-workstation/dist');
  const bundle = JSON.parse(await readFile(path.join(root, 'extensions/studio-workstation/l10n/bundle.l10n.json'), 'utf8'));
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><html><head><meta charset="UTF-8"><style>html,body{margin:0;height:100%;display:flex;width:100%}iframe{width:50%;height:100%;border:0}</style></head><body><iframe id="cli" src="${app.url}"></iframe><iframe id="trace" src="/trace"></iframe><script>
          const cli=document.getElementById('cli'),trace=document.getElementById('trace');cli.onload=()=>cli.contentWindow.postMessage({type:'workflow-host',traceVersion:1,theme:'light'},'${app.origin}');
          addEventListener('message',event=>{if(event.source===cli.contentWindow&&event.origin==='${app.origin}'&&event.data.type==='workflow-trace')void window.cliTrace(event.data);if(event.source===trace.contentWindow&&event.data.type==='trace-request')void window.traceRequest(event.data.message)});
          </script></body></html>`);
      } else if (pathname === '/trace') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/trace-ui.css"><link rel="stylesheet" href="/codicons/codicon.css"></head><body><div id="trace-app"></div><script id="studio-localization" type="application/json">${JSON.stringify({ bundle, locale: 'en' })}</script><script>acquireVsCodeApi=()=>({postMessage:message=>parent.postMessage({type:'trace-request',message},'*'),getState:()=>({}),setState(){}})</script><script src="/trace-ui.js"></script></body></html>`);
      } else if (/^\/(trace-ui\.(js|css)|codicons\/(codicon\.css|codicon\.ttf))$/.test(pathname)) {
        response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'font/ttf'); response.end(await readFile(path.join(dist, pathname.slice(1))));
      } else response.writeHead(404).end();
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: process.env.STEAMHARNESS_UI_BROWSER ?? 'chrome', headless: true }); page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', error => errors.push(error.message));
  binding = store.bind(project, 1, message => void page.evaluate(({ message, origin }) => document.getElementById('cli').contentWindow.postMessage(message, origin), { message, origin: app.origin }).catch(error => errors.push(error.message)));
  await page.exposeFunction('cliTrace', async message => { binding.receive(message); await publish(); });
  await page.exposeFunction('traceRequest', async message => {
    if (message.type === 'ready') await publish();
    else if (message.generation === store.generation && message.projectUri === store.selection.projectUri) {
      if (message.type === 'agent-action') store.action(message.action);
      else if (message.type === 'select') store.select(project.uri, message.target);
      await publish();
    }
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const trace = page.frameLocator('#trace'), cli = page.frameLocator('#cli');
  await trace.locator('#trace-tab-plan').click({ timeout: 10_000 }); await trace.locator('.trace-plan-document').getByText('A seven-day reading plan.').waitFor();
  assert.equal(await cli.locator('#agent-panel').count(), 0); assert.equal(await cli.locator('[aria-controls=agent-panel]').count(), 0);
  assert.match(await cli.locator('#transcript-content').innerText(), /A seven-day reading plan/);
  const decision = (result, session, value) => ({ requestId: result.request.requestId, nodeName: result.request.nodeName, request: result.request,
    values: { decision: value, instructions: value === 'decline' ? 'Change it to thirty days' : '' }, submittedAt: new Date().toISOString(), precedingOutputItemIds: session.messages[1].items.map((item, index) => item.id ?? String(index)) });
  decisions.push(decision(initial, app.controller.current, 'decline')); await writeFile(path.join(directory, 'decisions.json'), JSON.stringify(decisions));
  const revised = await worker('revise'); app.controller.sessions[0] = projectStage(revised); await app.controller.select(sessionId);
  await trace.locator('.trace-plan-document').getByText('A thirty-day reading plan.').waitFor();
  decisions.push(decision(revised, app.controller.current, 'approve')); await writeFile(path.join(directory, 'decisions.json'), JSON.stringify(decisions));
  const approved = await worker('approve'); app.controller.sessions[0] = projectStage(approved); await app.controller.select(sessionId);
  await trace.locator('.trace-plan-heading').getByText('Approved', { exact: true }).waitFor();
  const reopened = await worker('replay'); assert.equal(reopened.calls, 0); app.controller.sessions[0] = projectStage(reopened); await app.controller.select(sessionId);
  await cli.locator('#transcript-content').getByText('Approved task completed.', { exact: true }).waitFor();
  assert.match(await trace.locator('.trace-plan-document').innerText(), /thirty-day/); assert.doesNotMatch(await trace.locator('.trace-plan-document').innerText(), /Approved task completed/);
  await cli.locator('#message').fill('Unsent draft'); await cli.locator('#new').click();
  await cli.locator('#transcript-content').getByText('Approved task completed.', { exact: true }).waitFor({ state: 'hidden' });
  await cli.locator('#message').fill('Another draft');
  const otherId = await cli.locator('#session-list .session.active').getAttribute('data-session-id');
  assert.notEqual(otherId, sessionId);
  await trace.locator('#trace-session').selectOption(sessionId); await trace.locator('#trace-tab-tasks').click();
  assert.equal(await cli.locator('#message').inputValue(), 'Another draft');
  await trace.locator('.trace-agent-conversation').first().click(); await page.waitForFunction(() => document.getElementById('trace').contentDocument.querySelector('#trace-agent-actions').disabled === false);
  await cli.locator('#transcript-content').getByText('Approved task completed.', { exact: true }).waitFor();
  assert.equal(await cli.locator('#message').inputValue(), 'Unsent draft');
  await cli.locator(`#session-list [data-session-id="${otherId}"]`).click();
  assert.equal(await cli.locator('#message').inputValue(), 'Another draft'); assert.equal(unexpectedRuns, 0);
  const proof = path.join(root, '.studio/trace-agent'); await mkdir(proof, { recursive: true }); await page.screenshot({ path: path.join(proof, 'actual-assistant-cli-trace.png') });
  assert.deepEqual(errors, []); console.log(JSON.stringify({ headless: true, workflow: 'actual built-in developer assistant', provider: 'offline faux', bridge: 'actual CLI UI + HTTP/SSE + Trace store + Trace UI', checks: ['plan', 'revision', 'approved', 'reopened', 'inline-history', 'no-cli-task-panel', 'open-conversation', 'preserve-draft'], modelCallsOnReopen: reopened.calls, unexpectedRuns }));
} catch (error) {
  console.error(JSON.stringify({ status: store.state().status, selection: store.selection, snapshot: !!store.state().snapshot, errors,
    frames: await page?.locator('iframe').evaluateAll(frames => frames.map(frame => ({ id: frame.id, src: frame.src }))),
    cli: await page?.frameLocator('#cli').locator('body').innerText().catch(() => '') }));
  throw error;
} finally { binding?.dispose(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await app?.close(); await rm(directory, { recursive: true, force: true }); }
