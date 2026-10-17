import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readImportedProjects, readRecentProjects, readRelatedProjects, rememberImportedProjects, rememberProjects } from '../extensions/studio-workstation/src/projects.ts';

const project = (uri, lastOpened = 1, kind = 'folder') => ({ uri, label: 'Project', kind, lastOpened });

test('recent projects tolerate corrupt data and reject command URLs', () => {
  const valid = [project('file:///work/project'), project('vscode-remote://localhost/work/project', 2)];
  assert.deepEqual(readRecentProjects([
    ...valid, null, 'invalid', {}, project('command:deleteEverything'),
    project('https://example.com'), project('file:///bad', NaN),
    { ...project('file:///blank'), label: '' },
  ]), valid);
  assert.deepEqual(readRecentProjects({ projects: valid }), []);
});

test('reopening a project updates its position without duplicating it', () => {
  const a = project('file:///a', 1);
  const b = project('file:///b', 2);
  const reopened = { ...a, label: 'Renamed project', lastOpened: 3 };
  assert.deepEqual(rememberProjects([b, a], [reopened], 12), [reopened, b]);
});

test('a saved workspace keeps priority over folders with the same timestamp', () => {
  const workspace = project('file:///work.code-workspace', 3, 'workspace');
  const folder = project('file:///work', 3);
  assert.deepEqual(rememberProjects([], [workspace, folder], 1), [workspace]);
});

test('limits retain newest projects and cap the saved history', () => {
  const projects = Array.from({ length: 60 }, (_, i) => project(`file:///work/${i}`, i));
  assert.deepEqual(rememberProjects(projects, [], 2), [projects[59], projects[58]]);
  assert.equal(rememberProjects(projects, [], 100).length, 50);
});

test('imported projects retain their identity independently of the recent history limit', () => {
  const id = '294b1eec-23fa-42cf-9fd3-2417f71c0570';
  const imported = Array.from({ length: 70 }, (_, i) => ({ id, uri: `file:///projects/${i}`, name: `Project ${i}` }));
  const replacement = { ...imported[0], id: '615e6cf6-b40a-456a-8d19-b71c63454c7a', name: 'Replaced' };
  const next = rememberImportedProjects(imported, [replacement]);
  assert.deepEqual([next.length, next[0], next.filter(project => project.uri === replacement.uri).length], [70, replacement, 1]);
  assert.deepEqual(readImportedProjects([null, {}, { ...replacement, uri: 'command:deleteEverything' }, { ...replacement, id: 'invalid' },
    { ...replacement, uri: 'https://example.com' }, { ...replacement, name: '' }, { ...replacement, id: replacement.id.toUpperCase() }]), [replacement]);
});

test('remembering an opened download preserves its version and group association', () => {
  const source = { id: '294b1eec-23fa-42cf-9fd3-2417f71c0570', name: 'Board', uri: 'file:///board-1.0.0', version: '1.0.0', downloadRootUri: 'file:///board-1.0.0' };
  const next = rememberImportedProjects([source], [{ id: source.id, uri: source.uri, name: 'Board renamed' }]);
  assert.deepEqual(next, [{ ...source, name: 'Board renamed' }]);
});

test('related projects resolve declared UUIDs rather than labels or paths', () => {
  const id = '615e6cf6-b40a-456a-8d19-b71c63454c7a';
  assert.deepEqual(readRelatedProjects({ workflowCode: { projectInfo: { relatedProjects: [
    { alias: 'notes', projectId: id.toUpperCase(), path: '/arbitrary' }, null, {}, { alias: 'invalid', projectId: '/notes' }, { alias: '', projectId: id },
  ] } } }), [{ alias: 'notes', projectId: id }]);
  assert.deepEqual(readRelatedProjects(null), []);
});
