import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { initI18n } from '@steamharness/i18n';
import { ResourcePreviews } from '../web/resource-preview';
import { startWebServer } from '../web/server';
import { cacheVerifiedConfigurationTemplate,createLocalProjectConfigurationStore } from 'steamharness';
import { createConfigurationState,createPublicationDraft,freezeConfigurationTemplate } from '@steamharness/project-configuration';
import { readProjectInfo } from '@steamharness/project-info';
import type { ResourceCard } from '../web/resource-cards';
import type { Project, Runtime } from '../web/workflow-types';

const folders: string[] = [], openedPreviews: ResourcePreviews[] = [];
beforeEach(() => initI18n({ preference: 'en' }));
afterEach(async () => { for(const previews of openedPreviews.splice(0))previews.close(); vi.restoreAllMocks(); for (const directory of folders.splice(0)) { await rm(directory, { recursive: true, force: true }); } });

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'workflow-resource-'))); folders.push(root);
  const storageDir = path.join(root, 'data');
  const owner: Project = { id: 'owner', uri: '', name: 'Owner', folderPath: root, projectType: 'conversation', fields: [], entrypoints: [] };
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ id: owner.id, steamHarness: { projectInfo: { dataStorage: { mode: 'local' } } } }));
  const related = { ...owner, id: 'related', name: 'Related', folderPath: path.join(root, 'related'), projectType: 'kanban' as const,
    kanban: { artifactDir: 'dist', entry: 'index.html' }, fields: [{ name: 'title', type: 'string', defaultValue: 'Default' }] };
  await mkdir(path.join(related.folderPath, 'dist'), { recursive: true });
  await writeFile(path.join(related.folderPath, 'package.json'), JSON.stringify({ id: related.id, steamHarness: { projectInfo: { dataStorage: { mode: 'local' } } } }));
  await writeFile(path.join(related.folderPath, 'dist/index.html'), '<html><head></head><body>Map preview</body></html>');
  const runtime = { inspect: vi.fn(async () => ({ projects: [related], errors: [] })), readResource: vi.fn(async () => ({ id: 'doc', markdown: '# Document' })),
    kanbanBridge: vi.fn(async () => ({ key: 'map' })) } as unknown as Runtime;
  let connection: { serverUrl: string; accessToken: string } | undefined = { serverUrl: 'https://steamharness.test', accessToken: 'test-only-token' };
  const previews = new ResourcePreviews(owner, runtime, storageDir, () => connection, () => [{ alias: 'map', projectDir: related.folderPath }]);
  openedPreviews.push(previews);
  const card = (kind: ResourceCard['kind'], target: Record<string, string>, extra: Partial<ResourceCard> = {}): ResourceCard => ({ id: 'card', kind, title: 'Resource', target, ...extra });
  return { root, owner, related, runtime, storageDir, previews, card, logout: () => { connection = undefined; previews.clear(); } };
}

