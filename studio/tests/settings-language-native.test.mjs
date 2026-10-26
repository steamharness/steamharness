import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import ts from 'typescript';

const kernel = new URL('../upstream/vscode/src/', import.meta.url);
const require = createRequire(import.meta.url);
const runtime = await build({ stdin: { contents: `export { parse } from './vs/base/common/jsonc'; export { format } from './vs/base/common/strings'; export { resolveNLSConfiguration } from './vs/base/node/nls'; export { studioLocaleStrings } from './vs/workbench/services/localization/common/studioLocaleStrings'; export { InstantiationService } from './vs/platform/instantiation/common/instantiationService'; export { ServiceCollection } from './vs/platform/instantiation/common/serviceCollection'; export { createDecorator } from './vs/platform/instantiation/common/instantiation';`,
  resolveDir: kernel.pathname, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false });

function core(language = 'en', source = true) {
  const module = { exports: {} };
  const environment = Object.create(process);
  environment.env = { ...process.env, VSCODE_DEV: source ? '1' : '', VSCODE_NLS_CONFIG: JSON.stringify({ resolvedLanguage: language }) };
  runInNewContext(runtime.outputFiles[0].text, { module, exports: module.exports, require, process: environment, console, performance, Buffer, URL, TextDecoder, TextEncoder, setTimeout, clearTimeout, setImmediate, clearImmediate, queueMicrotask });
  return module.exports;
}

async function declaration(file, name, globals = {}, memberNames) {
  const source = await readFile(new URL(file, kernel), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(node => node.name?.text === name);
  const code = ts.isClassDeclaration(node) ? `class ${name} { ${node.members.filter(member => !ts.isConstructorDeclaration(member) && !ts.isPropertyDeclaration(member) && (!memberNames || memberNames.includes(member.name?.getText(ast)))).map(member => member.getText(ast)).join('\n')} }` : node.getText(ast).replace(/^export /, '');
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  runInNewContext(`${compiled}\nmodule.exports = ${name};`, { module, Error, ...globals });
  return module.exports;
}

async function languageCommand(locale, packs) {
  const api = core();
  const localeId = api.createDecorator('testLocale'), packsId = api.createDecorator('testLanguagePacks');
  const route = await declaration('vs/workbench/contrib/localization/common/localizationsActions.ts', 'setStudioDisplayLanguage', {
    ILocaleService: localeId, ILanguagePackService: packsId, ...api,
  });
  const instantiation = new api.InstantiationService(new api.ServiceCollection([localeId, locale], [packsId, packs]), true);
  return { invoke: language => instantiation.invokeFunction(route, language), dispose: () => instantiation.dispose() };
}

class FileOperationError extends Error { fileOperationResult = 1; }
const FileOperationResult = { FILE_NOT_FOUND: 1 };
async function nativeFixture({ active = 'en', preference, built = false, confirm = true, installed = ['en', 'zh-cn'] } = {}) {
  const api = core(active);
  const Language = { value: () => active, isDefaultVariant: () => active === 'en' };
  const Service = await declaration('vs/workbench/services/localization/electron-browser/localeService.ts', 'NativeLocaleService', {
    ...api, Language, LANGUAGE_DEFAULT: 'en', FileOperationError, FileOperationResult, Severity: { Error: 3 }, toAction: action => action,
    ProgressLocation: { Notification: 1 }, ViewContainerLocation: { Sidebar: 0 }, localize: (_key, value) => value,
  });
  const service = new Service(), writes = [], dialogs = [], notifications = [], order = [];
  const f = { content: JSON.stringify({ locale: preference, 'disable-hardware-acceleration': true }), confirm, service, writes, dialogs, notifications, order, restarts: 0, installs: 0 };
  service.environmentService = { argvResource: 'argv.json', isBuilt: built };
  service.textFileService = { read: async () => { if (f.missing) { throw new FileOperationError(); } return { value: f.content }; } };
  service.jsonEditingService = { write: async (resource, edits) => {
    if (f.writeError) { throw new Error('Fixture disk failure'); }
    order.push('write'); writes.push({ resource, edits });
    const value = f.missing ? {} : JSON.parse(f.content);
    if (edits[0].value === undefined) { delete value.locale; } else { value.locale = edits[0].value; }
    f.content = JSON.stringify(value); f.missing = false;
  } };
  service.languagePackService = { getInstalledLanguages: async () => installed.map(id => ({ id, label: id === 'en' ? 'English' : '简体中文' })) };
  service.dialogService = { confirm: async dialog => { dialogs.push(dialog); order.push('confirm'); return { confirmed: f.confirm }; } };
  service.hostService = { restart: async () => { f.restarts++; order.push('restart'); } };
  service.productService = { nameLong: 'SteamHarness Studio' };
  service.notificationService = { error: error => notifications.push(error), notify: notification => notifications.push(notification) };
  service.extensionManagementService = { installFromGallery: async () => { f.installs++; } };
  service.progressService = { withProgress: async (_options, callback) => callback() };
  return f;
}

test('native preference reads the saved mode independently of the active display language', async () => {
  const f = await nativeFixture({ active: 'zh-cn' });
  assert.equal(await f.service.getLocalePreference(), undefined);
  f.content = '{ // runtime options\n "locale": "EN", }';
  assert.equal(await f.service.getLocalePreference(), 'en');
  f.missing = true;
  assert.equal(await f.service.getLocalePreference(), undefined);
});

test('pinning the current language persists the choice without a redundant restart', async () => {
  const f = await nativeFixture();
  await f.service.setLocale({ id: 'en', label: 'English' });
  assert.equal(await f.service.getLocalePreference(), 'en');
  assert.equal(f.restarts, 0); assert.equal(f.dialogs.length, 0);
  assert.equal(JSON.parse(f.content)['disable-hardware-acceleration'], true);
  await f.service.setLocale({ id: 'en', label: 'English' });
  assert.equal(f.writes.length, 1);
});

test('source Chinese uses the installed language pack and switches after confirmation', async () => {
  const f = await nativeFixture();
  await f.service.setLocale({ id: 'zh-cn', label: '简体中文' });
  assert.equal(await f.service.getLocalePreference(), 'zh-cn');
  assert.deepEqual(f.order, ['confirm', 'write', 'restart']);
  assert.equal(f.installs, 0);
});

test('packaged Chinese uses the existing language-pack installer before restarting', async () => {
  const f = await nativeFixture({ built: true, installed: ['en'] });
  await f.service.setLocale({ id: 'zh-cn', label: '简体中文', galleryExtension: { publisher: 'MS-CEINTL' } });
  assert.equal(f.installs, 1); assert.equal(f.restarts, 1);
  assert.equal(await f.service.getLocalePreference(), 'zh-cn');
});

test('an unapplied saved language completes its native command through the scoped service accessor', async t => {
  const f = await nativeFixture({ preference: 'zh-cn', active: 'en' });
  const command = await languageCommand(f.service, f.service.languagePackService);
  t.after(() => command.dispose());
  assert.equal(await command.invoke('zh-cn'), 'zh-cn');
  assert.equal(f.restarts, 1); assert.equal(f.dialogs.length, 1);
});

test('canceling a language change or system-language restart preserves the saved preference', async () => {
  const f = await nativeFixture({ preference: 'en', confirm: false });
  await f.service.setLocale({ id: 'zh-cn', label: '简体中文' });
  await f.service.clearLocalePreference();
  assert.equal(await f.service.getLocalePreference(), 'en');
  assert.equal(f.writes.length, 0); assert.equal(f.restarts, 0);
});

test('following system removes the override and restarts even when the active language is English', async () => {
  const f = await nativeFixture({ preference: 'en' });
  await f.service.clearLocalePreference();
  assert.equal(await f.service.getLocalePreference(), undefined);
  assert.equal(f.restarts, 1);
  assert.match(f.dialogs[0].message, /System Language/);
  assert.deepEqual(f.order, ['confirm', 'write', 'restart']);
  await f.service.clearLocalePreference();
  assert.equal(f.writes.length, 1);
});

test('invalid runtime JSON and failed writes cannot restart or erase existing options', async () => {
  const f = await nativeFixture({ preference: 'en' });
  f.content = '{ invalid JSON';
  await assert.rejects(f.service.setLocale({ id: 'zh-cn', label: '简体中文' }));
  assert.equal(f.writes.length, 0); assert.equal(f.restarts, 0);
  f.content = '{"locale":"en"}'; f.writeError = true;
  await assert.rejects(f.service.clearLocalePreference(), /Fixture disk failure/);
  assert.equal(await f.service.getLocalePreference(), 'en'); assert.equal(f.restarts, 0);
  assert.equal(f.notifications.length, 1);
});

test('source locale resolution falls back to English when no language pack is installed', async () => {
  const api = core();
  for (const [locale, expected] of [['zh-cn', 'en'], ['zh-Hans-CN', 'en'], ['en-US', 'en'], ['fr', 'en']]) {
    const result = await api.resolveNLSConfiguration({ userLocale: locale, osLocale: 'zh-CN', userDataPath: '/unused', nlsMetadataPath: '/unused' });
    assert.equal(result.resolvedLanguage, expected); assert.equal(result.osLocale, 'zh-CN');
  }
  assert.equal(core('zh-cn').studioLocaleStrings.system, '系统语言');
  assert.equal(core('en').studioLocaleStrings.system, 'System Language');
});

test('source extension scanning resolves Chinese contribution catalogs without copying the manifest', async () => {
  const Scanner = await declaration('vs/platform/extensionManagement/common/extensionsScannerService.ts', 'ExtensionsScanner', {
    joinPath: (root, filename) => `${root}/${filename}`,
  }, ['findMessageBundles']);
  const scanner = new Scanner();
  scanner.fileService = { exists: async resource => resource.endsWith('package.nls.zh-cn.json') };
  const result = await scanner.findMessageBundles('/extension', { devMode: true, language: 'zh-cn' });
  assert.equal(result.localized, '/extension/package.nls.zh-cn.json');
  assert.equal(result.original, '/extension/package.nls.json');
});

test('browser language preference persists an explicit current language and clears both browser storage and cookie', async () => {
  const source = await readFile(new URL('vs/workbench/services/localization/browser/localeService.ts', kernel), 'utf8');
  const ast = ts.createSourceFile('localeService.ts', source, ts.ScriptTarget.Latest, true);
  const storage = ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(node => node.name.getText(ast) === 'localeStorage'));
  const values = new Map(), document = { cookie: '' }, module = { exports: {} };
  const code = ts.transpileModule(storage.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(`${code}\nmodule.exports = localeStorage;`, { module, document, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
  const api = core();
  const Service = await declaration('vs/workbench/services/localization/browser/localeService.ts', 'WebLocaleService', {
    localeStorage: module.exports, Language: { value: () => 'en' }, navigator: { language: 'zh-CN' }, localize: (_key, message, ...args) => api.format(message, ...args),
  });
  const service = new Service(); let restarts = 0;
  service.dialogService = { confirm: async () => ({ confirmed: true }) };
  service.hostService = { restart: () => { restarts++; } }; service.productService = { nameLong: 'Studio' };
  assert.equal(await service.getLocalePreference(), undefined);
  await service.setLocale({ id: 'en', label: 'English' });
  assert.equal(await service.getLocalePreference(), 'en'); assert.match(document.cookie, /locale=en/);
  await service.clearLocalePreference();
  assert.equal(await service.getLocalePreference(), undefined); assert.equal(values.size, 0); assert.match(document.cookie, /max-age=0/);
  assert.equal(restarts, 2);
});

test('Studio language routing accepts only three modes, reuses packs and reports cancellation', async t => {
  let preference = 'system', installed = true, gallery = 0, canceled = false;
  const selections = [], locale = {
    getLocalePreference: async () => preference === 'system' ? undefined : preference,
    setLocale: async item => { selections.push(item); if (!canceled) { preference = item.id; } },
    clearLocalePreference: async () => { preference = 'system'; },
  };
  const packs = { getInstalledLanguages: async () => installed ? [{ id: 'zh-cn', label: '简体中文' }] : [], getAvailableLanguages: async () => { gallery++; return []; } };
  const command = await languageCommand(locale, packs);
  t.after(() => command.dispose());
  assert.equal(await command.invoke('zh-cn'), 'zh-cn');
  assert.equal(await command.invoke('en'), 'en');
  assert.equal(await command.invoke('system'), 'system');
  assert.equal(gallery, 0);
  canceled = true;
  assert.equal(await command.invoke('zh-cn'), 'system');
  for (const value of ['fr', '', undefined, { id: 'zh-cn' }]) { await assert.rejects(command.invoke(value), /Unsupported display language/); }
  assert.equal(selections.length, 3);
  installed = false;
  await assert.rejects(command.invoke('zh-cn'), /language pack is unavailable/);
  assert.equal(gallery, 1);
});
