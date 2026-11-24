import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../upstream/vscode/src/vs/code/browser/workbench/studioWebProjectEntry.ts', import.meta.url), 'utf8');
const exports = {};
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports });
const { takeStudioWebProjectEntry, writeStudioWebProjectEntry } = exports;
const target = 'http://127.0.0.1:3039/?folder=/projects/demo%20app';
const folder = 'file:///projects/demo%20app';

function storage() {
  const records = new Map();
  return { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) };
}

test('the new tab consumes its default or selected entry only once, without embedding it in the URL', () => {
  const launchpad = storage(), tab = storage();
  for (const entryId of [undefined, 'secondary']) {
    writeStudioWebProjectEntry(tab, target, entryId);
    assert.equal(takeStudioWebProjectEntry({ sessionStorage: launchpad }, target, folder), undefined);
    const request = takeStudioWebProjectEntry({ sessionStorage: tab }, target, folder);
    assert.deepEqual({ ...request }, { uri: folder, entryId });
    assert.equal(takeStudioWebProjectEntry({ sessionStorage: tab }, target, folder), undefined);
  }
});

test('a different page clears a stale launch request without running it', () => {
  const tab = { sessionStorage: storage() };
  writeStudioWebProjectEntry(tab.sessionStorage, target, 'secondary');
  assert.equal(takeStudioWebProjectEntry(tab, 'http://127.0.0.1:3039/?folder=/projects/other', 'file:///projects/other'), undefined);
  assert.equal(takeStudioWebProjectEntry(tab, target, folder), undefined);
});

test('blocking browser storage does not prevent the workbench from opening', () => {
  const tab = { get sessionStorage() { throw new Error('Storage unavailable'); } };
  assert.equal(takeStudioWebProjectEntry(tab, target, folder), undefined);
});
