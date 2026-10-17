import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'import-meta-resolve';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';
import { desktopLocaleLaunch } from './desktop-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const conversationSource = process.env.STUDIO_CARD_PROJECT_DIR
  ? await realpath(process.env.STUDIO_CARD_PROJECT_DIR) : path.join(root, 'examples/conversation');
const core = await import(resolve('workflow-code', pathToFileURL(path.join(conversationSource, 'package.json')).href));
const languages = process.env.STUDIO_CARD_LOCALE ? [process.env.STUDIO_CARD_LOCALE] : ['en', 'zh-cn'];
const cli = process.env.STUDIO_CARD_CLI_DIR || await realpath(path.join(conversationSource, 'node_modules/@workflow-code/cli'));
const cliVersion = JSON.parse(await readFile(path.join(cli, 'package.json'), 'utf8')).version;
if (!process.env.STUDIO_CARD_CLI_DIR) {
  assert.equal(cliVersion, JSON.parse(await readFile(path.join(conversationSource, 'package.json'), 'utf8')).devDependencies['@workflow-code/cli']);
}
const proofDir = path.join(root, '.studio/resource-cards', process.env.STUDIO_CARD_PROJECT_DIR ? 'project' : 'examples');
await mkdir(proofDir, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const language of languages) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-card-ui-')));
  const dataDir = path.join(directory, 'user');
  await mkdir(path.join(dataDir, 'User'), { recursive: true });
  const settingsPath = path.join(dataDir, 'User/settings.json');
  const settings = theme => ({ 'workbench.colorTheme': theme, 'workbench.startupEditor': 'none',
    'window.autoDetectColorScheme': false, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'git.openRepositoryInParentFolders': 'never' });
  await writeFile(settingsPath, JSON.stringify(settings('Light Modern')));
  const catalog = JSON.parse(await readFile(path.join(root, 'extensions/studio-workstation', language === 'en' ? 'package.nls.json' : 'package.nls.zh-cn.json'), 'utf8'));
  const projects = [];
  const storageDir = path.join(dataDir, 'User/globalStorage/studio.studio-workstation/workflow/web');
  for (const type of ['conversation', 'kanban']) {
    const original = type === 'conversation' ? conversationSource : path.join(root, 'examples', type), folder = path.join(directory, type);
    await cp(original, folder, { recursive: true, filter: entry => !path.relative(original, entry).split(path.sep).some(part =>
      ['node_modules', '.git', 'dist', 'tmp'].includes(part) || part === '.env' || part.startsWith('.env.')) });
    await mkdir(path.join(folder, 'node_modules/@workflow-code'), { recursive: true });
    await symlink(await realpath(path.join(original, 'node_modules/workflow-code')), path.join(folder, 'node_modules/workflow-code'), 'dir');
    await symlink(cli, path.join(folder, 'node_modules/@workflow-code/cli'), 'dir');
    const manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
    const data = path.join(storageDir, createHash('sha256').update(folder).digest('hex').slice(0, 24));
    const kv = core.createWorkflowKVContext({ projectId: manifest.id, store: core.createLocalWorkflowKVStore({ rootDir: path.join(data, 'kv') }) });
    const values = core.createWorkflowPersistentValueContext({ projectId: manifest.id,
      store: core.createLocalWorkflowKVStore({ rootDir: path.join(data, 'values'), storageKind: 'persistent_value' }) });
    const document = await core.createKnowledgeDocument({ persistentValue: values }, { title: `${type} guide`, markdown: `# ${type} guide\n\nExact resource content.\n\n- Accessible preview` });
    projects.push({ folder, manifest, data, kv, document });
  }
  const [conversation, board] = projects;
  const serverProjectId = conversation.manifest.workflowCode.projectInfo.relatedProjects?.find(project => project.alias === 'database')?.projectId ?? 'foreign-server-project';
  const serverDocumentId = 'delta-force-harmonica-speedrun-1';
  await conversation.kv.setValue('card.value', { enabled: true, count: 7 });
  await board.kv.setValue('studio-kanban:tasks', [{ id: 'preview-task', title: 'Saved map marker', description: 'Card preview evidence',
    status: 'todo', priority: 'high', label: 'design' }]);
  const configuration = { id: 'named-map', name: 'Saved configuration', values: { title: 'Saved map', priority: 'all', labels: '["design"]', showCompleted: 'true' } };
  await writeFile(path.join(board.data, 'kanban.json'), JSON.stringify({ version: 1, revision: 0, configurations: [configuration], activeConfigurationId: configuration.id }));
  await writeFile(path.join(conversation.folder, 'result.txt'), 'Card source file');
  const tool = (id, kind, target, title, extra = {}) => ({ id, contentType: 'json', collapsed: true,
    metadata: { kind: 'agent-part', partType: 'tool' }, content: { tool: kind === 'knowledge' ? 'kb_get_document' : 'resource_tool', status: 'success',
      input: { documentId: target.documentId, key: target.key }, output: { details: { resourceCard: { ...(id.startsWith('server-') ? {} : { cardId: id }), kind, title, target, ...extra } } } } });
  const longTitle = 'Shared knowledge guide: ' + 'resource title with complete readable content '.repeat(5);
  const items = [
    tool('local-doc', 'knowledge', { source: 'local', projectId: conversation.manifest.id, documentId: conversation.document.id }, 'Local guide'),
    tool('server-doc', 'knowledge', { source: 'server', projectId: serverProjectId, documentId: serverDocumentId }, longTitle),
    { ...tool('server-list', 'knowledge', { source: 'server', projectId: serverProjectId }), content: {
      tool: 'kb_list_documents', status: 'success', input: { pageSize: 20 },
      output: { details: { resourceCard: { kind: 'knowledge', operation: 'read', target: { source: 'server', projectId: serverProjectId } } } },
    } },
    tool('local-kv', 'kv', { source: 'local', projectId: conversation.manifest.id, key: 'card.value', scope: 'project' }, 'card.value'),
    tool('foreign-local', 'knowledge', { source: 'local', projectId: board.manifest.id, documentId: board.document.id }, 'Imported project guide'),
    tool('map', 'kanban', { source: 'local', projectId: board.manifest.id, configurationId: 'named-map' }, 'Temporary map',
      { preview: true, kanban: { mode: 'preview', values: { title: 'Temporary card map' } } }),
    tool('project', 'project', { source: 'local', projectId: board.manifest.id }, 'Open board project'),
    tool('blocked', 'knowledge', { source: 'server', projectId: 'denied-project', documentId: 'private' }, 'Restricted guide'),
    { id: 'main-answer', contentType: 'markdown', content: '## Main answer\n\nThe answer stays in the conversation.', metadata: { finishReason: 'stop', usage: { totalTokens: 3 } } },
  ];
  const session = { id: 'card-session', title: 'Resource cards', createdAt: Date.now(), updatedAt: Date.now(), parameterValues: {},
    queuedInputs: [], draft: { text: '', attachments: [] }, messages: [{ id: 'card-message', role: 'assistant', content: '', status: 'success', items }] };
  await mkdir(conversation.data, { recursive: true });
  await writeFile(path.join(conversation.data, 'conversations.json'), JSON.stringify({ activeId: session.id, sessions: [session] }));
  const workspace = path.join(directory, 'cards.code-workspace');
  await writeFile(workspace, JSON.stringify({ folders: projects.map(project => ({ path: project.folder })) }));
  const requests = [];
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const address = new URL(request.url, 'http://fixture');
    const success = data => response.end(JSON.stringify({ errCode: 0, data }));
    if (address.pathname === '/api/auth/login') { request.resume(); success({ authenticated: true, accessToken: 'offline-card-identity', apiKey: { id: 'card-key' } }); return; }
    if (request.headers.authorization !== 'Bearer offline-card-identity') { response.writeHead(401); response.end('{}'); return; }
    requests.push(address.pathname);
    if (address.pathname === '/api/auth/me') { success({ profile: { userId: 'card-user', email: 'cards@example.com', displayName: 'Card Test' },
      principal: { apiKeyId: 'card-key', expiresAt: '2030-01-01T00:00:00Z' } }); return; }
    if (address.pathname === '/api/auth/logout') { request.resume(); success({}); return; }
    if (address.pathname.includes('/denied-project/')) { response.writeHead(403); response.end(JSON.stringify({ errCode: 403, errMessage: 'Permission denied.' })); return; }
    if (address.pathname.endsWith(`/knowledge-documents/${serverDocumentId}`)) { success({ id: serverDocumentId, title: 'Shared server guide', markdown: '# Shared server guide\n\nForeign project permission verified.' }); return; }
    if (address.pathname.endsWith('/knowledge-documents/search')) { success({ matches: [{ documentId: serverDocumentId, title: 'Shared server guide', lineNumber: 3, line: 'Foreign project permission verified.' }], totalMatches: 1, hasMore: false }); return; }
    if (address.pathname.endsWith('/knowledge-documents')) { success({ items: [{ id: serverDocumentId, title: 'Shared server guide', markdownPreview: 'Foreign project' }], total: 1, hasMore: false }); return; }
    response.writeHead(404); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const debug = createServer(); await new Promise(resolve => debug.listen(0, '127.0.0.1', resolve));
  const port = debug.address().port; await new Promise(resolve => debug.close(resolve));
  const log = await open(path.join(proofDir, `${language}.log`), 'w');
  const desktop = await desktopLocaleLaunch(language, directory);
  const child = spawn(desktop.executable, [...desktop.args, '--user-data-dir', dataDir, '--extensions-dir', path.join(root, '.studio/desktop-extensions'),
    `--locale=${language}`, '--disable-workspace-trust', '--disable-telemetry', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${port}`, workspace],
  { cwd: path.join(root, 'upstream/vscode'), env: { ...process.env, ...desktop.env, WORKFLOW_SERVER_URL: '', WORKFLOW_SERVER_ADMIN_KEY: '' }, stdio: ['ignore', log.fd, log.fd] });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  let browser, page;
  const proof = { language, cliVersion, projectId: conversation.manifest.id, serverProjectId, checks: [], screenshots: [], errors: [] };
  async function command(name) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.bringToFront(); await page.locator('.part.titlebar').click({ position: { x: 200, y: 5 } });
        await page.locator('.part.editor .editor-group-container').first().focus(); await page.keyboard.press('F1');
        await page.locator('.quick-input-widget input').fill(`>${name}`, { timeout: 3000 });
        await page.locator('.quick-input-widget .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: name }) }).first().click({ timeout: 3000 });
        await page.locator('.quick-input-widget').waitFor({ state: 'hidden' }); return;
      } catch (error) { if (attempt === 2) { throw error; } await page.keyboard.press('Escape'); }
    }
  }
  async function frameFor(selector, target = page) {
    for (let attempt = 0; attempt < 250; attempt++) {
      for (const frame of target.frames()) {
        if (frame.isDetached() || !await frame.locator(selector).first().isVisible().catch(() => false)) { continue; }
        let current = frame, visible = true;
        while (current.parentFrame()) { if (!await (await current.frameElement()).isVisible()) { visible = false; break; } current = current.parentFrame(); }
        if (visible) { return frame; }
      }
      await pause(100);
    }
    throw new Error(`Frame unavailable: ${selector}`);
  }
  async function screenshot(name) { const filename = `${language}-${name}.png`; await page.screenshot({ path: path.join(proofDir, filename) }); proof.screenshots.push(filename); }
  async function layout(frame) {
    const bounds = await frame.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll('.resource-card')].map(element => {
        const rect = element.getBoundingClientRect(), parent = element.parentElement.getBoundingClientRect();
        const buttons = [...element.querySelectorAll('.resource-card-row button')].map(button => button.getBoundingClientRect());
        return { width: rect.width, parent: parent.width, right: rect.right, titleSpace: element.querySelector('.resource-target').getBoundingClientRect().width - 34,
          overlap: buttons.some((button, i) => buttons.slice(i + 1).some(other => button.left < other.right && button.right > other.left && button.top < other.bottom && button.bottom > other.top)) };
      }) }));
    assert.ok(bounds.width <= bounds.viewport && bounds.cards.every(card => Math.abs(card.width - card.parent) < 2 && card.right <= bounds.viewport && !card.overlap
      && card.titleSpace >= Math.min(100, card.width - 64)), JSON.stringify(bounds));
  }
  try {
    for (let attempt = 0; attempt < 250; attempt++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { break; } } catch {} if (child.exitCode !== null) { throw new Error('Studio exited before startup.'); } await pause(100); }
    await desktop.waitUntilReady(child);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    for (let attempt = 0; attempt < 100; attempt++) { page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('workbench')); if (page) { break; } await pause(100); }
    assert.ok(page); page.setDefaultTimeout(20_000); page.on('pageerror', error => proof.errors.push(error.message)); await page.setViewportSize({ width: 1440, height: 1000 });
    await command(`Workflow: ${catalog['command.openWorkflowDemo']}`);
    let conversationFrame = await frameFor('body[data-surface=editor] #message');
    await conversationFrame.locator('.resource-card').nth(7).waitFor();
    assert.equal(await conversationFrame.locator('.resource-card').count(), 8);
    assert.equal(await conversationFrame.locator('.agent-activity-item').count(), 0);
    assert.equal(await conversationFrame.locator('.message-output > .message-content h2').innerText(), 'Main answer');
    await layout(conversationFrame); await screenshot('cards-light');
    const card = id => {
      const descriptor = items.find(item => item.id === id).content.output.details.resourceCard;
      const cardId = descriptor.cardId ?? `${descriptor.kind}:${JSON.stringify(descriptor.target)}`;
      return conversationFrame.locator(`.resource-card[data-card-id=${JSON.stringify(cardId)}]`);
    };
    await card('local-doc').locator('[data-action=inline]').click();
    await card('local-doc').frameLocator('iframe').locator('.markdown h1').filter({ hasText: 'conversation guide' }).waitFor();
    await card('local-kv').locator('[data-action=inline]').click();
    await card('local-kv').frameLocator('iframe').locator('pre').filter({ hasText: '"count": 7' }).waitFor();
    await card('foreign-local').locator('[data-action=inline]').click();
    await card('foreign-local').frameLocator('iframe').locator('.markdown h1').filter({ hasText: 'kanban guide' }).waitFor();
    await card('local-doc').locator('.codicon-info').click();
    await card('local-doc').locator('.resource-call-details').filter({ hasText: 'kb_get_document' }).waitFor();
    await card('local-doc').locator('.codicon-info').click();
    proof.checks.push('successful resource tools render directly as full-width cards; main answers stay flat; local and imported resources preview with retained call details');
    await card('map').frameLocator('.resource-inline > iframe').frameLocator('.resource-preview-content > iframe').locator('.task h3').filter({ hasText: 'Saved map marker' }).waitFor();
    const map = card('map').frameLocator('.resource-inline > iframe').frameLocator('.resource-preview-content > iframe');
    assert.equal(await map.locator('#board-title').innerText(), 'Temporary card map');
    assert.equal(JSON.parse(await readFile(path.join(board.data, 'kanban.json'), 'utf8')).configurations[0].values.title, 'Saved map');
    await card('map').scrollIntoViewIfNeeded(); await screenshot('kanban-inline');
    proof.checks.push('the actual Kanban artifact renders tasks using the named configuration and temporary parameters without overwriting saved configuration');
    await command(`Workflow: ${catalog['command.openWorkflowAccount']}`);
    const account = await frameFor('#account-app'); await account.locator('#server-url').fill(serverUrl);
    await account.locator('#login-email').fill('cards@example.com'); await account.locator('#login-password').fill('offline-password'); await account.locator('#login-submit').click();
    await account.locator('#display-name').filter({ hasText: 'Card Test' }).waitFor();
    await page.getByRole('tab', { name: conversation.manifest.workflowCode.projectInfo.localizedNames[language === 'en' ? 'en' : 'zh-CN'], exact: true }).click();
    conversationFrame = await frameFor('body[data-surface=editor] #message');
    await card('server-doc').locator('[data-action=inline]').click();
    await card('server-doc').frameLocator('iframe').locator('.markdown h1').filter({ hasText: 'Shared server guide' }).waitFor();
    await card('server-list').locator('[data-action=inline]').click();
    await card('server-list').frameLocator('iframe').locator('.resource-preview-list button').filter({ hasText: 'Shared server guide' }).waitFor();
    await card('blocked').locator('[data-action=inline]').click();
    await card('blocked').locator('.resource-inline[role=alert]').filter({ hasText: 'Permission denied.' }).waitFor();
    await screenshot('server-preview');
    await card('server-list').locator('.resource-target').click();
    const knowledge = await frameFor('body[data-resource-kind=knowledge]');
    await knowledge.locator('.resource-row').filter({ hasText: 'Shared server guide' }).waitFor();
    await card('server-doc').locator('.resource-target').click();
    await knowledge.locator('#resource-detail .markdown-body h1').filter({ hasText: 'Shared server guide' }).waitFor();
    assert.equal(await knowledge.locator('#resource-source').inputValue(), 'server');
    assert.equal(await knowledge.locator('#resource-new').isVisible(), false);
    assert.equal(await knowledge.locator('#detail-delete').count(), 0);
    await knowledge.locator('#resource-search').fill('Foreign'); await knowledge.locator('.resource-row').filter({ hasText: 'permission verified' }).waitFor();
    proof.checks.push('automatic cards without explicit cardId open the authorized foreign Server knowledge list and exact read-only document; inline preview, search and permission denial work');
    await card('foreign-local').locator('.resource-target').click();
    await knowledge.locator('#resource-detail .markdown-body h1').filter({ hasText: 'kanban guide' }).waitFor();
    assert.equal(await knowledge.locator('#resource-new').isVisible(), false);
    assert.equal(await knowledge.locator('#detail-delete').count(), 0);
    await card('local-doc').locator('.resource-target').click();
    await knowledge.locator('#resource-detail .markdown-body h1').filter({ hasText: 'conversation guide' }).waitFor();
    assert.equal(await knowledge.locator('#resource-new').isVisible(), true);
    assert.equal(await knowledge.locator('#detail-delete').count(), 1);
    proof.checks.push('cards for other already opened local projects stay read-only; returning to the owner project restores its native edit controls');
    await command('View: Toggle Panel');
    await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await readFile(settingsPath, 'utf8')), 'workbench.colorTheme': 'Dark Modern' }));
    await conversationFrame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    for (const id of ['local-doc', 'local-kv', 'foreign-local', 'map', 'server-doc', 'server-list']) {
      await card(id).frameLocator('.resource-inline > iframe').locator('html[data-theme=dark]').waitFor();
    }
    await page.setViewportSize({ width: 650, height: 850 }); await layout(conversationFrame);
    await card('server-doc').scrollIntoViewIfNeeded(); await screenshot('cards-narrow-dark');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const before = new Set(browser.contexts()[0].pages());
    await card('local-doc').locator('[data-action=window]').click();
    let separate;
    for (let attempt = 0; attempt < 250; attempt++) { separate = browser.contexts()[0].pages().find(candidate => !before.has(candidate) && !candidate.isClosed()); if (separate) { break; } await pause(100); }
    assert.ok(separate, 'Resource action opens a real auxiliary VS Code window');
    const preview = await frameFor('.resource-preview-app', separate);
    await preview.locator('.markdown h1').filter({ hasText: 'conversation guide' }).waitFor();
    await separate.screenshot({ path: path.join(proofDir, `${language}-new-window.png`) }); proof.screenshots.push(`${language}-new-window.png`);
    await separate.close(); await page.bringToFront();
    await card('map').locator('.codicon-folder-opened').click();
    const boardFrame = await frameFor('#kanban-title');
    await boardFrame.frameLocator('#kanban-preview').locator('.task h3').filter({ hasText: 'Saved map marker' }).waitFor();
    assert.equal(await boardFrame.locator('#workflow-param-title').inputValue(), 'Saved map');
    proof.checks.push('wide and narrow themes preserve card layout; separate preview uses a real VS Code window; Open Project navigates to the target board with its saved configuration');
    await page.getByRole('tab', { name: conversation.manifest.workflowCode.projectInfo.localizedNames[language === 'en' ? 'en' : 'zh-CN'], exact: true }).click();
    conversationFrame = await frameFor('body[data-surface=editor] #message');
    const serverPreview = card('server-doc').frameLocator('.resource-inline > iframe');
    await serverPreview.locator('.markdown h1').filter({ hasText: 'Shared server guide' }).waitFor();
    await command(`Workflow: ${catalog['command.logoutWorkflow']}`);
    await serverPreview.locator('.resource-preview-status[role=alert]').waitFor();
    assert.equal(await serverPreview.locator('.resource-preview-content').innerText(), '');
    await command(`Workflow: ${catalog['command.openAssistant']}`);
    const assistant = await frameFor('body[data-surface=assistant] #parameter-login');
    const feedback = await assistant.evaluate(() => {
      const error = document.querySelector('#parameter-error').getBoundingClientRect(), login = document.querySelector('#parameter-login').getBoundingClientRect();
      return { viewport: innerWidth, width: document.documentElement.scrollWidth, errorWidth: error.width, errorRight: error.right, loginRight: login.right,
        overlap: error.left < login.right && error.right > login.left && error.top < login.bottom && error.bottom > login.top };
    });
    assert.ok(feedback.width <= feedback.viewport && feedback.errorWidth >= Math.min(100, feedback.viewport - 32)
      && feedback.errorRight <= feedback.viewport && feedback.loginRight <= feedback.viewport && !feedback.overlap, JSON.stringify(feedback));
    await screenshot('signed-out-preview');
    proof.checks.push('signing out invalidates an already rendered Server preview and clears the previous account content');
    proof.checks.push('sign-in feedback and actions remain readable without overlap in the narrow Assistant sidebar');
    assert.ok(requests.some(address => address.includes(`/${serverProjectId}/knowledge-documents/${serverDocumentId}`)));
    assert.deepEqual(proof.errors, []);
    await writeFile(path.join(proofDir, `${language}-proof.json`), `${JSON.stringify(proof, null, 2)}\n`); console.log(JSON.stringify(proof));
  } catch (error) {
    if (page) { await screenshot('failed'); console.error(JSON.stringify({ checks: proof.checks, errors: proof.errors,
      frames: await Promise.all(page.frames().filter(frame => !frame.isDetached()).map(async frame => ({ url: frame.url(),
        preview: await frame.locator('.resource-preview-app').count() ? await frame.locator('.resource-preview-app').innerText() : undefined }))),
      windows: browser?.contexts()[0].pages().map(window => ({ url: window.url(), frames: window.frames().map(frame => frame.url()) })) })); }
    throw error;
  } finally {
    await browser?.close(); if (child.exitCode === null) { child.kill('SIGTERM'); } await Promise.race([exited, pause(10_000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } await log.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
