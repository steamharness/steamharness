import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectServerCreation } from '../web/project-server-create';
import type { Project } from '../web/workflow-types';
const id = 'aaa10f6d-c322-461a-aecd-56d644d227c5';
const connection = { serverUrl: 'https://project.test', accessToken: 'private-token' };
const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

it('creates an explicitly requested personal cloud project without requiring project group selection', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'personal-project-')); folders.push(folder);
  const allocated = '0a462fc3-25d1-494b-b04a-f5f9a66747a5';
  await writeFile(path.join(folder, 'steamharness.json'), JSON.stringify({ id, name: 'Personal project', version: '1.0.0', defaultEntry: 'main',
    entries: [{ entryId: 'main', root: '.', type: 'bot', name: 'Bot', entry: 'index.ts' }] }));
  const project = { id, folderPath: folder, projectType: 'bot', name: 'Personal project' } as Project;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body)); expect(body.name).toBe('Personal project'); expect(body.groupId).toBeUndefined();
      expect(body.entries[0].type).toBe('bot'); expect(body.projectId).toBeUndefined();
      return Response.json({ errCode: 0, data: { projectId: allocated } }, { status: 201 });
    }
    expect(String(url)).toBe(`${connection.serverUrl}/api/projects/${id}`);
    return Response.json({ errCode: 404 }, { status: 404 });
  });
  const creation = new ProjectServerCreation(project, () => connection, () => 'user', () => ({ kind: 'project-unavailable' }));
  try {
    const context = await creation.prepare(true); expect(context.groups).toEqual([]);
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(await creation.confirm({ token: context.token, confirmed: true, name: context.name })).toBe(allocated);
    expect(JSON.parse(await readFile(path.join(folder, 'steamharness.json'), 'utf8')).id).toBe(allocated);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  } finally { creation.close(); }
});
