import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWebServer } from '../web/server';
import type { Project, Runtime } from '../web/workflow-types';
import type { ProjectConfigurationState } from '@steamharness/project-configuration';

const apps: Awaited<ReturnType<typeof startWebServer>>[] = [], folders: string[] = [];
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
afterEach(async () => {
  await Promise.all(readers.splice(0).map(reader => reader.cancel()));
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) await rm(folder, {recursive:true,force:true});
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'web-configuration-sharing-'))); folders.push(root);
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'host'));
  vi.stubEnv('STEAMHARNESS_CLI_AUTH_DIR', path.join(root, 'auth'));
  vi.stubEnv('STEAMHARNESS_SERVER_URL', ''); vi.stubEnv('STEAMHARNESS_SERVER_ADMIN_KEY', '');
  const id = randomUUID();
  return async (name: string, kind: Project['projectType'], applicationId = id, assistant = false, projectDir?: string) => {
    const directory = projectDir ?? path.join(root, name);
    await mkdir(directory, {recursive:true});
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({id:applicationId,name:'shared-app',steamHarness:{projectType:kind}}));
    await writeFile(path.join(directory, 'configuration.json'), JSON.stringify({version:1,fields:[{name:'label',type:'string'},{name:'enabled',type:'boolean'}]}));
    if (kind === 'kanban') await writeFile(path.join(directory, 'index.html'), '<!doctype html><h1>Board</h1>');
    const project: Project = {id:applicationId,name:'App',uri:'',folderPath:directory,projectType:kind,fields:[],entrypoints:kind === 'workflow' ? [{id:'main',title:'Main',fields:[]}] : [],
      ...(kind === 'workflow' ? {defaultEntrypoint:'main'} : {}), ...(assistant ? {assistant:{workdir:path.join(root,name,'workspace'),roots:[]}} : {})};
    const runtime: Runtime = {available:true,inspect:vi.fn(async () => ({projects:[project],errors:[]})),resolveParams:vi.fn(async () => ({})),run:vi.fn(async () => ({status:'success'})),uploadFiles:vi.fn(async () => []),readFile:vi.fn(),deleteFiles:vi.fn(),cancelConversation:vi.fn(),deleteConversation:vi.fn(),readResource:vi.fn(),cancel:vi.fn(),dispose:vi.fn()};
    const app = await startWebServer({projectDir:directory,dataDir:path.join(root,name,'history'),runtime}); apps.push(app);
    const token = new URLSearchParams(new URL(app.url).hash.slice(1)).get('session')!;
    const post = (call: object) => fetch(`${app.origin}/api/message`, {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({type:'project-configuration',call})});
    // Keep the event stream open: observations below must arrive through polling
    // and SSE, without a ready/get request refreshing the receiving service.
    const response = await fetch(`${app.origin}/api/events?clientId=${randomUUID()}`, {headers:{Authorization:`Bearer ${token}`}});
    if (!response.ok) throw new Error(`Event stream failed: ${response.status} ${await response.text()}`);
    const reader = response.body!.getReader(); readers.push(reader);
    const decoder = new TextDecoder(); let buffer = '';
    const next = async (): Promise<{configurations:ProjectConfigurationState;parameterRevision:number}> => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffer.slice(0,end); buffer = buffer.slice(end+2);
          if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6));
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Configuration event stream closed.');
          buffer += decoder.decode(chunk.value,{stream:true});
        }
      }
    };
    const until = async (revision: number) => {
      for (;;) { const value = await next(); if (value.configurations.revision >= revision) return value; }
    };
    return {app,post,next,until,directory};
  };
}

for (const kind of ['conversation','workflow','kanban'] as const) it(`${kind} windows share application profiles, values and selection through the live page protocol`, async () => {
  const open = await fixture(), a = await open('first-install',kind), b = await open('second-install',kind);
  const initialA = await a.next(), initialB = await b.next();
  expect(initialB.configurations).toEqual(initialA.configurations);
  let state = initialA.configurations;
  const change = async (window: typeof a, call: object) => {
    const response = await window.post({...call,revision:state.revision}); expect(response.status).toBe(200);
    state = (await response.json()).messages[0].value;
    const observed = await (window === a ? b : a).until(state.revision);
    expect(observed.configurations).toEqual(state);
    expect(observed.parameterRevision).toBeGreaterThan(initialB.parameterRevision);
  };
  await change(a,{action:'field.save',field:{name:'custom',type:'number'}});
  const first = state.activeConfigurationId;
  await change(a,{action:'save',id:first,values:{label:'shared',enabled:false,custom:0}});
  const saved = structuredClone(state);
  await change(b,{action:'duplicate',id:first,name:'Shared copy'});
  await change(a,{action:'select',id:first});
  const stale = await b.post({action:'save',revision:saved.revision,id:first,values:{label:'stale'}});
  expect(stale.ok).toBe(false);
  expect(a.app.configurations.state).toEqual(state);
  await change(b,{action:'rename',id:first,name:'Renamed'});
  await change(a,{action:'delete',id:state.configurations.find(item => item.id !== first)!.id});
  const other = await open('different-app',kind,randomUUID());
  expect((await other.next()).configurations.configurations[0]!.values).toEqual({});
}, 15_000);

it('assistant windows keep workspace histories separate while synchronizing one application configuration', async () => {
  const open = await fixture(), a = await open('assistant-a','conversation',undefined,true);
  const b = await open('assistant-b','conversation',undefined,true,a.directory);
  const initial = (await a.next()).configurations; await b.next();
  expect(a.app.controller.activeId).not.toBe(b.app.controller.activeId);
  const response = await a.post({action:'save',revision:initial.revision,id:initial.activeConfigurationId,values:{label:'assistant',enabled:false}});
  expect(response.ok).toBe(true);
  const saved = (await response.json()).messages[0].value;
  expect((await b.until(saved.revision)).configurations).toEqual(saved);
  expect(a.app.controller.activeId).not.toBe(b.app.controller.activeId);
}, 10_000);
