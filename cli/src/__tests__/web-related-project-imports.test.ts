import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RelatedProjectImports } from '../web/related-projects';

vi.mock('node:fs/promises', async importActual => ({ ...await importActual<typeof import('node:fs/promises')>(), readFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const binding = { alias: 'database', projectDir: path.join(os.tmpdir(), 'database') };
const issue = { kind: 'related-setup-required' as const, projectId: 'ABCD', relatedProjectAlias: 'database' };

it('keeps standalone import status unknown and separates verified identities from authorization', async () => {
  const imports = new RelatedProjectImports();
  await imports.update(undefined);
  expect(imports.issue(issue)).not.toHaveProperty('relatedProjectImported');
  await imports.update([]);
  expect(imports.issue(issue)?.relatedProjectImported).toBe(false);
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({ id: 'abcd', steamHarness: { projectInfo: { relatedProjects: [] } } }));
  await imports.update([binding]);
  expect(imports.issue(issue)).toMatchObject({ kind: 'related-setup-required', relatedProjectImported: true });
  expect(imports.issue({ kind: 'project-unavailable' })).not.toHaveProperty('relatedProjectImported');
  expect(imports.issue({ ...issue, projectId: 'another-id' })?.relatedProjectImported).toBe(false);
  vi.mocked(readFile).mockRejectedValue(new Error('Moved folder'));
  await imports.update([binding]);
  expect(imports.issue(issue)?.relatedProjectImported).toBe(false);
});

it('ignores slow results from superseded imports and reads finishing after close', async () => {
  const imports = new RelatedProjectImports();
  let finish!: (value: string) => void;
  vi.mocked(readFile).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = imports.update([binding]);
  await imports.update([]);
  finish(JSON.stringify({ id: 'abcd' }));
  expect(await pending).toBe(false);
  expect(imports.issue(issue)?.relatedProjectImported).toBe(false);
  const closing = imports.update([binding]); imports.close(); finish(JSON.stringify({ id: 'abcd' }));
  expect(await closing).toBe(false);
  expect(imports.issue(issue)?.relatedProjectImported).toBe(false);
});
