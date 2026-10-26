import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ROOT, applyPatches } from '../scripts/distribution.mjs';
import { pinnedKernel } from './helpers/pinned-kernel.mjs';

const require = createRequire(path.join(ROOT, 'upstream/vscode/build/package.json'));
const vsce = require('@vscode/vsce'), es = require('event-stream'), File = require('vinyl');
const file = 'build/lib/extensions.ts';
const source = await fsp.readFile(path.join(ROOT, 'upstream/vscode', file), 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'fromLocalEsbuild');
const javascript = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const collect = runInNewContext(`${javascript}\nfromLocalEsbuild`, {
  require: name => { assert.equal(name, '@vscode/vsce'); return vsce; }, path, fs, es, File, console,
  process: { argv: [process.execPath] },
  cp: { execFile: (_command, _args, _options, callback) => {
    queueMicrotask(() => callback(null, '', ''));
    return { stdout: new EventEmitter() };
  } },
  fancyLog() {}, ansiColors: { yellow: value => value }, createStatsStream: () => es.through(),
});

for (const name of ['copilot', 'bundled-extension']) test(`production ${name} includes its selected runtime files`, async t => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-extension-files-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const extension = path.join(root, name), sdk = path.join(extension, 'node_modules/@github/copilot/sdk');
  await fsp.mkdir(sdk, { recursive: true });
  await fsp.writeFile(path.join(extension, 'package.json'), JSON.stringify({ name, version: '1.0.0', engines: { vscode: '*' }, dependencies: { '@github/copilot': '1.0.0' } }));
  await fsp.writeFile(path.join(extension, '.vscodeignore'), '**\n!node_modules/@github/copilot/package.json\n!node_modules/@github/copilot/sdk/*.js\n');
  await fsp.writeFile(path.join(sdk, '../package.json'), JSON.stringify({ name: '@github/copilot', version: '1.0.0' }));
  await fsp.writeFile(path.join(sdk, 'index.js'), 'module.exports = "runtime SDK";\n');
  await fsp.writeFile(path.join(sdk, 'excluded-secret.txt'), 'must remain excluded');
  const files = await new Promise((resolve, reject) => {
    const files = [];
    collect(extension, '.esbuild.mts').on('error', reject).on('data', file => { files.push(file); file.contents.resume(); }).on('end', () => resolve(files));
  });
  const paths = files.map(file => file.relative.replaceAll('\\', '/'));
  assert.equal(paths.includes('node_modules/@github/copilot/sdk/index.js'), name === 'copilot');
  assert.equal(paths.includes('node_modules/@github/copilot/sdk/excluded-secret.txt'), false);
});

test('the complete packaging patch series replays without changing the pinned index or local files', async t => {
  const touched = new Set();
  for (const name of await fsp.readdir(path.join(ROOT, 'patches'))) {
    const patch = await fsp.readFile(path.join(ROOT, 'patches', name), 'utf8');
    for (const match of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) touched.add(match[1]);
  }
  const lock = JSON.parse(await fsp.readFile(path.join(ROOT, 'config/upstream.json'), 'utf8'));
  const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', lock.commit, '--', ...touched], { cwd: path.join(ROOT, lock.path), encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const { upstream } = await pinnedKernel(t, tracked);
  const git = args => execFileSync('git', args, { cwd: upstream, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const index = git(['write-tree']);
  await applyPatches(ROOT, upstream);
  await fsp.writeFile(path.join(upstream, 'local-notes.txt'), 'preserve me');
  await applyPatches(ROOT, upstream);
  assert.equal(await fsp.readFile(path.join(upstream, file), 'utf8'), source);
  assert.equal(await fsp.readFile(path.join(upstream, 'local-notes.txt'), 'utf8'), 'preserve me');
  assert.equal(git(['write-tree']), index);
});
