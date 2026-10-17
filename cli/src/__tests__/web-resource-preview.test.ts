import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initI18n } from '@workflow-code/i18n';
import { ResourcePreviews } from '../web/resource-preview';
import { startWebServer } from '../web/server';
import { webProjectDataDirectory } from '../web/kanban-data';
import type { ResourceCard } from '../web/resource-cards';
import type { WorkflowProject, WorkflowRuntime } from '../web/workflow-types';

const folders: string[] = [];
beforeEach(() => initI18n({ preference: 'en' }));
afterEach(async () => { vi.restoreAllMocks(); for (const directory of folders.splice(0)) { await rm(directory, { recursive: true, force: true }); } });

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workflow-resource-'))); folders.push(root);
  const storageDir = path.join(root, 'data');
  const owner: WorkflowProject = { id: 'owner', uri: '', name: 'Owner', folderPath: root, projectType: 'conversation', fields: [], entrypoints: [] };
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ id: owner.id, workflowCode: { projectInfo: { dataStorage: { mode: 'local' } } } }));
  const related = { ...owner, id: 'related', name: 'Related', folderPath: path.join(root, 'related'), projectType: 'kanban' as const,
    kanban: { artifactDir: 'dist', entry: 'index.html' }, fields: [{ name: 'title', type: 'string', defaultValue: 'Default' }] };
  await mkdir(path.join(related.folderPath, 'dist'), { recursive: true });
  await writeFile(path.join(related.folderPath, 'package.json'), JSON.stringify({ id: related.id, workflowCode: { projectInfo: { dataStorage: { mode: 'local' } } } }));
  await writeFile(path.join(related.folderPath, 'dist/index.html'), '<html><head></head><body>Map preview</body></html>');
  const runtime = { inspect: vi.fn(async () => ({ projects: [related], errors: [] })), readResource: vi.fn(async () => ({ id: 'doc', markdown: '# Document' })),
    kanbanBridge: vi.fn(async () => ({ key: 'map' })) } as unknown as WorkflowRuntime;
  let connection: { serverUrl: string; accessToken: string } | undefined = { serverUrl: 'https://workflow.test', accessToken: 'test-only-token' };
  const previews = new ResourcePreviews(owner, runtime, storageDir, () => connection, () => [{ alias: 'map', projectDir: related.folderPath }]);
  const card = (kind: ResourceCard['kind'], target: Record<string, string>, extra: Partial<ResourceCard> = {}): ResourceCard => ({ id: 'card', kind, title: 'Resource', target, ...extra });
  return { root, owner, related, runtime, storageDir, previews, card, logout: () => { connection = undefined; previews.clear(); } };
}