function largePng(): Buffer {
  const chunk = (type: string, content: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), content]), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(content.length); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', Buffer.from('00000001000000010806000000', 'hex')),
    chunk('tEXt', Buffer.from(`Comment\0${'x'.repeat(3 * 1024 * 1024)}`)),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
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

  it.each(['kanban', 'project'] as const)('resolves current assistant %s cards to its workspace project', async kind => {
    const { owner, related, runtime, storageDir, card } = await fixture();
    owner.assistant = { workdir: related.folderPath, roots: [{ uri: 'file:///map', folderPath: related.folderPath, name: 'Map' }] };
    const previews = new ResourcePreviews(owner, runtime, storageDir, () => undefined, () => []);
    openedPreviews.push(previews);
    const result = await previews.open(card(kind, { source: 'local', projectId: owner.id }));
    expect(result.data).toMatchObject({ format: 'kanban', project: { id: related.id, folderPath: related.folderPath, projectType: 'kanban' } });
    expect(runtime.inspect).toHaveBeenCalledWith([related.folderPath]);
    expect(String((await previews.asset(new URL(result.data.kanban!.url, 'http://localhost')))?.content)).toContain('Map preview');
  });

  it('resolves explicit assistant workspace cards without requiring an imported project', async () => {
    const { owner, related, runtime, storageDir, card } = await fixture();
    owner.assistant = { workdir: related.folderPath, roots: [{ uri: 'file:///map', folderPath: related.folderPath, name: 'Map' }] };
    const previews = new ResourcePreviews(owner, runtime, storageDir, () => undefined, () => []);
    openedPreviews.push(previews);
    expect((await previews.open(card('project', { source: 'local', projectId: related.id }, { preview: false }))).data.project?.id).toBe(related.id);
  });

  it('does not substitute another imported project when the assistant workspace has no project', async () => {
    const { owner, related, runtime, storageDir, card } = await fixture();
    const workdir = path.join(owner.folderPath, 'folder');
    await mkdir(workdir);
    owner.assistant = { workdir, roots: [{ uri: 'file:///folder', folderPath: workdir, name: 'Folder' }] };
    vi.mocked(runtime.inspect).mockResolvedValue({ projects: [], errors: ['No project found.'] });
    const previews = new ResourcePreviews(owner, runtime, storageDir, () => undefined, () => [], () => [related.folderPath]);
    openedPreviews.push(previews);
    await expect(previews.open(card('kanban', { source: 'local', projectId: owner.id }))).rejects.toThrow('The resource project is unavailable.');
    expect(runtime.inspect).toHaveBeenCalledWith([workdir]);
    expect(runtime.inspect).toHaveBeenCalledTimes(1);
  });

  it('checks Server read access for foreign Knowledge and keeps credentials out of the preview data', async () => {
    const { previews, card } = await fixture();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ errCode: 0, data: { id: 'doc', markdown: '# Foreign document' } })));
    const result = await previews.open(card('knowledge', { source: 'server', projectId: 'database', documentId: 'doc' }));
    expect(fetcher).toHaveBeenCalledWith('https://steamharness.test/api/projects/database/knowledge-documents/doc', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-only-token' }), redirect: 'error' }));
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
    expect(url.pathname).toBe('/api/projects/database/kv/entry'); expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'conversation', conversationId: 'session-b', key: 'state' });
  });

  it('does not guess a local directory from a card project UUID', async () => {
    const { previews, card, runtime } = await fixture();
    await expect(previews.open(card('project', { source: 'local', projectId: 'unknown' }))).rejects.toThrow();
    expect(runtime.inspect).not.toHaveBeenCalled();
  });

  it('isolates named and temporary map configurations without persisting or selecting them', async () => {
    const { previews, related, storageDir, card } = await fixture();
    await writeFile(path.join(related.folderPath,'configuration.json'),JSON.stringify({version:1,fields:[{name:'title',type:'string',defaultValue:'Default'}]}));
    const store=await createLocalProjectConfigurationStore(related.folderPath);
    let state=await store.read(); const active=state.activeConfigurationId;
    state=await store.dispatch({action:'save',revision:state.revision,id:active,values:{title:'Active'}}) as typeof state;
    state=await store.dispatch({action:'create',revision:state.revision,name:'Other'}) as typeof state;
    const other=state.activeConfigurationId;
    state=await store.dispatch({action:'save',revision:state.revision,id:other,values:{title:'Other'}}) as typeof state;
    state=await store.dispatch({action:'select',revision:state.revision,id:active}) as typeof state;
    const saved=await store.read();
    const first = await previews.open(card('kanban', { source: 'local', projectId: related.id, configurationId: other }, { preview: true, kanban: { mode: 'preview', values: { title: 'Temporary' } } }));
    const second = await previews.open(card('project', { source: 'local', projectId: related.id }, { preview: true }));
    expect(first.data.kanban?.configuration).toMatchObject({ id: other, params: { title: 'Temporary' } });
    expect(second.data.kanban?.configuration).toMatchObject({ id: active, params: { title: 'Active' } });
    expect(await store.read()).toEqual(saved);
    expect(String((await previews.asset(new URL(first.data.kanban!.url, 'http://localhost')))?.content)).toContain('Temporary');
    await expect(previews.open(card('kanban', { source: 'local', projectId: related.id, configurationId: 'deleted' }))).rejects.toThrow();
  });

  it('enforces published locks on temporary card values without persisting permitted previews',async()=>{
    const {root,related,previews,card}=await fixture();
    vi.spyOn(os,'homedir').mockReturnValue(path.join(root,'host'));
    const author=createConfigurationState([{name:'settings',type:'json',defaultValue:{locked:0,open:false},sharing:{includeValue:true},paths:{'/locked':{editable:false}}}],()=> 'official');
    const template=freezeConfigurationTemplate(createPublicationDraft(author),{projectId:related.id,projectVersion:'1.0.0',sourceHash:'a'.repeat(64)});
    await cacheVerifiedConfigurationTemplate(template);
    await writeFile(path.join(related.folderPath,'configuration.template.json'),JSON.stringify(template));
    const store=await createLocalProjectConfigurationStore(related.folderPath),saved=await store.read();
    const preview=(settings:Record<string,number|boolean>)=>previews.open(card('kanban',{source:'local',projectId:related.id},{kanban:{mode:'preview',values:{settings}}}));
    await expect(preview({locked:1,open:true})).rejects.toMatchObject({code:'CONFIGURATION_FORBIDDEN'});
    await expect(preview({open:true})).rejects.toMatchObject({code:'CONFIGURATION_FORBIDDEN'});
    const opened=await preview({locked:0,open:true});
    expect(opened.data.kanban!.configuration.params).toEqual({settings:{locked:0,open:true}});
    expect(await store.read()).toEqual(saved);expect((await store.snapshot()).values.settings).toEqual({locked:0,open:false});
  });

  it.each(['notes.txt', 'notes.md'])('preserves %s content beyond 2 MiB', async filename => {
    const { previews, card, related } = await fixture();
    const content = `# Map annotations\n${'Coordinate: 100, 200\n'.repeat(150_000)}Last annotation`;
    await writeFile(path.join(related.folderPath, filename), content);
    const result = await previews.open(card('file', { source: 'local', projectId: related.id, filePath: filename }));
    expect(result.data.format).toBe(filename.endsWith('.md') ? 'markdown' : 'text');
    expect(result.data.content).toBe(content);
  });

  it('serves a large assistant workspace image as original bytes through a scoped asset URL', async () => {
    const { previews, card, owner, related } = await fixture();
    owner.assistant = { workdir: related.folderPath, roots: [{ uri: 'file:///map', folderPath: related.folderPath, name: 'Map' }] };
    const bytes = largePng(), filename = '厂区 · 圈选边界.PNG';
    await writeFile(path.join(related.folderPath, filename), bytes);
    const result = await previews.open(card('file', { source: 'local', projectId: owner.id, filePath: filename }));
    expect(result.data).toMatchObject({ format: 'image', content: `/resource-assets/${result.id}/image` });
    const url = new URL(String(result.data.content), 'http://localhost');
    const asset = await previews.asset(url);
    expect(asset?.content).toBeInstanceOf(Buffer);
    expect((asset!.content as Buffer).equals(bytes)).toBe(true);
    expect(asset?.headers).toMatchObject({ 'Content-Type': 'image/png', 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' });
    for (const suffix of ['other.png', 'image/private.txt', '%2e%2e%2fprivate.txt']) {
      expect(await previews.asset(new URL(`/resource-assets/${result.id}/${suffix}`, url))).toBeUndefined();
    }
  });

  it('rechecks image paths and revokes their asset URLs after resource access changes', async () => {
    const { previews, card, owner, related, logout } = await fixture();
    const filename = path.join(related.folderPath, 'map.svg');
    await writeFile(filename, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const result = await previews.open(card('file', { source: 'local', projectId: related.id, filePath: 'map.svg' }));
    const url = new URL(String(result.data.content), 'http://localhost');
    expect((await previews.asset(url))?.headers['Content-Type']).toBe('image/svg+xml');
    await writeFile(path.join(owner.folderPath, 'private.svg'), 'Private');
    await rm(filename); await symlink(path.join(owner.folderPath, 'private.svg'), filename);
    expect(await previews.asset(url)).toBeUndefined();
    await rm(filename); await writeFile(filename, '<svg/>');
    expect((await previews.asset(url))?.content).toEqual(Buffer.from('<svg/>'));
    logout();
    expect(await previews.asset(url)).toBeUndefined();
    expect(() => previews.get(result.id)).toThrow('Resource access changed');
  });

  it('does not report a file size error for directory targets', async () => {
    const { previews, card, related } = await fixture();
    await expect(previews.open(card('file', { source: 'local', projectId: related.id, filePath: 'dist' }))).rejects.toThrow('The preview target is not a file.');
  });

  it('rejects file symlinks escaping an authorized project', async () => {
    const { previews, card, owner, related } = await fixture();
    await writeFile(path.join(owner.folderPath, 'private.txt'), 'Private');
    await symlink(path.join(owner.folderPath, 'private.txt'), path.join(related.folderPath, 'outside.txt'));
    await expect(previews.open(card('file', { source: 'local', projectId: related.id, filePath: 'outside.txt' }))).rejects.toThrow('File is outside');
  });

  it('loads large file card images over HTTP without placing binary data in resource messages', async () => {
    const { owner, related, runtime, storageDir } = await fixture();
    owner.assistant = { workdir: related.folderPath, roots: [{ uri: 'file:///map', folderPath: related.folderPath, name: 'Map' }] };
    vi.mocked(runtime.inspect).mockResolvedValue({ projects: [owner], errors: [] }); runtime.dispose = vi.fn();
    const bytes = largePng(); await writeFile(path.join(related.folderPath, 'map.png'), bytes);
    const app = await startWebServer({ projectDir: owner.folderPath, dataDir: storageDir, runtime, host: { surface: 'editor' } });
    const request = (message: object) => fetch(new URL('/api/message', app.url), { method: 'POST',
      headers: { Authorization: `Bearer ${new URL(app.url).hash.slice('#session='.length)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    try {
      app.controller.current.messages.push({ id: 'answer', role: 'assistant', content: '', items: [{ metadata: { kind: 'agent-part', partType: 'tool' },
        content: { tool: 'workflow-ui_present_card', status: 'success', output: { action: 'upsert', cardId: 'image', kind: 'file',
          target: { source: 'current', filePath: 'map.png' } } } }] });
      const opened = (await (await request({ type: 'resource', messageId: 'answer', cardId: 'image' })).json()).messages[0];
      const preview = (await (await request({ type: 'resource-data', id: opened.id })).json()).messages[0].data;
      expect(preview).toMatchObject({ format: 'image', content: `/resource-assets/${opened.id}/image` });
      const url = new URL(preview.content, app.url), response = await fetch(url);
      expect(response.ok).toBe(true); expect(response.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
      const head = await fetch(url, { method: 'HEAD', headers: { Origin: 'null' } });
      expect(head.ok).toBe(true); expect(head.headers.get('content-length')).toBe(String(bytes.length));
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      app.setHostResourceProjects([]);
      expect((await fetch(url)).status).toBe(404);
    } finally { await app.close(); }
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
    const prefix = 'https://steamharness.test/api/projects/board/kanban/previews/nonce/browser/local/';
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response(JSON.stringify({ errCode: 0, data:
      String(url).endsWith('/structure') ? { structure: { projectType: 'kanban' } } : String(url).endsWith('/configurations') ? createConfigurationState([],()=> 'default') : {
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
    const connection = { serverUrl: 'https://steamharness.test', accessToken: 'test-only-token' }, originalFetch = globalThis.fetch;
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
    const connection = { serverUrl: 'https://steamharness.test', accessToken: 'test-only-token' }, originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const address = String(url);
      if (!address.startsWith(connection.serverUrl)) { return originalFetch(url, init); }
      const data = address.endsWith('/api/auth/me') ? { profile: { userId: 'user', email: 'test@example.com', displayName: 'User' } }
        : address.endsWith('/structure') ? { structure: { projectType: 'kanban' } }
        : address.endsWith('/configurations') ? createConfigurationState([],()=> 'default')
        : address.endsWith('/kanban') ? { manifest: { params: [] }, configurations: [],
          preview: { url: `${connection.serverUrl}/api/projects/board/kanban/previews/nonce/browser/local/index.html`, nonce: 'nonce' } }
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

  it('opens and restores a current assistant map card with its named configuration and server data', async () => {
    const { owner, related, runtime, storageDir } = await fixture();
    await writeFile(path.join(related.folderPath, 'configuration.json'), JSON.stringify({ version: 1, fields: [{ name: 'title', type: 'string' }] }));
    const store = await createLocalProjectConfigurationStore(related.folderPath);
    await store.read();
    let configuration = await store.read();
    const configurationId = configuration.activeConfigurationId;
    configuration = await store.dispatch({ action: 'save', revision: configuration.revision, id: configurationId, values: { title: 'Named map' } }) as typeof configuration;
    configuration = await store.dispatch({ action: 'create', revision: configuration.revision, name: 'Another map' }) as typeof configuration;
    const map: Project = { ...related, projectInfo: readProjectInfo({ steamHarness: { projectInfo: { dataStorage: { mode: 'server' } } } }) };
    vi.mocked(runtime.inspect).mockImplementation(async directories => ({ projects: [directories[0] === owner.folderPath ? owner : map], errors: [] }));
    runtime.dispose = vi.fn();
    const originalFetch = globalThis.fetch, connection = { serverUrl: 'https://steamharness.test', accessToken: 'test-only-token' };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (String(url).endsWith('/api/auth/me')) {
        return Promise.resolve(new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'user', email: 'user@example.test', displayName: 'User' } } })));
      }
      if (String(url) === `${connection.serverUrl}/api/projects/${map.id}/kanban/bridge`) {
        return Promise.resolve(new Response(JSON.stringify({ errCode: 0, data: { key: 'map', value: { points: ['Spawn'] } } })));
      }
      return originalFetch(url, init);
    });
    const app = await startWebServer({ projectDir: owner.folderPath, dataDir: storageDir, runtime,
      host: { surface: 'assistant', assistantProjectDir: owner.folderPath, connection,
        assistant: { workdir: map.folderPath, roots: [{ uri: 'file:///map', folderPath: map.folderPath, name: 'Map' }] } } });
    const request = async (message: object) => {
      const response = await originalFetch(new URL('/api/message', app.url), { method: 'POST',
        headers: { Authorization: `Bearer ${new URL(app.url).hash.slice('#session='.length)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
      const body = await response.json();
      expect(body, JSON.stringify(body)).toHaveProperty('messages');
      expect(response.ok).toBe(true);
      return body.messages[0];
    };
    const presentation = { action: 'upsert', cardId: 'spawn-point', kind: 'kanban', title: 'Map · Spawn', pinned: true, preview: true,
      target: { source: 'current', configurationId } };
    app.controller.current.messages.push({ id: 'answer', role: 'assistant', content: '', items: [{ metadata: { kind: 'agent-part', partType: 'tool' },
      content: { tool: 'workflow-ui_present_card', input: presentation, status: 'success', output: { content: [{ type: 'text', text: JSON.stringify(presentation) }], details: {} } } }] });
    try {
      const opened = await request({ type: 'resource', messageId: 'answer', cardId: 'spawn-point', action: 'inline' });
      expect(opened.project).toMatchObject({ id: map.id, folderPath: map.folderPath });
      const reference = JSON.parse(new URL(opened.url, app.url).searchParams.get('resourceRef')!);
      for (const message of [{ type: 'resource-data', id: opened.id }, { type: 'resource-refresh', reference }]) {
        const preview = await request(message);
        expect(preview.data).toMatchObject({ format: 'kanban', project: { id: map.id },
          kanban: { configuration: { id: configurationId, params: { title: 'Named map' } } } });
        expect(await (await originalFetch(new URL(preview.data.kanban.url, app.url))).text()).toContain('Map preview');
        const call = { requestId: 'read', operation: 'kv.getValue', input: { key: 'map' } };
        expect(await request({ type: 'resource-bridge', id: preview.id ?? opened.id, call })).toMatchObject({ value: { value: { points: ['Spawn'] } } });
        expect(fetcher).toHaveBeenCalledWith(`${connection.serverUrl}/api/projects/${map.id}/kanban/bridge`,
          expect.objectContaining({ body: JSON.stringify({ call }), headers: expect.objectContaining({ Authorization: 'Bearer test-only-token' }) }));
      }
      expect(await store.read()).toEqual(configuration);
      expect(runtime.kanbanBridge).not.toHaveBeenCalled();
      expect(app.project.id).toBe(owner.id);
    } finally { await app.close(); }
  });

  it('refreshes an expired map card from its original conversation and rechecks imported projects', async () => {
    const { owner, related, runtime, storageDir } = await fixture();
    vi.mocked(runtime.inspect).mockImplementation(async directories => ({ projects: [directories[0] === owner.folderPath ? owner : related], errors: [] }));
    runtime.dispose = vi.fn();
    const app = await startWebServer({ projectDir: owner.folderPath, dataDir: storageDir, runtime,
      host: { surface: 'editor', resourceProjects: [related.folderPath] } });
    const request = (message: object) => fetch(new URL('/api/message', app.url), { method: 'POST',
      headers: { Authorization: `Bearer ${new URL(app.url).hash.slice('#session='.length)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    const original = app.controller.current;
    original.messages.push({ id: 'answer', role: 'assistant', content: '', items: [{ metadata: { kind: 'agent-part', partType: 'tool' },
      content: { tool: 'map_open_kanban', status: 'success', output: { details: { resourceCard: {
        action: 'upsert', cardId: 'map', kind: 'project', title: 'Map', target: { source: 'local', projectId: related.id }, preview: true,
      } } } } }] });
    try {
      const opened = (await (await request({ type: 'resource', messageId: 'answer', cardId: 'map' })).json()).messages[0];
      const reference = JSON.parse(new URL(opened.url, app.url).searchParams.get('resourceRef')!);
      expect(reference).toEqual({ sessionId: original.id, messageId: 'answer', cardId: 'map' });
      const first = (await (await request({ type: 'resource-data', id: opened.id })).json()).messages[0].data;
      await app.controller.create();
      expect(app.controller.current.id).not.toBe(original.id);
      await writeFile(path.join(related.folderPath, 'dist/index.html'), '<html><head></head><body>Updated map</body></html>');
      for (const type of ['resource-refresh', 'resource-data']) {
        app.setHostResourceProjects([related.folderPath]);
        expect((await request({ type, id: opened.id })).ok).toBe(false);
        const response = await request({ type, id: opened.id, reference });
        expect(response.ok).toBe(true);
        const fresh = (await response.json()).messages[0];
        expect(fresh.id).not.toBe(opened.id);
        expect(fresh.data.kanban.nonce).not.toBe(first.kanban.nonce);
        expect(await (await fetch(new URL(fresh.data.kanban.url, app.url))).text()).toContain('Updated map');
        expect((await fetch(new URL(first.kanban.url, app.url))).status).toBe(404);
      }
      app.setHostResourceProjects([]);
      expect(await (await request({ type: 'resource-refresh', id: opened.id, reference,
        target: { projectId: owner.id }, selection: { projectId: owner.id } })).json()).toMatchObject({ message: expect.stringContaining('Import or open') });
      app.setHostResourceProjects([related.folderPath]);
      expect((await request({ type: 'resource-refresh', id: opened.id, reference: { ...reference, cardId: 'forged' } })).ok).toBe(false);
      original.messages.length = 0;
      expect(await (await request({ type: 'resource-refresh', id: opened.id, reference })).json()).toMatchObject({ message: 'This resource no longer exists.' });
    } finally { await app.close(); }
  });

  it('rechecks server access when recovering an expired saved card', async () => {
    const { owner, runtime, storageDir } = await fixture();
    vi.mocked(runtime.inspect).mockResolvedValue({ projects: [owner], errors: [] }); runtime.dispose = vi.fn();
    const connection = { serverUrl: 'https://steamharness.test', accessToken: 'test-only-token' }, originalFetch = globalThis.fetch;
    const remote = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => String(url).startsWith(connection.serverUrl)
      ? Promise.resolve(new Response(JSON.stringify({ errCode: 0, data: String(url).endsWith('/api/auth/me')
        ? { profile: { userId: 'user', email: 'test@example.com', displayName: 'User' } } : { markdown: '# Server document' } })))
      : originalFetch(url, init));
    const app = await startWebServer({ projectDir: owner.folderPath, dataDir: storageDir, runtime, host: { surface: 'editor', connection } });
    const request = (message: object) => originalFetch(new URL('/api/message', app.url), { method: 'POST',
      headers: { Authorization: `Bearer ${new URL(app.url).hash.slice('#session='.length)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    app.controller.current.messages.push({ id: 'answer', role: 'assistant', content: '', items: [{ metadata: { kind: 'agent-part', partType: 'tool' },
      content: { tool: 'workflow-ui_present_card', status: 'success', output: { action: 'upsert', cardId: 'doc', kind: 'knowledge',
        target: { source: 'server', projectId: owner.id, documentId: 'doc' } } } }] });
    try {
      const opened = (await (await request({ type: 'resource', messageId: 'answer', cardId: 'doc' })).json()).messages[0];
      const reference = JSON.parse(new URL(opened.url, app.url).searchParams.get('resourceRef')!);
      await app.setHostConnection(undefined);
      const calls = remote.mock.calls.length;
      expect(await (await request({ type: 'resource-refresh', id: opened.id, reference })).json()).toMatchObject({ message: 'Please sign in to preview this server resource.' });
      expect(remote).toHaveBeenCalledTimes(calls);
      await app.setHostConnection(connection);
      remote.mockResolvedValue(new Response(JSON.stringify({ errCode: 403, errMessage: 'Access denied' }), { status: 403 }));
      expect(await (await request({ type: 'resource-refresh', id: opened.id, reference })).json()).toMatchObject({ message: 'Access denied' });
    } finally { await app.close(); }
  });
});

it('refreshes a related map card after its configuration changes through another surface',async()=>{
  const {previews,related,card}=await fixture();
  const store=await createLocalProjectConfigurationStore(related.folderPath);
  let state=await store.read();
  state=await store.dispatch({action:'field.save',revision:state.revision,field:{name:'label',type:'string'}}) as typeof state;
  const opened=await previews.open(card('kanban',{source:'local',projectId:related.id}));
  await store.dispatch({action:'save',revision:state.revision,id:state.activeConfigurationId,values:{label:'updated'}});
  await vi.waitFor(()=>expect(()=>previews.get(opened.id)).toThrow(),{timeout:2500});
  const refreshed=await previews.open(card('kanban',{source:'local',projectId:related.id}));
  expect(refreshed.data.kanban?.configuration.params.label).toBe('updated');
});
