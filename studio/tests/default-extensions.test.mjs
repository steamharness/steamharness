import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

test('cached default language packs initialize every profile while ordinary extensions are reused', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-default-languages-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'config')); await fs.mkdir(path.join(root, '.studio'));
  const extensionDirectory = path.join(root, 'extensions'); await fs.mkdir(extensionDirectory);
  const defaults = [
    { id: 'example.icons', version: '1.0.0' },
    { id: 'example.language', version: '1.0.0', localizations: [{ languageId: 'zh-cn' }] },
  ];
  for (const extension of defaults) {
    const data = Buffer.from(extension.id);
    extension.sha256 = createHash('sha256').update(data).digest('hex');
    extension.url = 'https://offline.invalid/must-use-cache';
    await fs.writeFile(path.join(root, '.studio', `${extension.id}-${extension.version}.vsix`), data);
  }
  await fs.writeFile(path.join(root, 'config/default-extensions.json'), JSON.stringify(defaults));
  await fs.copyFile(new URL('../scripts/default-extensions.mjs', import.meta.url), path.join(root, 'default-extensions.mjs'));
  await fs.writeFile(path.join(root, 'distribution.mjs'), `import * as fs from 'node:fs/promises'; export const ROOT = import.meta.dirname;
    export const exists = async path => { try { await fs.access(path); return true; } catch { return false; } };
    export const readJSON = async path => JSON.parse(await fs.readFile(path, 'utf8'));`);
  const { ensureDefaultExtensions } = await import(pathToFileURL(path.join(root, 'default-extensions.mjs')));
  const installed = [], calls = [];
  await ensureDefaultExtensions(extensionDirectory, async vsix => {
    calls.push(path.basename(vsix));
    const extension = defaults.find(extension => vsix.endsWith(`${extension.id}-${extension.version}.vsix`));
    const relativeLocation = `${extension.id}-${extension.version}`;
    await fs.mkdir(path.join(extensionDirectory, relativeLocation));
    await fs.writeFile(path.join(extensionDirectory, relativeLocation, 'package.json'), JSON.stringify({ version: extension.version, contributes: { localizations: extension.localizations } }));
    installed.push({ identifier: { id: extension.id }, relativeLocation });
    await fs.writeFile(path.join(extensionDirectory, 'extensions.json'), JSON.stringify(installed));
  });
  assert.deepEqual(calls, ['example.icons-1.0.0.vsix', 'example.language-1.0.0.vsix']);
  calls.length = 0;
  await ensureDefaultExtensions(extensionDirectory, async extension => calls.push(extension));
  assert.deepEqual(calls, ['example.language@1.0.0']);
});

test('the native CLI initializes language-pack participants before installation and waits for the profile index', async () => {
  const source = await fs.readFile(new URL('../upstream/vscode/src/vs/code/node/cliProcessMain.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('cliProcessMain.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'CliMain');
  const method = declaration.members.find(node => node.name?.getText(ast) === 'run');
  const code = ts.transpileModule(`class CliMain { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const services = ['ILogService', 'IFileService', 'INativeEnvironmentService', 'IUserDataProfilesService', 'ILanguagePackService'];
  const events = [], values = Object.fromEntries(services.map(id => [id, {}]));
  values.ILogService = { info() {} }; values.ILanguagePackService = { update: async () => { await Promise.resolve(); events.push('index'); } };
  const Class = runInNewContext(`${code}\nCliMain`, { ...Object.fromEntries(services.map(id => [id, id])), setDefaultResultOrder() {}, raceTimeout: promise => promise });
  const cli = new Class();
  cli.initServices = async () => [{ invokeFunction: callback => {
    let valid = true;
    const result = callback({ get: id => { assert.ok(valid, 'Service access must precede the first await'); events.push(id); return values[id]; } });
    valid = false; return result;
  } }, []];
  cli.registerErrorHandler = () => {};
  cli.doRun = async () => { await Promise.resolve(); events.push('install'); };
  await cli.run();
  assert.deepEqual(events, [...services, 'install', 'index']);
});
