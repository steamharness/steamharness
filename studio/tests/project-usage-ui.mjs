import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../upstream/vscode/node_modules/playwright/index.mjs';

const kernel = fileURLToPath(new URL('../upstream/vscode/', import.meta.url));
const codicons = fileURLToPath(new URL('../node_modules/@vscode/codicons/dist/codicon.css', import.meta.url));
const bundle = await build({ stdin: { resolveDir: kernel, sourcefile: 'usage-fixture.ts', contents: `
  export { StudioStartView } from './src/vs/workbench/browser/parts/editor/studioStart.ts';
  export { StudioLaunchpadView } from './src/vs/workbench/browser/studioLaunchpadView.ts';
  export { projectUsageBridge } from './src/vs/workbench/browser/studioProjectUsage.ts';
  export { InMemoryStorageService } from './src/vs/platform/storage/common/storage.ts';
  import ${JSON.stringify(codicons)};
  import './src/vs/workbench/browser/media/studioLaunchpad.css';` },
  bundle: true, platform: 'browser', format: 'iife', globalName: 'usageFixture', write: false, outdir: 'unused', loader: { '.ttf': 'dataurl', '.woff2': 'dataurl' } });
const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const styles = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;

const browser = await chromium.launch({ headless: true, executablePath: process.env.STUDIO_START_TEST_BROWSER_PATH || undefined });
try {
  for (const [language, light] of [['en', false], ['zh-cn', true]]) {
    const zh = language === 'zh-cn';
    const page = await browser.newPage({ viewport: { width: 1120, height: 840 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<style>
      :root { --vscode-foreground: ${light ? '#222' : '#ddd'}; --vscode-descriptionForeground: ${light ? '#555' : '#aaa'};
        --vscode-editor-background: ${light ? '#fff' : '#1f1f1f'}; --vscode-sideBar-background: ${light ? '#f6f6f6' : '#252526'};
        --vscode-panel-border: ${light ? '#ddd' : '#393939'}; --vscode-widget-border: ${light ? '#d0d4d9' : '#4a4d54'};
        --vscode-focusBorder: #007acc; --vscode-button-background: #006ab1; }
      body { margin: 0; } .monaco-workbench { position: fixed; inset: 0; overflow: auto; background: var(--vscode-editor-background); }
      .studio-launchpad { position: fixed; inset: 0; } #overview { height: 100%; }
      </style><div class="monaco-workbench ${light ? 'vs' : 'vs-dark'}"><div id="launchpad"></div><div id="overview" hidden></div></div>`);
    await page.evaluate(value => { window._VSCODE_NLS_LANGUAGE = value; }, language);
    await page.addStyleTag({ content: styles });
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      const { StudioLaunchpadView, StudioStartView, projectUsageBridge, InMemoryStorageService } = window.usageFixture;
      const projects = ['Aggregate', 'Other'].map(name => ({ name, kind: 'folder', uri: `file:///${name}`, path: `/${name}`, distribution: 'source',
        projectId: name, version: '1.2.3', entries: [{ entryId: 'agent', type: 'bot', name: 'Agent', primary: true }] }));
      const assistant = { name: 'Project Assistant', kind: 'folder', uri: 'file:///Assistant', path: '/Assistant', distribution: 'release', builtin: true,
        projectId: 'a3aca697-b086-459b-84e4-d357ad2d9fb2', entries: [{ entryId: 'main', type: 'bot', name: 'Assistant', primary: true },
          { entryId: 'studio-control', type: 'workflow', name: 'Studio Control' }] };
      const requests = window.requests = [], cancelled = window.cancelled = [], clipboard = window.clipboard = [];
      const commands = { async executeCommand(command, arg) {
        if (command !== 'studio.internalProjectUsage') return;
        if (arg.cancel) { cancelled.push(arg.id); return; }
        return new Promise((resolve, reject) => requests.push({ ...arg, resolve, reject }));
      } };
      const clip = { async writeText(value) { clipboard.push(value); } };
      const storage = new InMemoryStorageService();
      const memoryPath = window.memoryPath = '/support/Studio/runtime/' + 'directory-'.repeat(12) + '/memory.sqlite';
      window.resolveUsage = (uri, bytes, parts = ['runtime', 'directory'], directoryState = 'ok') => {
        for (const reading of requests.filter(item => !item.done && item.uri === uri && parts.includes(item.part))) {
          reading.done = true;
          const usage = reading.part === 'directory' ? { state: directoryState, bytes, path: '/Aggregate', files: 1200, directories: 11,
            folders: Array.from({ length: 10 }, (_, i) => ({ name: `folder-${i + 1}`, state: 'ok', bytes: (10 - i) * 1024 })) } : {
            state: 'partial', size: { state: 'ok', bytes: 225280 }, location: '/support/Studio', entries: [
              { entryId: 'agent', name: 'Agent', type: 'bot', conversation: { state: 'ok', bytes: 24576, sessions: 3, messages: 21 },
                memory: { state: 'ok', bytes: 24576, records: 1, location: memoryPath, created: true } },
              { entryId: 'workflow', name: 'Workflow A', type: 'workflow', workflow: { state: 'ok', bytes: 1024, runs: 9, lastRunAt: 1700000000000 } },
              { entryId: 'board', name: 'Board', type: 'kanban', kanban: { state: 'ok', bytes: 12288, location: '/Aggregate/board/dist' } },
              { entryId: 'remote', name: 'Hosted', type: 'kanban', kanban: { state: 'hosted' } },
              { entryId: 'shared', name: 'Shared', type: 'kanban', kanban: { state: 'shared' } },
              { entryId: 'unbuilt', name: 'Unbuilt', type: 'kanban', kanban: { state: 'unbuilt' } },
            ] };
          reading.resolve({ part: reading.part, usage, measuredAt: Date.now() });
        }
      };
      window.failUsage = uri => {
        for (const reading of requests.filter(item => !item.done && item.uri === uri)) {
          reading.done = true;
          if (reading.part === 'directory') {
            reading.resolve({ part: reading.part, usage: { state: 'unavailable', folders: [] }, measuredAt: Date.now() });
          } else { reading.reject(new Error('Extension host unavailable')); }
        }
      };
      const view = new StudioLaunchpadView(window._VSCODE_NLS_LANGUAGE, { usage: projectUsageBridge(commands, clip, storage),
        hoverService: { setupDelayedHover: () => ({ dispose() {} }) } });
      const state = { recent: projects, windows: [], canCreate: false, platform: false, notices: [], notificationUnread: false };
      document.getElementById('launchpad').append(view.element);
      view.update(state);
      window.view = view;
      window.updateWindowState = () => view.update({ ...state, windows: [{ ...projects[0], windowId: 5 }] });
      window.showOverview = () => {
        view.dispose(); view.element.remove();
        const host = document.getElementById('overview');
        host.hidden = false;
        const project = { ...projects[0], folderPath: projects[0].path, defaultEntry: 'agent', projectType: 'bot',
          entries: projects[0].entries.map(entry => ({ ...entry, available: true, projectType: entry.type })) };
        const service = { state: { version: 1, labels: { overview: 'Overview' }, recent: [], pending: [], hasWorkspace: true, projects: [project] },
          onDidChange: () => ({ dispose() {} }), setVisible() {} };
        window.overview = new StudioStartView(host, service, commands, clip, storage);
      };
      window.showCredentialFixture = () => {
        document.getElementById('overview').hidden = true;
        const requests = window.credentialRequests = [];
        const zh = window._VSCODE_NLS_LANGUAGE === 'zh-cn';
        const folderBot = { uri: 'file:///FolderBot.code-workspace', kind: 'workspace', name: 'Folder Bot', path: '/projects/Folder Bot',
          projectType: 'bot', managed: true, entries: [assistant.entries[0]] };
        const library = new StudioLaunchpadView(window._VSCODE_NLS_LANGUAGE, {
          hoverService: { setupDelayedHover: () => ({ dispose() {} }) },
          openBotArtifacts: () => {}, openBotMemory: () => {},
          detailActions: async (project, source) => project.uri === folderBot.uri ? (source === 'local' ? [
            ['profile', zh ? '分身档案…' : 'Profile…', 'settings-gear'], ['clone', zh ? '复制分身…' : 'Clone…', 'copy'],
            ['export', zh ? '导出模板…' : 'Export template…', 'export'], ['import', zh ? '导入模板…' : 'Import template…', 'cloud-upload'],
          ] : [['contact', zh ? '添加到 IM 通讯录' : 'Add to IM contacts', 'comment-discussion']])
            .map(([id, label, icon]) => ({ id, label, icon })) : undefined,
          readBotCredentials: async (project, entryId) => {
            requests.push([project.uri, entryId]);
            return { status: 'ok', rows: [{ name: 'fixture-credential-' + 'long-'.repeat(8), type: zh ? '结构化凭据' : 'Structured credential' }] };
          },
        });
        document.getElementById('launchpad').append(library.element);
        library.update({ ...state, platform: true, account: { signedIn: true }, recent: [folderBot], builtinProjects: [assistant] });
        library.select('library', assistant.uri);
        window.showManagedActions = () => library.select('library', folderBot.uri);
      };
    });
    assert.equal(await page.locator('.lp-project-usage').count(), 0);
    await page.evaluate(() => window.view.select('library', 'file:///Aggregate'));
    const panel = page.locator('.lp-project-usage');
    await panel.getByRole('heading', { name: zh ? '本机用量' : 'Local usage' }).waitFor();
    assert.equal(await panel.evaluate(element => element.nextElementSibling.className), 'lp-detail-entries');
    const status = panel.getByRole('status');
    assert.equal(await status.textContent(), zh ? '正在统计…' : 'Measuring…');
    await page.waitForFunction(() => window.requests.length === 2);
    await page.evaluate(() => window.resolveUsage('file:///Aggregate', 4096, ['runtime']));
    await panel.getByText('24 KiB', { exact: true }).first().waitFor();
    assert.match(await panel.innerText(), zh ? /3 个会话 · 21 条消息/u : /3 sessions · 21 messages/u);
    await page.evaluate(() => window.resolveUsage('file:///Aggregate', 4096, ['directory'], 'partial'));
    const workingSize = panel.locator('.lp-usage-metric').first();
    await workingSize.getByText('≥ 4 KiB', { exact: true }).waitFor();
    const folders = panel.locator('details').first();
    await folders.locator('summary').click();
    assert.equal(await folders.locator('.lp-usage-folders dt').count(), 8);
    await folders.getByRole('button', { name: zh ? '显示全部' : 'Show all' }).click();
    assert.equal(await folders.locator('.lp-usage-folders dt').count(), 10);
    const entries = panel.locator('details').last();
    await entries.locator('summary').click();
    await entries.getByRole('button', { name: zh ? '复制路径: 记忆数据库' : 'Copy path: Memory database' }).click();
    assert.deepEqual(await page.evaluate(() => window.clipboard), [await page.evaluate(() => window.memoryPath)]);
    for (const label of zh ? ['托管数据未统计', '共用目录', '未构建'] : ['Hosted data excluded', 'Shared directory', 'Not built']) {
      assert.equal(await entries.getByText(label, { exact: true }).isVisible(), true);
    }
    await page.evaluate(() => { window.finishedUsage = document.querySelector('.lp-project-usage'); window.updateWindowState(); });
    assert.equal(await panel.evaluate(element => element === window.finishedUsage && element.querySelector('details').open), true);
    const refresh = panel.getByRole('button', { name: zh ? '刷新用量' : 'Refresh usage' });
    await refresh.click();
    assert.equal(await refresh.getAttribute('aria-disabled'), 'true');
    assert.equal(await workingSize.getByText('≥ 4 KiB', { exact: true }).isVisible(), true);
    await page.evaluate(() => {
      window.view.select('library', 'file:///Other');
      window.resolveUsage('file:///Aggregate', 65536);
    });
    assert.equal(await workingSize.locator('.lp-usage-value').textContent(), '—');
    assert.equal(await page.evaluate(() => window.cancelled.length), 2);
    await page.waitForFunction(() => window.requests.length === 6);
    await page.evaluate(() => window.view.select('profile'));
    assert.equal(await page.evaluate(() => window.cancelled.length), 4);

    // Reopening within the old freshness window renders the partial snapshot synchronously,
    // but starts a real refresh. Neither cancelled nor unavailable results replace it.
    await page.evaluate(() => window.view.select('library', 'file:///Aggregate'));
    assert.equal(await status.textContent(), zh ? '正在更新…' : 'Updating…');
    assert.equal(await workingSize.locator('.lp-usage-value').textContent(), '≥ 4 KiB');
    assert.equal(await panel.getByText('24 KiB', { exact: true }).first().isVisible(), true);
    await page.waitForFunction(() => window.requests.length === 8);
    await page.evaluate(() => window.failUsage('file:///Aggregate'));
    await status.getByText(zh ? '更新失败，显示上次结果' : 'Update failed; showing previous data', { exact: true }).waitFor();
    assert.equal(await workingSize.locator('.lp-usage-value').textContent(), '≥ 4 KiB');
    assert.equal(await panel.getByText('24 KiB', { exact: true }).first().isVisible(), true);
    await page.setViewportSize({ width: 410, height: 840 });
    assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.setViewportSize({ width: 1120, height: 840 });

    await refresh.click();
    await page.evaluate(() => window.resolveUsage('file:///Aggregate', 8192));
    await page.waitForFunction(() => document.activeElement?.dataset.key?.endsWith(':refresh'));
    await workingSize.getByText('8 KiB', { exact: true }).waitFor();
    if (process.env.STUDIO_USAGE_SCREENSHOTS) await panel.screenshot({ path: `${process.env.STUDIO_USAGE_SCREENSHOTS}/usage-${language}.png` });
    await page.setViewportSize({ width: 410, height: 840 });
    assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);

    await page.evaluate(() => {
      window.view.select('profile');
      window.view.select('library', 'file:///Other');
      window.view.select('library', 'file:///Aggregate');
    });
    assert.equal(await workingSize.locator('.lp-usage-value').textContent(), '8 KiB');
    await page.waitForFunction(() => window.requests.length === 12);
    assert.deepEqual(await page.evaluate(() => window.requests.slice(-2).map(({ uri, refresh }) => [uri, refresh])),
      [['file:///Aggregate', true], ['file:///Aggregate', true]]);

    // An independent detail view/bridge reads the same saved profile values.
    await page.evaluate(() => window.showOverview());
    const overview = page.locator('#overview .lp-usage-metric').first();
    assert.equal(await overview.locator('.lp-usage-value').textContent(), '8 KiB');
    await page.waitForFunction(() => window.requests.length === 14);
    await page.evaluate(() => window.resolveUsage('file:///Aggregate', 16384));
    await overview.getByText('16 KiB', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.requests.every(({ refresh }) => refresh === true)), true);
    await page.setViewportSize({ width: 1120, height: 840 });
    await page.evaluate(() => window.showCredentialFixture());
    const credentialTitle = zh ? '凭据管理' : 'Credential management';
    const details = page.locator('.lp-project-details:visible');
    await details.getByRole('heading', { name: 'Project Assistant' }).waitFor();
    const management = details.getByRole('region', { name: zh ? 'Bot 管理' : 'Bot management', exact: true });
    const credentialButton = management.getByRole('button', { name: credentialTitle, exact: true });
    assert.equal(await page.evaluate(() => window.credentialRequests.length), 0);
    await credentialButton.click();
    const credentials = management.getByRole('region', { name: credentialTitle, exact: true });
    await credentials.getByRole('cell', { name: 'fixture-credential-' + 'long-'.repeat(8), exact: true }).waitFor();
    assert.deepEqual(await credentials.getByRole('columnheader').allTextContents(), zh ? ['别名', '类型'] : ['Alias', 'Type']);
    assert.ok(await credentials.getByRole('cell', { name: zh ? '结构化凭据' : 'Structured credential', exact: true }).isVisible());
    assert.equal(await credentials.locator('button,input,textarea').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.credentialRequests), [['file:///Assistant', 'main']]);
    await page.setViewportSize({ width: 410, height: 840 });
    assert.equal(await credentials.evaluate(panel => panel.scrollWidth <= panel.clientWidth + 1), true);
    await credentialButton.click();
    await credentials.waitFor({ state: 'detached' });

    await page.evaluate(() => window.showManagedActions());
    const actions = management.locator('.lp-detail-group-actions');
    await actions.locator('[data-detail-action=import]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await actions.count(), 1);
    assert.deepEqual(await actions.getByRole('button').allTextContents(), zh
      ? ['产物库', '记忆管理', '凭据管理', '分身档案…', '复制分身…', '导出模板…', '导入模板…']
      : ['Artifact library', 'Memory management', 'Credential management', 'Profile…', 'Clone…', 'Export template…', 'Import template…']);
    for (const width of [1440, 850, 410]) {
      await page.setViewportSize({ width, height: 840 });
      const layout = await management.evaluate(group => {
        const heading = group.querySelector('h2').getBoundingClientRect();
        const toolbar = group.querySelector('.lp-detail-group-actions');
        const controls = toolbar.getBoundingClientRect();
        const value = group.closest('article').querySelector('.lp-detail-facts dd').getBoundingClientRect();
        const buttons = [...toolbar.querySelectorAll('button')].map(button => button.getBoundingClientRect());
        const gap = parseFloat(getComputedStyle(toolbar).columnGap);
        const rows = new Map();
        const fits = buttons.every(rect => {
          if (!rows.has(rect.top)) rows.set(rect.top, rect.left);
          return rect.left >= controls.left - 1 && rect.right <= controls.right + 1;
        });
        const fitsOneRow = buttons.reduce((width, rect) => width + rect.width, (buttons.length - 1) * gap) <= controls.width;
        return { fits, rows: rows.size, leftAligned: [...rows.values()].every(left => Math.abs(left - controls.left) < 1),
          fitsOneRow, followsHeading: heading.bottom <= controls.top, alignsWithFacts: Math.abs(value.left - controls.left) < 1, sameTop: Math.abs(heading.top - controls.top) < 1 };
      });
      assert.ok(layout.fits && layout.leftAligned, JSON.stringify({ width, layout }));
      if (width === 410) assert.ok(layout.followsHeading && layout.rows > 1, JSON.stringify({ width, layout }));
      else assert.ok(layout.alignsWithFacts && layout.sameTop, JSON.stringify({ width, layout }));
      assert.equal(layout.rows === 1, layout.fitsOneRow, JSON.stringify({ width, layout }));
      if (process.env.STUDIO_USAGE_SCREENSHOTS) await details.screenshot({ path: `${process.env.STUDIO_USAGE_SCREENSHOTS}/detail-actions-${language}-${width}.png` });
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Project usage and credential list UI passed (${language}, ${light ? 'light' : 'dark'}, wide and 410px)`);
  }
} finally { await browser.close(); }