describe('resource previews', () => {
  it('uses the related resource owner and exact conversation scope rather than the caller storage', async () => {
    const { previews, card, related, runtime } = await fixture();
    const result = await previews.open(card('knowledge', { source: 'local', projectId: related.id, documentId: 'doc', conversationId: 'target-session' }));
    expect(result.data).toMatchObject({ format: 'markdown', content: { markdown: '# Document' }, project: { id: related.id, folderPath: related.folderPath } });
    expect(runtime.readResource).toHaveBeenCalledWith(expect.objectContaining({ id: related.id }), 'target-session', 'knowledge', expect.objectContaining({ documentId: 'doc' }));
  });

  it('previews imported projects even when they are not execution relations', async () => {
    const { owner, related, runtime, storageDir, card } = await fixture();
    const previews = new ResourcePreviews(owner, runtime, storageDir, () => undefined, () => [], () => [related.folderPath]);
    expect((await previews.open(card('project', { source: 'local', projectId: related.id }, { preview: false }))).data.project?.id).toBe(related.id);
  });

  it('checks Server read access for foreign Knowledge and keeps credentials out of the preview data', async () => {
    const { previews, card } = await fixture();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ errCode: 0, data: { id: 'doc', markdown: '# Foreign document' } })));
    const result = await previews.open(card('knowledge', { source: 'server', projectId: 'database', documentId: 'doc' }));
    expect(fetcher).toHaveBeenCalledWith('https://workflow.test/api/workflows/database/knowledge-documents/doc', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-only-token' }), redirect: 'error' }));
    expect(result.data.format).toBe('markdown'); expect(JSON.stringify(result)).not.toContain('test-only-token');
    fetcher.mockResolvedValue(new Response(JSON.stringify({ errCode: 403, errMessage: 'Access denied' }), { status: 403 }));
    await expect(previews.open(card('knowledge', { source: 'server', projectId: 'private', documentId: 'doc' }))).rejects.toThrow('Access denied');
  });

  it('retains the current project identity when opening its server resources', async () => {
    const { previews, card, owner } = await fixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ errCode: 0, data: { id: 'doc', markdown: '# Document' } })));
    const result = await previews.open(card('knowledge', { source: 'server', projectId: owner.id, documentId: 'doc' }));
    expect(result.data.project).toBe(owner);
  });

  it('preserves the foreign KV key, scope and conversation in the permission-checked request', async () => {
    const { previews, card } = await fixture();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ errCode: 0, data: { key: 'state', value: 7 } })));
    await previews.open(card('kv', { source: 'server', projectId: 'database', key: 'state', scope: 'conversation', conversationId: 'session-b' }));
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/workflows/database/kv/entry'); expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'conversation', conversationId: 'session-b', key: 'state' });
  });

  it('does not guess a local directory from a card project UUID', async () => {
    const { previews, card, runtime } = await fixture();
    await expect(previews.open(card('project', { source: 'local', projectId: 'unknown' }))).rejects.toThrow();
    expect(runtime.inspect).not.toHaveBeenCalled();
  });

  it('isolates named and temporary map configurations without persisting or selecting them', async () => {
    const { previews, related, storageDir, card } = await fixture();
    const directory = webProjectDataDirectory(storageDir, related.folderPath); await mkdir(directory, { recursive: true });
    const saved = JSON.stringify({ activeConfigurationId: 'active', configurations: [{ id: 'active', name: 'Active', values: { title: 'Active' } }, { id: 'other', name: 'Other', values: { title: 'Other' } }] });
    await writeFile(path.join(directory, 'kanban.json'), saved);
    const first = await previews.open(card('kanban', { source: 'local', projectId: related.id, configurationId: 'other' }, { preview: true, kanban: { mode: 'preview', values: { title: 'Temporary' } } }));
    const second = await previews.open(card('project', { source: 'local', projectId: related.id }, { preview: true }));
    expect(first.data.kanban?.configuration).toMatchObject({ id: 'other', params: { title: 'Temporary' } });
    expect(second.data.kanban?.configuration).toMatchObject({ id: 'active', params: { title: 'Active' } });
    expect(await readFile(path.join(directory, 'kanban.json'), 'utf8')).toBe(saved);
    expect(String((await previews.asset(new URL(first.data.kanban!.url, 'http://localhost')))?.content)).toContain('Temporary');
    await expect(previews.open(card('kanban', { source: 'local', projectId: related.id, configurationId: 'deleted' }))).rejects.toThrow();
  });

  it('rejects file symlinks escaping an authorized project', async () => {
    const { previews, card, owner, related } = await fixture();
    await writeFile(path.join(owner.folderPath, 'private.txt'), 'Private');
    await symlink(path.join(owner.folderPath, 'private.txt'), path.join(related.folderPath, 'outside.txt'));
    await expect(previews.open(card('file', { source: 'local', projectId: related.id, filePath: 'outside.txt' }))).rejects.toThrow('File is outside');
  });

  it('allows preview reads but blocks data mutations and invalidates open previews on logout', async () => {
    const { previews, card, related, runtime, logout } = await fixture();
    const result = await previews.open(card('project', { source: 'local', projectId: related.id }, { preview: true }));
    await previews.bridge(result.id, { requestId: 'read', operation: 'kv.getValue', input: { key: 'map' } });
    expect(runtime.kanbanBridge).toHaveBeenCalledWith(expect.objectContaining({ id: related.id }), expect.objectContaining({ operation: 'kv.getValue' }));
    await expect(previews.bridge(result.id, { requestId: 'write', operation: 'kv.setValue', input: { key: 'map', value: 'changed' } })).rejects.toThrow('read-only');
    logout(); expect(() => previews.get(result.id)).toThrow(); expect(await previews.asset(new URL(result.data.kanban!.url, 'http://localhost'))).toBeUndefined();
  });

  it('discards a pending preview read after resource access changes', async () => {
    const { previews, card, related, runtime } = await fixture();
    const result = await previews.open(card('kanban', { source: 'local', projectId: related.id }));
    let finish!: (value: unknown) => void;
    vi.mocked(runtime.kanbanBridge!).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const reading = previews.bridge(result.id, { requestId: 'read', operation: 'kv.getValue', input: { key: 'map' } });
    const rejected = expect(reading).rejects.toThrow('Resource access changed');
    previews.clear(); finish({ private: 'previous account data' });
    await rejected;
  });

  it('discards a pending remote asset after resource access changes', async () => {
    const { previews, card } = await fixture();
    const prefix = 'https://workflow.test/api/workflows/board/kanban/previews/nonce/browser/local/';
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response(JSON.stringify({ errCode: 0, data:
      String(url).endsWith('/structure') ? { structure: { projectType: 'kanban' } } : {
        manifest: { params: [] }, configurations: [], preview: { url: `${prefix}index.html`, nonce: 'nonce' },
      } })));
    const result = await previews.open(card('kanban', { source: 'server', projectId: 'board' }));
    let finish!: (value: Response) => void;
    fetcher.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const reading = previews.asset(new URL(result.data.kanban!.url, 'http://localhost'));
    previews.clear(); finish(new Response('Previous account artifact'));
    expect(await reading).toBeUndefined();
  });

  it('preserves open previews for unchanged host credentials and invalidates them on logout', async () => {
    const { owner, runtime, storageDir } = await fixture();
    vi.mocked(runtime.inspect).mockResolvedValue({ projects: [owner], errors: [] });
    runtime.dispose = vi.fn();
    const connection = { serverUrl: 'https://workflow.test', accessToken: 'test-only-token' }, originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => String(url).endsWith('/api/auth/me')
      ? Promise.resolve(new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'user', email: 'test@example.com', displayName: 'User' } } })))
      : originalFetch(url, init));
    const app = await startWebServer({ projectDir: owner.folderPath, dataDir: storageDir, runtime, host: { surface: 'editor', connection } });
    const request = (message: object) => originalFetch(new URL('/api/message', app.url), { method: 'POST',
      headers: { Authorization: `Bearer ${new URLSearchParams(new URL(app.url).hash.slice(1)).get('session')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    try {
      app.controller.current.messages.push({ id: 'answer', role: 'assistant', content: '', items: [{ metadata: { kind: 'agent-part', partType: 'tool' },
        content: { tool: 'workflow-ui_present_card', status: 'success', output: { action: 'upsert', cardId: 'doc', kind: 'knowledge', target: { source: 'current', documentId: 'doc' } } } }] });
      const result = await (await request({ type: 'resource', messageId: 'answer', cardId: 'doc' })).json();
      const id = result.messages[0].id;
      await app.setHostConnection({ ...connection });
      expect(await (await request({ type: 'resource-data', id })).json()).toMatchObject({ messages: [{ data: { content: { markdown: '# Document' } } }] });
      const snapshot = () => originalFetch(new URL('/api/resource-state', app.url), {
        headers: { Authorization: `Bearer ${new URL(app.url).hash.slice('#session='.length)}` },
      }).then(response => response.json());
      const before = await snapshot();
      app.setHostResourceProjects([]);
      const after = await snapshot();
      expect(after.authenticationRevision).toBe(before.authenticationRevision);
      expect(after.resourceRevision).toBeGreaterThan(before.resourceRevision);
      expect((await request({ type: 'resource-data', id })).ok).toBe(false);
      await app.setHostConnection(undefined);
      expect((await request({ type: 'resource-data', id })).ok).toBe(false);
    } finally { await app.close(); }
  });

  it('keeps remote Kanban assets available after verifying the same account', async () => {
    const { owner, runtime, storageDir } = await fixture();
    vi.mocked(runtime.inspect).mockResolvedValue({ projects: [owner], errors: [] }); runtime.dispose = vi.fn();
    const connection = { serverUrl: 'https://workflow.test', accessToken: 'test-only-token' }, originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const address = String(url);
      if (!address.startsWith(connection.serverUrl)) { return originalFetch(url, init); }
      const data = address.endsWith('/api/auth/me') ? { profile: { userId: 'user', email: 'test@example.com', displayName: 'User' } }
        : address.endsWith('/structure') ? { structure: { projectType: 'kanban' } }
        : address.endsWith('/kanban') ? { manifest: { params: [] }, configurations: [],
          preview: { url: `${connection.serverUrl}/api/workflows/board/kanban/previews/nonce/browser/local/index.html`, nonce: 'nonce' } }
        : undefined;
      return Promise.resolve(data ? new Response(JSON.stringify({ errCode: 0, data })) : new Response('Remote board artifact'));
    });
    const app = await startWebServer({ projectDir: owner.folderPath, dataDir: storageDir, runtime, host: { surface: 'editor', connection } });
    const request = (message: object) => originalFetch(new URL('/api/message', app.url), { method: 'POST',
      headers: { Authorization: `Bearer ${new URL(app.url).hash.slice('#session='.length)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    try {
      app.controller.current.messages.push({ id: 'answer', role: 'assistant', content: '', items: [{ metadata: { kind: 'agent-part', partType: 'tool' },
        content: { tool: 'workflow-ui_present_card', status: 'success', output: { action: 'upsert', cardId: 'board', kind: 'kanban', target: { source: 'server', projectId: 'board' } } } }] });
      const opened = (await (await request({ type: 'resource', messageId: 'answer', cardId: 'board' })).json()).messages[0];
      const preview = (await (await request({ type: 'resource-data', id: opened.id })).json()).messages[0].data;
      const asset = () => originalFetch(new URL(preview.kanban.url, app.url));
      expect(await (await asset()).text()).toBe('Remote board artifact');
      expect((await request({ type: 'verify' })).ok).toBe(true);
      expect(await (await asset()).text()).toBe('Remote board artifact');
    } finally { await app.close(); }
  });
});
