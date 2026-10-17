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
      workflowCode: { projectInfo: { localizedNames: { en: 'English project', 'zh-CN': 'Chinese project' } } } }));
    const cli = path.join(directory, 'node_modules/@workflow-code/cli');
    await mkdir(path.join(cli, 'dist'), { recursive: true });
    await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@workflow-code/cli', version: '1.0.0',
      type: 'module', bin: { 'workflow-code': 'dist/index.js' } }));
    await writeFile(path.join(cli, 'dist/index.js'), `
      import { readFileSync } from 'node:fs';
      import { createServer } from 'node:http';
      import { createInterface } from 'node:readline';
      const args = process.argv.slice(2), index = args.indexOf('--locale');
      const locale = index < 0 ? process.env.WORKFLOW_CODE_LOCALE : args[index + 1];
      const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
      const project = { id: manifest.id, name: manifest.workflowCode.projectInfo.localizedNames[locale] ?? manifest.name,
        folderPath: process.cwd(), projectType: 'conversation', fields: [], entrypoints: [] };
      if (args.includes('--inspect')) { console.log(JSON.stringify({ projects: [project], errors: [] })); }
      else {
        const input = createInterface({ input: process.stdin });
        const server = createServer();
        input.on('line', line => {
          if (JSON.parse(line).type === 'configure') {
            server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ type: 'ready', protocolVersion: 1,
              hostProtocolVersion: 1, accountProtocolVersion: 1, relatedProjectsProtocolVersion: 1,
              url: 'http://127.0.0.1:' + server.address().port + '/#session=' + 'a'.repeat(64), project,
              runtime: { coreVersion: 'fixture', corePath: process.cwd() } })));
          }
        });
        input.on('close', () => { process.stdin.pause(); server.close(); });
      }
    `);
    const vscode = { env: { language }, workspace: { isTrusted: true, getConfiguration: () => ({ get: () => '' }) },
      window: { activeColorTheme: { kind: 1 } }, ColorThemeKind: { Light: 1, HighContrastLight: 4 } };
    const module = { exports: {} };
    runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
      require: name => name === 'vscode' ? vscode : require(name),
      process: { ...process, env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', WORKFLOW_CODE_LOCALE: 'zh-CN' } },
      AbortController, AbortSignal, URL, setTimeout, clearTimeout, queueMicrotask,
    });
    const runtime = module.exports.createWorkflowRuntime({ extensionUri: { fsPath: directory }, globalStorageUri: { fsPath: path.join(directory, 'storage') } },
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
