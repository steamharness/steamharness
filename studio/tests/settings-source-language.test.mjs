import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { register } from 'tsx/esm/api';
import ts from 'typescript';

register();
const kernel = fileURLToPath(new URL('../upstream/vscode/', import.meta.url));
const { transpileFile, applyIncrementalClientChanges } = await import('../upstream/vscode/build/next/transpile.ts');
const require = createRequire(import.meta.url);
const runtime = await build({ stdin: { contents: `export * from './vs/nls'; export { resolveNLSConfiguration } from './vs/base/node/nls';`,
  resolveDir: path.join(kernel, 'src'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false });

const labels = [
  ['vs/workbench/contrib/search/browser/searchWidget', 'search.placeHolder', 'Search', '搜索'],
  ['vs/workbench/contrib/search/browser/searchWidget', 'search.replace.placeHolder', 'Replace', '替换'],
  ['vs/workbench/contrib/quickaccess/browser/quickAccess.contribution', 'commandPalette', 'Command Palette...', '命令面板...'],
  ['vs/workbench/contrib/preferences/browser/preferences.contribution', 'settings', 'Settings', '设置'],
  ['vs/workbench/contrib/preferences/browser/preferences.contribution', 'keyboardShortcuts', 'Keyboard Shortcuts', '键盘快捷方式'],
  ['vs/workbench/browser/parts/globalCompositeBar', 'manage', 'Manage', '管理'],
];
const contents = {};
for (const [moduleId, key, , chinese] of labels) { (contents[moduleId] ??= {})[key] = chinese; }

function core(source = true, config = {}) {
  const module = { exports: {} };
  const environment = Object.create(process);
  environment.env = { ...process.env, VSCODE_DEV: source ? '1' : '', VSCODE_NLS_CONFIG: JSON.stringify(config) };
  const context = createContext({ module, exports: module.exports, require, process: environment, fs: { promises: fs }, console, performance,
    Buffer, URL, URLSearchParams, Blob, TextDecoder, TextEncoder, setTimeout, clearTimeout, setImmediate, clearImmediate, queueMicrotask });
  runInContext(runtime.outputFiles[0].text, context);
  context.nls = module.exports;
  Object.assign(context, module.exports);
  return context;
}

async function functionSource(filename, name) {
  const source = await fs.readFile(path.join(kernel, 'src', filename), 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  let declaration;
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) { declaration = node; }
    else { ts.forEachChild(node, visit); }
  };
  visit(ast);
  assert.ok(declaration, `${filename}: ${name}`);
  return ts.transpileModule(declaration.getText(ast).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

async function bootstrap(context, configuration) {
  context.process.env.VSCODE_NLS_CONFIG = JSON.stringify(configuration);
  runInContext(await functionSource('bootstrap-esm.ts', 'doSetupNLS'), context);
  await runInContext('doSetupNLS()', context);
}

async function fixture(t, { source = true, language = 'zh-cn', translations = contents } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-source-nls-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pack = path.join(root, 'main.i18n.json');
  await fs.writeFile(pack, JSON.stringify({ contents: translations }));
  await fs.writeFile(path.join(root, 'languagepacks.json'), JSON.stringify({ 'zh-cn': { hash: 'fixture', translations: { vscode: pack } } }));
  const context = core(source);
  const configuration = await context.resolveNLSConfiguration({ userLocale: language, osLocale: 'zh-CN', userDataPath: root,
    nlsMetadataPath: root, commit: source ? undefined : 'packaged' });
  return { root, pack, context, configuration };
}

async function nativeExpressions(root) {
  const expressions = [];
  for (const moduleId of new Set(labels.map(label => label[0]))) {
    const output = path.join(root, 'out', `${moduleId}.js`);
    await transpileFile(path.join(kernel, 'src', `${moduleId}.ts`), output);
    const source = await fs.readFile(output, 'utf8');
    const ast = ts.createSourceFile(output, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const [, key] of labels.filter(label => label[0] === moduleId)) {
      let expression;
      const visit = node => {
        if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
          [ `%%NLS:${moduleId}#${key}%%`, `%%NLS2:${moduleId}#${key}%%` ].includes(node.arguments[0].text)) { expression ??= node; }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      assert.ok(expression, `${moduleId}: ${key} must keep its translation identifier`);
      expressions.push([moduleId, key, expression.getText(ast)]);
    }
  }
  return expressions;
}

function translatedLabels(context, expressions) {
  return expressions.map(([, , expression]) => { const value = runInContext(expression, context); return typeof value === 'string' ? value : value.value; });
}

test('source build translates the actual native Search, Replace, command palette and settings calls in every process', async t => {
  const f = await fixture(t);
  await bootstrap(f.context, f.configuration);
  assert.equal(f.context.getNLSLanguage(), 'zh-cn');
  const expressions = await nativeExpressions(f.root);
  const expected = labels.map(label => label[3]);
  assert.deepEqual(translatedLabels(f.context, expressions), expected);

  // Use the actual sandbox initializers and a serialized main-process payload.
  const payload = JSON.parse(JSON.stringify({ nls: { messages: f.context.getNLSMessages(), language: f.context.getNLSLanguage() } }));
  for (const file of ['vs/code/electron-browser/workbench/workbench.ts', 'vs/sessions/electron-browser/sessions.ts']) {
    const renderer = core(); let language;
    renderer.configuration = payload;
    renderer.window = { document: { documentElement: { setAttribute: (_key, value) => { language = value; } } } };
    runInContext(await functionSource(file, 'setupNLS'), renderer);
    runInContext('setupNLS(configuration)', renderer);
    assert.deepEqual(translatedLabels(renderer, expressions), expected);
    assert.equal(language, 'zh-Hans');
  }

  let workerBlob;
  f.context.URL = { createObjectURL: blob => { workerBlob = blob; return 'blob:worker'; } };
  f.context.COI = { addSearchParam() {} }; f.context.coalesce = values => values.filter(Boolean); f.context.origin = 'https://studio.test';
  runInContext(await functionSource('vs/platform/webWorker/browser/webWorkerServiceImpl.ts', 'getWorkerBootstrapUrl'), f.context);
  runInContext('getWorkerBootstrapUrl("editor", "https://studio.test/worker.js", undefined)', f.context);
  const worker = core();
  runInContext((await workerBlob.text()).split('const ttPolicy')[0], worker);
  assert.deepEqual(translatedLabels(worker, expressions), expected);
});

test('English startup, missing keys and language packs retain native English messages', async t => {
  const f = await fixture(t, { language: 'en' });
  await bootstrap(f.context, f.configuration);
  const expressions = await nativeExpressions(f.root);
  assert.deepEqual(translatedLabels(f.context, expressions), labels.map(label => label[2]));
  const chinese = await fixture(t, { translations: {} });
  await bootstrap(chinese.context, chinese.configuration);
  assert.deepEqual(translatedLabels(chinese.context, expressions), labels.map(label => label[2]));
  await fs.rm(path.join(chinese.root, 'languagepacks.json'));
  const fallback = await chinese.context.resolveNLSConfiguration({ userLocale: 'zh-cn', osLocale: 'zh-CN', userDataPath: chinese.root, nlsMetadataPath: chinese.root });
  assert.equal(fallback.resolvedLanguage, 'en'); assert.equal(fallback.languagePack, undefined);
});

test('source pack aliases, cache reuse and corrupt-cache recovery do not report a false active language', async t => {
  const f = await fixture(t, { language: 'zh-Hans-CN' });
  assert.equal(f.configuration.resolvedLanguage, 'zh-cn');
  await fs.writeFile(f.configuration.languagePack.messagesFile, '{broken');
  const errors = []; f.context.console = { error: error => errors.push(error) };
  await bootstrap(f.context, f.configuration);
  assert.equal(f.context.getNLSLanguage(), 'en');
  assert.equal(JSON.parse(f.context.process.env.VSCODE_NLS_CONFIG).resolvedLanguage, 'en');
  assert.match(await fs.readFile(f.configuration.languagePack.corruptMarkerFile, 'utf8'), /corrupted/);
  const repaired = await f.context.resolveNLSConfiguration({ userLocale: 'zh-CN', osLocale: 'zh-CN', userDataPath: f.root, nlsMetadataPath: f.root });
  await bootstrap(f.context, repaired);
  assert.equal(f.context.getNLSLanguage(), 'zh-cn');
  assert.ok(errors.length > 0);
});

test('incremental compilation keeps stable module keys, original command titles and English fallbacks', async t => {
  const f = await fixture(t, { translations: { 'vs/sample': { same: '你好 {0}' }, 'vs/other': { same: '另一条' } } });
  await bootstrap(f.context, f.configuration);
  for (const [name, body] of [['sample', `localize2({ key: 'same', comment: ['name'] }, 'Hello {0}', 'Studio')`],
    ['other', `localize('same', 'Other')`]]) {
    await fs.mkdir(path.join(f.root, 'src/vs'), { recursive: true });
    await fs.writeFile(path.join(f.root, `src/vs/${name}.ts`), `import { localize, localize2 } from '../nls.js'; export const value = ${body};`);
  }
  await applyIncrementalClientChanges(f.root, 'out', ['src/vs/sample.ts', 'src/vs/other.ts']);
  const sample = await fs.readFile(path.join(f.root, 'out/vs/sample.js'), 'utf8');
  const evaluate = code => runInContext('(() => {\n' + code.replace(/^import[^\n]+\n/, '').replace(/export \{[^}]+\};?/s, '') + '\nreturn value; })()', f.context);
  assert.deepEqual(JSON.parse(JSON.stringify(evaluate(sample))), { value: '你好 Studio', original: 'Hello Studio' });
  assert.equal(evaluate(await fs.readFile(path.join(f.root, 'out/vs/other.js'), 'utf8')) , '另一条');
  await fs.writeFile(path.join(f.root, 'src/vs/other.ts'), `import { localize } from '../nls.js'; export const value = localize('new', 'New English fallback');`);
  await applyIncrementalClientChanges(f.root, 'out', ['src/vs/other.ts']);
  assert.equal(await fs.readFile(path.join(f.root, 'out/vs/sample.js'), 'utf8'), sample);
  assert.equal(evaluate(await fs.readFile(path.join(f.root, 'out/vs/other.js'), 'utf8')), 'New English fallback');
});

test('packaged builds continue to load indexed NLS arrays', async t => {
  const f = await fixture(t, { source: false, language: 'en' });
  assert.equal(f.configuration.resolvedLanguage, 'en'); // No build tables yet.
  await fs.writeFile(path.join(f.root, 'nls.keys.json'), JSON.stringify([['vs/workbench/contrib/search/browser/searchWidget', ['search.placeHolder', 'new']]]));
  await fs.writeFile(path.join(f.root, 'nls.messages.json'), JSON.stringify(['Search', 'New English fallback']));
  const config = await f.context.resolveNLSConfiguration({ userLocale: 'zh-cn', osLocale: 'zh-CN', userDataPath: f.root, nlsMetadataPath: f.root, commit: 'packaged' });
  await bootstrap(f.context, config);
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.getNLSMessages())), ['搜索', 'New English fallback']);
  assert.equal(f.context.localize(0, null), '搜索');
  assert.equal(f.context.localize2(1, 'New English fallback').value, 'New English fallback');
});

test('an offline official language pack translates the same native source calls', { skip: !process.env.STEAMHARNESS_UI_LANGUAGE_PACK }, async t => {
  const pack = JSON.parse(await fs.readFile(path.join(process.env.STEAMHARNESS_UI_LANGUAGE_PACK, 'translations/main.i18n.json'), 'utf8'));
  const f = await fixture(t, { translations: pack.contents });
  await bootstrap(f.context, f.configuration);
  const expressions = await nativeExpressions(f.root);
  for (const [moduleId, key, expression] of expressions) {
    const result = runInContext(expression, f.context);
    assert.equal(typeof result === 'string' ? result : result.value, pack.contents[moduleId][key]);
    assert.match(typeof result === 'string' ? result : result.value, /\p{Script=Han}/u);
  }
});
