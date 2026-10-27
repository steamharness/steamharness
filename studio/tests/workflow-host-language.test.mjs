import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/workflow-runtime-node.ts'],
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);

for (const [language, expected] of [['en', 'English project'], ['zh-cn', 'Chinese project'], ['fr', 'English project']]) {
  test(`${language} host inspection and startup agree despite a Chinese system locale`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'studio-host-language-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ id: 'locale-project', name: 'Default project',
      steamHarness: { projectInfo: { localizedNames: { en: 'English project', 'zh-CN': 'Chinese project' } } } }));
    const cli = path.join(directory, 'node_modules/@steamharness/cli');
    await mkdir(path.join(cli, 'dist'), { recursive: true });
    await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version: '1.0.0',
      type: 'module', bin: { 'steamharness': 'dist/index.js' } }));
    await writeFile(path.join(cli, 'dist/index.js'), `
      import { readFileSync } from 'node:fs';
      import { createServer } from 'node:http';
      import { createInterface } from 'node:readline';
      const args = process.argv.slice(2), index = args.indexOf('--locale');
      const locale = index < 0 ? process.env.STEAMHARNESS_LOCALE : args[index + 1];
      const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
      const project = { id: manifest.id, name: manifest.steamHarness.projectInfo.localizedNames[locale] ?? manifest.name,
        folderPath: process.cwd(), projectType: 'conversation',entryId:'main',defaultEntry:'main',entries:[{entryId:'main',name:'Main',type:'conversation',root:'.',entry:'index.ts',databases:[]}],databases:[], fields: [], entrypoints: [] };
      if (args.includes('--inspect')) { console.log(JSON.stringify({ projects: [project], errors: [] })); }
      else {
        const input = createInterface({ input: process.stdin });
        const server = createServer();
        input.on('line', line => {
          if (JSON.parse(line).type === 'configure') {
            server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ type: 'ready', protocolVersion: 1,
              hostProtocolVersion: 1, accountProtocolVersion: 1, entriesProtocolVersion:1,databaseSpacesProtocolVersion:1,
              url: 'http://127.0.0.1:' + server.address().port + '/entries/main/#session=' + 'a'.repeat(64), project,
              runtime: { harnessVersion: 'fixture', harnessPath: process.cwd() } })));
          }
        });
        input.on('close', () => { process.stdin.pause(); server.close(); });
      }
    `);
    const vscode = { env: { language }, workspace: { onDidChangeConfiguration: () => ({ dispose() {} }), isTrusted: true, getConfiguration: () => ({ get: () => '', inspect: () => ({ defaultValue: 'auto' }) }) },
      window: { activeColorTheme: { kind: 1 } }, ColorThemeKind: { Light: 1, HighContrastLight: 4 } };
    const module = { exports: {} };
    runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
      require: name => name === 'vscode' ? vscode : require(name),
      process: { ...process, env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', STEAMHARNESS_LOCALE: 'zh-CN' } },
      AbortController, AbortSignal, URL, setTimeout, clearTimeout, queueMicrotask,
    });
    const runtime = module.exports.createProjectRuntime({ extensionUri: { fsPath: directory }, globalStorageUri: { fsPath: path.join(directory, 'storage') } },
      { getConnection: () => undefined, onDidChange: () => ({ dispose() {} }) });
    t.after(() => runtime.dispose());
    const inspection = await runtime.inspect([directory]);
    assert.deepEqual(Array.from(inspection.errors), []);
    assert.equal(inspection.projects[0].name, expected);
    const session = await runtime.start(inspection.projects[0], 'editor');
    t.after(() => session.close());
    assert.equal(session.ready.project.name, expected);
  });
}
