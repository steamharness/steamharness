import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-browser-open.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode', '@vscode/l10n'], write: false });
const chinese = JSON.parse(await readFile('extensions/studio-workstation/l10n/bundle.l10n.zh-cn.json', 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (url = 'https://raw.communitydragon.org/', requestId = 'open-1') => ({ type: 'workflow-browser-open', version: 1, requestId, url });

function fixture({ preference, language = 'en', commands = ['workbench.action.browser.open', 'simpleBrowser.show'], externalResult = true, commandError } = {}) {
  const module = { exports: {} }, calls = [], external = [], replies = [], inspected = [];
  const values = { global: preference, workspace: 'external' };
  const vscode = {
    workspace: { getConfiguration: () => ({ inspect: key => {
      inspected.push(key); return { defaultValue: 'internal', globalValue: values.global, workspaceValue: values.workspace };
    } }) },
    Uri: { parse: value => ({ toString: () => value }) },
    env: { openExternal: async uri => { external.push(uri.toString()); return externalResult; } },
    commands: { getCommands: async () => commands, executeCommand: async (...args) => {
      calls.push(args); if (commandError) throw new Error(commandError);
    } },
  };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, URL, Error,
    require: name => name === 'vscode' ? vscode : name === '@vscode/l10n' ? {
      t: (message, ...args) => (language.startsWith('zh') ? chinese[message] ?? message : message)
        .replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)])),
    } : require(name),
  });
  const binding = module.exports.bindProjectBrowserOpen({ postMessage: async message => { replies.push(message); } });
  return { ...module.exports, binding, values, calls, external, replies, inspected };
}

test('website links default to the integrated browser and ignore a workspace override', async () => {
  const f = fixture(); f.binding.receive(request()); await tick();
  assert.deepEqual(f.calls, [['workbench.action.browser.open', 'https://raw.communitydragon.org/']]);
  assert.equal(f.external.length, 0); assert.deepEqual(f.inspected, ['studio.browser.linkTarget']);
  assert.equal(f.replies[0].browserOpened.error, undefined);
});

test('switching the user preference affects the next click and external mode uses the system browser', async () => {
  const f = fixture(); await f.openBrowserLink('https://example.com/first');
  f.values.global = 'external'; await f.openBrowserLink('https://example.com/next');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.external, ['https://example.com/next']);
  f.values.global = undefined; await f.openBrowserLink('https://example.com/reset');
  assert.equal(f.calls.length, 2); assert.equal(f.external.length, 1);
});

test('the simple browser remains available when the integrated browser command is missing', async () => {
  const f = fixture({ commands: ['simpleBrowser.show'] }); await f.openBrowserLink('http://localhost:3000/');
  assert.deepEqual(f.calls, [['simpleBrowser.show', 'http://localhost:3000/']]); assert.equal(f.external.length, 0);
});

for (const url of ['file:///tmp/report.md', 'command:workbench.action.closeWindow', 'javascript:alert(1)', 'data:text/html,hello',
  'raw.communitydragon.org', 'https://example.com/a\nfile']) {
  test(`the browser host rejects a non-HTTP or invalid address: ${JSON.stringify(url)}`, async () => {
    const f = fixture(); f.binding.receive(request(url)); await tick();
    assert.equal(f.calls.length, 0); assert.equal(f.external.length, 0);
    assert.match(f.replies[0].browserOpened.error, /Only HTTP and HTTPS/);
  });
}

for (const language of ['en', 'zh-cn']) test(`${language} website errors reach the requesting page`, async () => {
  const f = fixture({ language, preference: 'external', externalResult: false });
  f.binding.receive(request()); await tick();
  assert.match(f.replies[0].browserOpened.error, language === 'en' ? /Unable to open the website.*system browser/ : /无法打开网页.*系统浏览器/);
  const failed = fixture({ language, commandError: 'Browser unavailable' }); failed.binding.receive(request()); await tick();
  assert.match(failed.replies[0].browserOpened.error, language === 'en' ? /Unable to open the website: Browser unavailable/ : /无法打开网页：Browser unavailable/);
});

test('browser requests validate identity, suppress duplicate pending opens and stop replying after disposal', async () => {
  const f = fixture();
  assert.equal(f.binding.receive({ ...request(), version: 2 }), false);
  assert.equal(f.binding.receive({ ...request(), requestId: '' }), false);
  assert.equal(f.binding.receive(request()), true); assert.equal(f.binding.receive(request()), true);
  await tick(); assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 1);
  assert.equal(f.binding.receive(request('https://example.com/', 'open-2')), true);
  f.binding.dispose(); await tick(); assert.equal(f.replies.length, 1);
  assert.equal(f.binding.receive(request('https://example.com/', 'open-3')), false);
});

test('the contributed browser preference has an internal default and localized option labels', async () => {
  const manifest = JSON.parse(await readFile('extensions/studio-workstation/package.json', 'utf8'));
  const property = manifest.contributes.configuration.properties['studio.browser.linkTarget'];
  assert.equal(property.default, 'internal'); assert.equal(property.scope, 'application');
  assert.deepEqual(property.enum, ['internal', 'external']);
  for (const language of ['', '.zh-cn']) {
    const labels = JSON.parse(await readFile(`extensions/studio-workstation/package.nls${language}.json`, 'utf8'));
    for (const token of [property.description, ...property.enumItemLabels]) assert.ok(labels[token.slice(1, -1)]);
  }
});
