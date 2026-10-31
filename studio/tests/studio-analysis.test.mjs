import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { IMPORTED_PROJECTS_KEY } from '../extensions/studio-workstation/src/projects.ts';

const compiled = await build({ entryPoints: ['extensions/studio-workstation/src/studio-analysis.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const require = createRequire(import.meta.url);
test('start summaries retain readable project counts when another project is unavailable', () => {
  const f = fixture();
  const summary = f.api.studioAnalysisSummary({ generatedAt: 42, projects: [
    { availability: 'available', runs: [{ status: 'running' }, { status: 'waiting_for_input' }, { status: 'success' }] },
    { availability: 'available', runs: [] }, { availability: 'unreadable', runs: [{ status: 'running' }] },
  ] });
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), { projects: 2, running: 1, waiting: 1, unavailable: 1, generatedAt: 42 });
});
function fixture(imported = []) {
  const vscode = { workspace: { isTrusted: true }, Uri: { parse: value => { const url = new URL(value); return { scheme: url.protocol.slice(0, -1), fsPath: decodeURIComponent(url.pathname) }; } } };
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, URL, require: name => name === 'vscode' ? vscode : require(name) });
  return { vscode, api: module.exports, context: { globalState: { get: key => key === IMPORTED_PROJECTS_KEY ? imported : undefined } } };
}
test('analysis combines the current workspace with local imports without exposing assistants or remote directories', () => {
  const id = '8f6a6240-4860-4efc-bd07-932868be2b98';
  const f = fixture([{ id, name: 'Imported', uri: 'file:///project' }, { id, name: 'Remote', uri: 'vscode-remote://ssh-remote%2Bhost/project' }]);
  const projects = f.api.studioAnalysisProjects(f.context, [{ id, uri: 'file:///project', name: 'Current', projectType: 'workflow' },
    { id, uri: 'file:///assistant', name: 'Assistant', assistant: {} }, { id, uri: 'file:///analysis', name: 'Analysis', builtin: 'analysis' }]);
  assert.equal(projects.length, 1); assert.equal(projects[0].name, 'Current'); assert.equal(projects[0].inWorkspace, true); assert.equal(projects[0].folderPath, '/project');
});
test('the analysis capability accepts only the read-only query and stops on trust revocation or close', async () => {
  const f = fixture(), controller = new AbortController(); let calls = 0;
  const read = f.api.createStudioAnalysisHandler(async () => { calls++; return { version: 1, projects: [] }; }, controller.signal);
  assert.deepEqual(await read('studio.analysis.get', {}), { version: 1, projects: [] });
  await assert.rejects(read('studio.theme.set', {})); await assert.rejects(read('studio.analysis.get', { projectDir: '/other' })); assert.equal(calls, 1);
  f.vscode.workspace.isTrusted = false; await assert.rejects(read('studio.analysis.get', {}));
  f.vscode.workspace.isTrusted = true; controller.abort(); await assert.rejects(read('studio.analysis.get', {}));
});

test('analysis retains workspace membership when a project cannot be discovered from its manifest', () => {
  const id = '8f6a6240-4860-4efc-bd07-932868be2b98';
  const f = fixture([{ id, name: 'Current', uri: 'file:///project' }, { id, name: 'Old', uri: 'file:///old-project' }]);
  f.vscode.workspace.workspaceFolders = [{ uri: { toString: () => 'file:///project' } }];
  const projects = f.api.studioAnalysisProjects(f.context, []);
  assert.equal(projects[0].inWorkspace, true);
  assert.equal(projects[1].inWorkspace, false);
  f.vscode.workspace.workspaceFolders = [];
  assert.equal(f.api.studioAnalysisProjects(f.context, [])[0].inWorkspace, false);
});
