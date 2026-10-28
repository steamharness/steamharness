import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as core from 'steamharness';
import { startEntryWebServer as startWebServer } from '../web/server';
import { configurationTemplatePath } from '@steamharness/project-configuration';
import { runKanbanDataCall, webProjectDataDirectory } from '../web/kanban-data';
import type { Project, Runtime } from '../web/workflow-types';
import { resolveHarnessRoot, resolveHarnessVersion } from './harness-source';

const folders: string[] = [], apps: Awaited<ReturnType<typeof startWebServer>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) { await app.close(); } for (const folder of folders.splice(0)) { await rm(folder, { recursive: true, force: true }); } vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const id = '2bf9074d-ef0b-43b2-84c4-f379f920db92';
it('uploads configuration files through the project server independently of the preview and rejects stale targets',async()=>{
  const {app,directory,post}=await fixture({noParams:true});
  await writeFile(path.join(directory,'configuration.json'),JSON.stringify({version:1,fields:[{name:'image',type:'file',accept:['image/png']}]}));
  const original=fetch,uploaded=vi.fn();
  vi.spyOn(globalThis,'fetch').mockImplementation((url,options)=>{
    if(!String(url).startsWith('https://configuration-files.test'))return original(url,options);
    if(String(url).includes('/files?')){uploaded(url,options);return Promise.resolve(new Response(JSON.stringify({errCode:0,data:[{id:'wf_ab12',name:'map.png',mimeType:'image/png',size:3,storage:'server',projectId:id}]})));}
    return Promise.resolve(new Response(JSON.stringify({errCode:0,data:{profile:{userId:'user',email:'user@example.com',displayName:'User'}}})));
  });
  await app.setHostConnection({serverUrl:'https://configuration-files.test',accessToken:'map.png'});
  const current=(await post({type:'ready'}).then(r=>r.json())).messages[0].configurations;
  const message={type:'project-configuration-upload',key:'image',id:current.activeConfigurationId,revision:current.revision,file:{name:'map.png',mimeType:'image/png',data:'cG5n'}};
  const response=await post(message).then(r=>r.json());
  expect(response.messages[0]).toMatchObject({type:'project-configuration-upload-result',value:{id:'wf_ab12',name:'map.png',storage:'server'}});
  expect(uploaded).toHaveBeenCalledOnce();expect(uploaded.mock.calls[0]![1].body).toEqual(Buffer.from('png'));
  for(const invalid of [{...message,revision:current.revision+1},{...message,id:'other-profile'},{...message,key:'unknown'}])expect((await post(invalid)).ok).toBe(false);
  expect(uploaded).toHaveBeenCalledOnce();
  await app.setHostConnection(undefined);expect((await post(message)).ok).toBe(false);
});
it('keeps uploads on the verified local template version and checks local author locks',async()=>{
  const {app,root,directory,post,state}=await fixture({noParams:true});
  vi.spyOn(os,'homedir').mockReturnValue(path.join(root,'host'));
  const author=core.createConfigurationState([{name:'image',type:'file',accept:['image/png']}],()=> 'official');
  const template=core.freezeConfigurationTemplate(core.createPublicationDraft(author),{projectId:id,entryId:"main",projectVersion:'1.0.0',sourceHash:'a'.repeat(64)});
  await core.cacheVerifiedConfigurationTemplate(template);
  await mkdir(path.join(directory,'configuration-templates/main'),{recursive:true});await writeFile(path.join(directory,configurationTemplatePath('main')),JSON.stringify(template));
  const original=fetch,uploaded=vi.fn();
  vi.spyOn(globalThis,'fetch').mockImplementation((url,options)=>{
    if(!String(url).startsWith('https://configuration-files.test'))return original(url,options);
    if(String(url).includes('/files?')){uploaded(url,options);return Promise.resolve(new Response(JSON.stringify({errCode:0,data:[{id:'wf_ab12',name:'map.png',mimeType:'image/png',size:3,storage:'server',projectId:id}]})));}
    return Promise.resolve(new Response(JSON.stringify({errCode:0,data:{profile:{userId:'user',email:'user@example.com',displayName:'User'}}})));
  });
  await app.setHostConnection({serverUrl:'https://configuration-files.test',accessToken:'account-capability'});
  const current=(await state()).configurations;
  const message={type:'project-configuration-upload',key:'image',id:current.activeConfigurationId,revision:current.revision,file:{name:'map.png',mimeType:'image/png',data:'cG5n'}};
  expect((await post(message)).ok).toBe(true);
  expect(uploaded).toHaveBeenCalledOnce();
  expect(new URL(String(uploaded.mock.calls[0]![0])).searchParams.get('target')).toBe('1.0.0');
  const next=structuredClone(template);next.projectVersion='2.0.0';next.fields[0]!.sharing={...next.fields[0]!.sharing,editable:false};
  await core.cacheVerifiedConfigurationTemplate(next);await writeFile(path.join(directory,configurationTemplatePath('main')),JSON.stringify(next));
  const changed=(await state()).configurations;
  expect((await post({...message,revision:changed.revision})).ok).toBe(false);
  expect(uploaded).toHaveBeenCalledOnce();
});
async function fixture(options: { server?: boolean; artifact?: boolean; noParams?: boolean; real?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'steamharness-kanban-'))); folders.push(root);
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'host'));vi.stubEnv('STEAMHARNESS_DATABASES_DIR',path.join(root,'registry'));
  const directory = path.join(root, 'board'); await mkdir(directory);
  const descriptor: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:directory,databases:[],entries:[{entryId:"main",name:"Main",type:'kanban',root:".",entry:"index.html",databases:[]}], id, name: 'Board', uri: '', folderPath: directory, projectType: 'kanban', fields: [], entrypoints: [] };
  const registration={entryId:'main',name:'Board',type:'kanban' as const,root:options.artifact?'dist':'.',entry:options.artifact?'pages/index.html':'index.html',configuration:'configuration.json',databases:[] as core.DatabaseRequirement[]};
  if(options.real){const registry=new core.LocalDatabaseRegistry();const permissions={kv:{read:{mode:'all' as const},write:{mode:'all' as const}},knowledge:{read:{mode:'all' as const},write:{mode:'all' as const}}};const request=registry.request({projectId:id,entryId:'main',alias:'data',permissions,target:{kind:'create',name:'Board'}});const approval=registry.review(request.requestId,{approve:true});registration.databases=[{alias:'data',host:'local',permissions,bindingRef:approval.bindingRef}];}
  const pkg = { id, name: 'Board', type: 'module', devDependencies: { 'steamharness': await resolveHarnessVersion() }, steamHarness: { defaultEntry:'main',entries:[registration] } };
  Object.assign(descriptor,{entryRoot:path.resolve(directory,registration.root),entries:[registration],databases:registration.databases});
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(pkg));
  const artifactRoot = options.artifact ? path.join(directory, 'dist/pages') : directory;
  await mkdir(artifactRoot, { recursive: true }); await writeFile(path.join(artifactRoot, 'index.html'), '<!doctype html><script>window.boardLoaded = true;</script><h1>Board</h1>'); await writeFile(path.join(artifactRoot, 'board.js'), 'window.assetLoaded = true;');
  { await writeFile(path.join(directory, registration.root, 'configuration.json'), JSON.stringify({ version: 1, fields:options.noParams?[]: [{ name: 'title', type: 'string', defaultValue: 'Roadmap' }, { name: 'limit', type: 'number', defaultValue: 5 }, { name: 'visible', type: 'boolean', defaultValue: true }, { name: 'tags', type: 'string', multiple: true, defaultValue: ['a'] }] })); }
  const runtime: Runtime = { available: true, inspect: vi.fn(async () => ({ projects: [{ ...descriptor, id: JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).id }], errors: [] })), resolveParams: vi.fn(async () => ({})), run: vi.fn(async () => ({ status: 'success' })), uploadFiles: vi.fn(async () => []), readFile: vi.fn(), deleteFiles: vi.fn(), cancelConversation: vi.fn(async () => {}), deleteConversation: vi.fn(), readResource: vi.fn(), cancel: vi.fn(), dispose: vi.fn(), kanbanBridge: vi.fn(async (_project, call) => ({ operation: call.operation })) };
  const dataDir = path.join(root, 'data');
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(root, 'auth')); vi.stubEnv('STEAMHARNESS_SERVER_URL', ''); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', '');
  if (options.real) {
    await mkdir(path.join(directory, 'node_modules'));
    const harnessRoot = await resolveHarnessRoot();
    await symlink(harnessRoot, path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const app = await startWebServer({ projectDir: directory, dataDir, runtime: options.real ? undefined : runtime }); apps.push(app);
  const token = new URL(app.url).hash.slice('#session='.length);
  const post = (message: object) => fetch(`${app.origin}/api/message`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
  const state = async () => (await post({ type: 'ready' }).then(response => response.json())).messages[0];
  const action = async (action: string, extra: object = {}) => { const current = (await state()).kanban; return post({ type: 'project-configuration', call: {action, id: current.activeConfigurationId, revision: current.revision, ...extra} }); };
  const bridge = async (operation: string, input = {}) => { const current = (await state()).kanban; return post({ type: 'kanban-bridge', nonce: current.preview.nonce, requestId: 'request', call: { requestId: 'bridge', operation, input: operation.startsWith('studio.')||operation.startsWith('runtime.')?input:{database:'data',...input} } }).then(response => response.json()).then(value => value.messages[0]); };
  return { app, root, directory, dataDir, pkg, post, state, action, bridge, runtime };
}

describe('Kanban CLI Web workspace', () => {
  it('routes local Studio analysis through its read-only host capability without Server login', async () => {
    const { bridge, runtime } = await fixture();
    vi.stubEnv('STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', ''); vi.stubEnv('STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN', '');
    expect(await bridge('studio.getLocalAnalysis')).toMatchObject({ ok: false, error: { code: 'KANBAN_BRIDGE_UNAVAILABLE' } });
    vi.stubEnv('STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'http://127.0.0.1:12345/studio-control'); vi.stubEnv('STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN', 'test-capability');
    const fetchImpl = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input).endsWith('/studio-control')) {
        expect(JSON.parse(String(options?.body))).toEqual({ operation: 'studio.analysis.get', input: {}, permissionPolicy: 'read-only' });
        return new Response(JSON.stringify({ ok: true, value: { version: 1, projects: [] } }), { status: 200 });
      }
      return fetchImpl(input, options);
    });
    expect(await bridge('studio.getLocalAnalysis')).toMatchObject({ ok: true, value: { version: 1, projects: [] } });
    expect(runtime.kanbanBridge).not.toHaveBeenCalled();
  });
  it('cancels the Studio query when the Kanban controller closes', async () => {
    const { app } = await fixture();
    vi.stubEnv('STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'http://127.0.0.1:12345/studio-control'); vi.stubEnv('STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN', 'test-capability');
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, options) => {
      signal = options?.signal as AbortSignal;
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    });
    const controller = app.kanbanController!;
    const query = controller.bridge({ requestId: 'closing', operation: 'studio.getLocalAnalysis', input: {} });
    const failed = expect(query).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await controller.close(); await failed; expect(signal!.aborted).toBe(true);
  });
  it('preserves custom parameter and bridge data keys that resemble credential names', async () => {
    const { directory, post, state, action, bridge, runtime } = await fixture();
    await writeFile(path.join(directory, 'configuration.json'), JSON.stringify({ version: 1, fields: [{ name: 'apiKey', type: 'string', defaultValue: 'project-key' }] }));
    await post({ type: 'kanban-refresh' });
    expect((await state()).kanban.configuration.params.apiKey).toBe('project-key');
    await action('save', { values: { apiKey: 'updated-key' } });
    expect((await state()).kanban.configurations[0].values.apiKey).toBe('updated-key');
    vi.mocked(runtime.kanbanBridge!).mockResolvedValue({ apiKey: 'stored-project-key', secretLabel: 'business data' });
    expect((await bridge('kv.getValue', { key: 'settings' })).value).toEqual({ apiKey: 'stored-project-key', secretLabel: 'business data' });
  });
  it('exports complete configuration values even when they match a host credential or attachment shape', async () => {
    const {app,directory,post,state,action}=await fixture();
    const realFetch=globalThis.fetch;
    vi.spyOn(globalThis,'fetch').mockImplementation((url,options)=>String(url).startsWith('https://configuration.test')
      ? Promise.resolve(new Response(JSON.stringify({errCode:0,data:{profile:{userId:'user',email:'user@example.com',displayName:'User'}}}))) : realFetch(url,options));
    await app.setHostConnection({serverUrl:'https://configuration.test',accessToken:'explicit-project-key'});
    await writeFile(path.join(directory,'configuration.json'),JSON.stringify({version:1,fields:[{name:'credentials',type:'json',secret:true}]}));
    await post({type:'kanban-refresh'});
    const credentials={apiKey:'explicit-project-key',file:{id:`wf_${'a'.repeat(32)}`,mimeType:'application/json',path:'literal-json-value'}};
    await action('save',{values:{credentials}});
    const current=await state();
    expect(current.configurations!.configurations[0].values.credentials).toEqual(credentials);
    expect(JSON.stringify(current.account)).not.toContain('explicit-project-key');
    const result=await post({type:'project-configuration',call:{action:'export'}}).then(response=>response.json());
    expect(result.messages[0].value.configurations[0].values.credentials).toEqual(credentials);
  });

  it('routes to a dedicated page and persists only user-declared configuration values', async () => {
    const { app, action, state, directory, dataDir } = await fixture();
    expect(await fetch(app.origin).then(response => response.text())).toContain('/assets/kanban-workspace.js');
    expect((await state()).kanban.configuration.params).toEqual({ title: 'Roadmap', limit: 5, visible: true, tags: ['a'] });
    expect((await action('save', {values:{invented:'rejected'}})).status).toBe(400);
    await action('save', { values: { title: 'Custom', limit: 12, visible: false, tags: ['b'] } });
    expect((await state()).kanban.configuration.params).toEqual({ title: 'Custom', limit: 12, visible: false, tags: ['b'] });
    expect(app.controller).toBeUndefined(); expect(app.projectController).toBeUndefined();
    const stored = await (await core.createLocalProjectConfigurationStore(directory)).read();
    expect(stored.configurations[0].values.invented).toBeUndefined();
    await expect(readFile(path.join(webProjectDataDirectory(dataDir, app.project.id, 'main'), 'conversations.json'))).rejects.toHaveProperty('code', 'ENOENT');
  });
  it('creates, duplicates, renames, selects and deletes configurations with revision protection', async () => {
    const { app, state, action, post, dataDir, runtime } = await fixture(); const first = (await state()).kanban;
    await action('save', { values: { title: 'First' } }); await action('duplicate');
    const copy = (await state()).kanban; expect(copy.configurations).toHaveLength(2); expect(copy.configuration.params.title).toBe('First');
    await action('rename', { name: 'Second' }); expect((await state()).kanban.configuration.name).toBe('Second');
    expect((await post({ type: 'project-configuration', call:{action: 'save', id: first.activeConfigurationId, revision: first.revision, values: { title: 'Stale' }} })).status).toBe(400);
    await action('select', { id: first.activeConfigurationId }); expect((await state()).kanban.preview.nonce).not.toBe(copy.preview.nonce);
    await action('delete'); expect((await state()).kanban.configurations).toHaveLength(1); expect((await action('delete')).status).toBe(400);
    expect((await action('rename', { name: ' ' })).status).toBe(400); expect((await action('save', { values: { title: 2 } })).status).toBe(400);
    const history = app.kanbanController!.workspace; await app.close();
    const restarted = await startWebServer({ projectDir: app.project.folderPath, dataDir, runtime: { ...runtime, dispose: vi.fn() } }); apps.push(restarted);
    expect(restarted.kanbanController!.workspace.configurations).toEqual(history.configurations);
  });
  it('keeps the committed configuration and revision after a failed save so the same action can be retried', async () => {
    const { app, state, post } = await fixture();
    const before = (await state()).kanban;
    vi.spyOn(app.configurations, 'dispatch').mockRejectedValueOnce(new Error('Disk unavailable'));
    const message = { type: 'project-configuration', call:{action: 'save', id: before.activeConfigurationId, revision: before.revision, values: { title: 'Retry' }} };
    expect((await post(message)).status).toBe(400);
    const failed = (await state()).kanban;
    expect(failed.revision).toBe(before.revision); expect(failed.configuration).toEqual(before.configuration);
    expect(failed.preview).toEqual(before.preview);
    expect((await post(message)).status).toBe(200);
    expect((await state()).kanban.configuration.params.title).toBe('Retry');
  });
  it('refreshes declarations without overwriting committed values and rejects a stale editor', async () => {
    const { app, state, action, post, directory } = await fixture();
    await action('save', { values: { title: 'Saved' } });
    const before = (await state()).kanban;
    await writeFile(path.join(directory, 'configuration.json'), JSON.stringify({ version: 1, fields: [{ name: 'title', type: 'string' }, { name: 'new', type: 'string', defaultValue: 'New' }] }));
    await post({type:'kanban-refresh'});
    const next = (await state()).kanban;
    expect(next.configuration.params).toEqual({title:'Saved',new:'New'});
    expect(next.revision).toBe(before.revision+1);
    expect((await post({type:'project-configuration',call:{action:'save',revision:before.revision,id:before.activeConfigurationId,values:{title:'Stale'}}})).ok).toBe(false);
    expect(app.configurations!.state.revision).toBe(next.revision);
  });
  it('retains the previous preview and project declaration after an invalid manifest refresh', async () => {
    const { app, state, post, directory, pkg } = await fixture();
    const before = (await state()).kanban, artifact = { ...app.project.kanban! };
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ ...pkg, steamHarness: { ...pkg.steamHarness, entries:[{...pkg.steamHarness.entries[0],root:'other'}] } }));
    await writeFile(path.join(directory, 'configuration.json'), '{');
    expect((await post({ type: 'kanban-refresh' })).status).toBe(400);
    expect(app.project.kanban).toEqual(artifact);
    expect((await state()).kanban).toEqual(before);
  });
  it('serves nonced HTML and relative assets from the declared artifact with sandbox CORS', async () => {
    const { app, state, directory } = await fixture({ artifact: true }); const preview = (await state()).kanban.preview;
    const response = await fetch(`${app.origin}${preview.url}`); expect(response.status).toBe(200);
    expect(await response.text()).toContain('"steamHarnessKanban"'); expect(response.headers.get('Content-Security-Policy')).toContain(`nonce-${preview.nonce}`);
    const script = await fetch(`${app.origin}/kanban/${preview.nonce}/pages/board.js`, { headers: { Origin: 'null' } }); expect(script.status).toBe(200); expect(script.headers.get('Access-Control-Allow-Origin')).toBe('*');
    for (const name of ['package.json', 'configuration.json', '%2e%2e%2fpackage.json', '%5cpackage.json', '.env']) { expect((await fetch(`${app.origin}/kanban/${preview.nonce}/${name}`)).status).toBe(404); }
    await writeFile(path.join(directory, 'outside.js'), 'secret');
    try { await symlink(path.join(directory, 'outside.js'), path.join(directory, 'dist/linked.js')); } catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { return; } throw error; }
    expect((await fetch(`${app.origin}/kanban/${preview.nonce}/linked.js`)).status).toBe(404);
    expect((await fetch(`${app.origin}/kanban/wrong/pages/index.html`)).status).toBe(404);
    expect((await fetch(`${app.origin}/api/session`, { headers: { Origin: 'null' } })).status).toBe(403);
  });
  it('rejects stale/invalid bridge calls and isolates Kanban from Conversation actions', async () => {
    const { post, runtime, state, action } = await fixture(); const old = (await state()).kanban.preview.nonce;
    expect((await post({ type: 'send', text: 'invalid' })).status).toBe(400);
    expect(await post({ type: 'kanban-bridge', nonce: old, call: { requestId: 'x', operation: 'exec', input: {} } }).then(response => response.json())).toMatchObject({ messages: [{ ok: false }] });
    await action('create');
    expect(await post({ type: 'kanban-bridge', nonce: old, call: { requestId: 'x', operation: 'kv.setValue', input: { database:'data',key: 'value', value: 1 } } }).then(response => response.json())).toMatchObject({ messages: [{ ok: false, error: { code: 'KANBAN_BRIDGE_SESSION_INVALID' } }] });
    expect(runtime.kanbanBridge).not.toHaveBeenCalled();
  });
  it('loads projects without a parameter manifest and refreshes build outputs and parameter definitions', async () => {
    const { directory, state, action, post } = await fixture({ noParams: true });
    expect((await state()).kanban.configurations).toHaveLength(1); expect((await action('create')).status).toBe(200);
    await writeFile(path.join(directory, 'configuration.json'), JSON.stringify({ version: 1, fields: [{ name: 'custom', type: 'string', defaultValue: 'New' }] }));
    await post({ type: 'kanban-refresh' }); expect((await state()).kanban.configuration.params).toEqual({ custom: 'New' });
    const beforeBuild = (await state()).kanban;
    await writeFile(path.join(directory, 'board.js'), 'window.assetLoaded = "rebuilt";');
    await vi.waitFor(async () => expect((await state()).kanban.preview.nonce).not.toBe(beforeBuild.preview.nonce), { timeout: 3000 });
    const afterBuild = (await state()).kanban;
    expect(afterBuild.activeConfigurationId).toBe(beforeBuild.activeConfigurationId); expect(afterBuild.revision).toBe(beforeBuild.revision);
  });
  it('uses the project installed Core for local KV and knowledge without executing a workflow', async () => {
    const { app, bridge } = await fixture({ real: true });
    expect(app.project.kanban).toEqual({ artifactDir: '.', entry: 'index.html' });
    expect((await bridge('kv.setValue', { key: 'board', value: { tasks: [1, 2] } })).ok).toBe(true);
    expect((await bridge('kv.getValue', { key: 'board' })).value).toEqual({ tasks: [1, 2] });
    const document = (await bridge('knowledge.createDocument', { title: 'Notes', markdown: 'First\nSecond' })).value;
    expect(document.title).toBe('Notes'); expect((await bridge('knowledge.getDocument', { documentId: document.id })).value.markdown).toContain('First');
    expect((await bridge('knowledge.listDocuments')).ok).toBe(true);
    expect((await bridge('knowledge.searchDocuments', { query: 'First' })).ok).toBe(true);
    expect((await bridge('knowledge.readDocumentLines', { documentId: document.id, startLine: 1, endLine: 2 })).ok).toBe(true);
    expect((await bridge('knowledge.editDocument', { documentId: document.id, markdown: 'Updated' })).ok).toBe(true);
    expect((await bridge('knowledge.deleteDocument', { documentId: document.id })).ok).toBe(true);
  }, 20_000);
  it('reads a configured basemap larger than 2 MiB through the project bridge when attachments return 404', async () => {
    const { app, directory, post, action, bridge, runtime } = await fixture({ server: true, noParams: true });
    await writeFile(path.join(directory, 'configuration.json'), JSON.stringify({ version: 1, fields: [{ name: 'image', type: 'file' }] }));
    await post({ type: 'kanban-refresh' });
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 13, 137);
    const file = { id: 'wf_ab12', name: 'basemap.png', mimeType: 'image/png', size: bytes.length, storage: 'server', projectId: id };
    expect((await action('save', { values: { image: file } })).ok).toBe(true);
    const original = fetch, routes: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      if (!String(url).startsWith('https://basemap.test')) return original(url, options);
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer basemap-token' });
      const route = new URL(String(url)).pathname;
      if (route.endsWith('/api/auth/me')) return Promise.resolve(new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'user', email: 'user@example.com', displayName: 'User' } } })));

      if (route.endsWith(`/api/projects/${id}`)) return Promise.resolve(Response.json({ errCode: 0, data: { id } }));
      routes.push(route);
      if (route.includes('/configurations/files/')) return Promise.resolve(new Response(JSON.stringify({ errCode: 404, errMessage: 'API route not found.' }), { status: 404 }));
      throw new Error('Unexpected configuration file route');
    });
    await app.setHostConnection({ serverUrl: 'https://basemap.test', accessToken: 'basemap-token' });
    vi.mocked(runtime.kanbanBridge!).mockResolvedValue({file,base64:bytes.toString('base64')});
    const reply = await bridge('files.readFile', { fileId: file.id });
    expect(reply.ok).toBe(true);
    expect(reply.value.file).toEqual(file);
    expect(Buffer.from(reply.value.base64, 'base64').equals(bytes)).toBe(true);
    expect(routes).toEqual([`/api/projects/${id}/configurations/files/${file.id}`]);
    expect(runtime.kanbanBridge).toHaveBeenCalledOnce();
  });

  it.each([403, 500])('does not retry configuration attachment HTTP %s errors through another file route', async status => {
    const { app, directory, post, action, bridge, runtime } = await fixture({ server: true, noParams: true });
    await writeFile(path.join(directory, 'configuration.json'), JSON.stringify({ version: 1, fields: [{ name: 'image', type: 'file' }] }));
    await post({ type: 'kanban-refresh' });
    const file = { id: 'wf_ab12', name: 'basemap.png', mimeType: 'image/png', size: 3, storage: 'server', projectId: id };
    await action('save', { values: { image: file } });
    const original = fetch, requests = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      if (!String(url).startsWith('https://basemap.test')) return original(url, options);
      if (String(url).endsWith('/api/auth/me')) return Promise.resolve(new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'user', email: 'user@example.com', displayName: 'User' } } })));

      if (String(url).endsWith(`/api/projects/${id}`)) return Promise.resolve(Response.json({ errCode: 0, data: { id } }));
      requests(url);
      return Promise.resolve(new Response('private server detail', { status }));
    });
    await app.setHostConnection({ serverUrl: 'https://basemap.test', accessToken: 'basemap-token' });
    expect(await bridge('files.readFile', { fileId: file.id })).toMatchObject({ ok: false, error: { code: 'KANBAN_FILE_UNAVAILABLE', message: 'Kanban file is unavailable in this project.' } });
    expect(requests).toHaveBeenCalledOnce();
    expect(String(requests.mock.calls[0]![0])).toContain('/configurations/files/');
    expect(runtime.kanbanBridge).not.toHaveBeenCalled();
  });

  it.each(['close', 'authenticationChanged'] as const)('cancels a configured image read on %s and rejects late bytes', async operation => {
    const { app, directory, post, action } = await fixture({ server: true, noParams: true });
    await writeFile(path.join(directory, 'configuration.json'), JSON.stringify({ version: 1, fields: [{ name: 'image', type: 'file' }] }));
    await post({ type: 'kanban-refresh' });
    const file = { id: 'wf_ab12', name: 'basemap.png', mimeType: 'image/png', size: 3, storage: 'server', projectId: id };
    await action('save', { values: { image: file } });
    const original = fetch;
    let complete: ((response: Response) => void) | undefined, signal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      if (!String(url).startsWith('https://basemap.test')) return original(url, options);
      if (String(url).endsWith('/api/auth/me')) return Promise.resolve(new Response(JSON.stringify({ errCode: 0, data: { profile: { userId: 'user', email: 'user@example.com', displayName: 'User' } } })));

      if (String(url).endsWith(`/api/projects/${id}`)) return Promise.resolve(Response.json({ errCode: 0, data: { id } }));
      signal = options!.signal as AbortSignal;
      return new Promise<Response>(resolve => { complete = resolve; });
    });
    await app.setHostConnection({ serverUrl: 'https://basemap.test', accessToken: 'basemap-token' });
    const controller = app.kanbanController!;
    const reading = controller.bridge({ requestId: 'image', operation: 'files.readFile', input: { database:'data',fileId: file.id } });
    const rejected = expect(reading).rejects.toMatchObject({ code: 'KANBAN_BRIDGE_SESSION_INVALID' });
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    await controller[operation]();
    expect(signal!.aborted).toBe(true);
    complete!(new Response('png'));
    await rejected;
  });
});
