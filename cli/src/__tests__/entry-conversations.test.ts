import { expect, it, vi } from 'vitest';
import { ConversationController } from '../web/conversation-controller';
import { EntryConversations, conversationProjection } from '../web/entry-conversations';
import { hostConversation } from '../web/host-conversation';
import { randomUUID } from 'node:crypto';
import { folderBotDataRoot, webProjectDataDirectory } from '../web/project-data-directory';
import type { Project, Report, Runtime, ConversationSession } from '../web/workflow-types';

function fixture(saved: { sessions?: ConversationSession[] } = {}) {
  const project = { id:'aggregate',entryId:'bot',name:'Bot',aggregateName:'Aggregate',entries:[],defaultEntry:'bot',entryRoot:'/test',folderPath:'/test',uri:'/test',projectType:'bot',fields:[],entrypoints:[],conversation:{inputQueue:{enabled:true},recovery:{enabled:true,startup:'manual'}} } as Project;
  const running = new Map<string, (report: Report) => void>();
  const runtime = { run: vi.fn(async request => new Promise<Report>(resolve => running.set(request.runId!, resolve))),
    cancel: vi.fn(id => running.get(id!)?.({status:'aborted'})), cancelConversation: vi.fn(async () => {}) } as unknown as Runtime;
  const save = vi.fn(async () => {});
  const controller = new ConversationController(project, runtime, saved, { save, changed() {}, log() {} });
  const api = new EntryConversations(controller, session => conversationProjection('bot',session,'owner',1));
  return { controller, api, runtime, running, save, project };
}
it('handles an image-only host turn without selecting it, replaying its upload, or exposing trace data', async () => {
  const f=fixture(), selected=f.controller.activeId, conversationId=randomUUID(), requestId=randomUUID();
  f.project.conversation!.attachments={images:true};
  f.runtime.uploadFiles=vi.fn(async()=>[{ id:'file',name:'image.png',mimeType:'image/png',kind:'image' as const,storage:'local' as const,size:8,createdAt:'today',path:'/private/image' }]);
  const input={conversationId,requestId,title:'background 1',action:'submit',text:'',images:[{key:'image-1',path:'/private/image',mimeType:'image/png'}]};
  const call=(data:Record<string,unknown>)=>hostConversation(f.controller,f.api,f.runtime,f.project,data);
  await call(input); await call(input); await vi.waitFor(()=>expect(f.running.has(requestId)).toBe(true));
  expect(f.runtime.uploadFiles).toHaveBeenCalledTimes(1);expect(f.controller.activeId).toBe(selected);
  expect(f.controller.sessions.find(s=>s.id===conversationId)).toMatchObject({ title: 'background 1', origin: 'host' });
  await expect(call({...input,requestId:randomUUID()})).rejects.toThrow('busy');
  f.running.get(requestId)!({status:'success',result:{data:{internal:'secret fallback'}},output:{items:[{id:'answer',contentType:'text',content:'complete answer',metadata:{private:'never send'}}]}});
  await f.controller.idle(); const turn=await call({...input,action:'turn'});
  expect(turn).toMatchObject({status:'success',items:[{content:'complete answer'}]});expect(JSON.stringify(turn)).not.toMatch(/private|secret fallback/);
  const history=structuredClone(f.controller.sessions);f.controller.dispose();const r=fixture({sessions:history});r.project.conversation!.attachments={images:true};
  await hostConversation(r.controller,r.api,r.runtime,r.project,input);expect(r.runtime.run).not.toHaveBeenCalled();
  await hostConversation(r.controller,r.api,r.runtime,r.project,{...input,action:'ensure',conversationId:randomUUID(),title:'background 2'});
  expect(r.controller.sessions.map(s=>s.title)).toEqual(expect.arrayContaining(['background 1','background 2']));r.controller.dispose();
});

it('marks the matching legacy host conversation without classifying ordinary conversations by their title', async () => {
  const conversationId = randomUUID(), requestId = randomUUID(), localId = randomUUID();
  const title = 'IM · 私聊 · 1';
  const oldInput = { id: requestId, sessionRequestId: requestId, role: 'user' as const, content: 'hello' };
  const f = fixture({ sessions: [
    { id: localId, title, messages: [oldInput] },
    { id: conversationId, title: 'Renamed', messages: [{ ...oldInput, input: { text: 'hello', attachments: [], params: {}, entrySubmission: { params: {} } } }] },
  ] });
  const call = (id: string) => hostConversation(f.controller, f.api, f.runtime, f.project, { conversationId: id, requestId, action: 'submit', text: 'hello' });
  await expect(call(localId)).rejects.toThrow('not owned');
  await call(conversationId);
  expect(f.controller.sessions).toMatchObject([{ id: localId }, { id: conversationId, title: 'Renamed', origin: 'host' }]);
  expect(f.controller.sessions[0].origin).toBeUndefined();
  expect(f.save).toHaveBeenCalled();
  expect(f.runtime.run).not.toHaveBeenCalled();
  f.controller.dispose();
});

it('admits durable requests without waiting for the model, preserves native selection/draft and deduplicates across restart', async () => {
  const f = fixture(), selected = f.controller.activeId;
  f.controller.current.draft = {text:'native draft',attachments:[]};
  const input = {conversationId:'private',requestId:'first',text:'hello',params:{}};
  await Promise.all([f.api.invoke('submit',input),f.api.invoke('submit',{...input})]);
  await vi.waitFor(() => expect(f.runtime.run).toHaveBeenCalledTimes(1));
  expect(f.controller.activeId).toBe(selected);
  expect(f.controller.current.draft?.text).toBe('native draft');
  await f.api.invoke('submit',{...input,requestId:'second',text:'next'});
  expect((await f.api.invoke('snapshot',{conversationId:'private'}) as any).queue).toMatchObject([{id:'second',position:1}]);
  await expect(f.api.invoke('submit',{...input,text:'changed'})).rejects.toThrow(/requestId/);
  f.running.get('first')!({status:'success',output:{items:[]}});
  await vi.waitFor(() => expect(f.running.has('second')).toBe(true));
  f.running.get('second')!({status:'success',output:{items:[]}}); await f.controller.idle();
  const saved = JSON.parse(JSON.stringify(f.controller.sessions)); f.controller.dispose();
  const restored = fixture({sessions:saved});
  await restored.api.invoke('submit',input);
  expect(restored.runtime.run).not.toHaveBeenCalled();
  await expect(restored.api.invoke('submit',{...input,params:{changed:'yes'}})).rejects.toThrow(/requestId/);
  const snapshot = await restored.api.invoke('snapshot',{conversationId:'private'});
  expect(JSON.stringify(snapshot)).not.toMatch(/userSettings|toolPermissionPolicies|configurationSelection/);
  restored.controller.dispose();
});
it('parks interrupted turns and FIFO queues until explicit recovery, and retains the remainder after stop', async () => {
  const saved = [{id:'private',title:'old',createdAt:1,messages:[{id:'first',runId:'first',role:'assistant',content:'partial',status:'running',args:['--message','old']}],queuedInputs:[{id:'second',requestId:'second',text:'next',params:{},attachments:[],createdAt:2}]}] as ConversationSession[];
  const f = fixture({sessions:saved}); f.controller.recover();
  expect(f.runtime.run).not.toHaveBeenCalled();
  expect(conversationProjection('bot',f.controller.current,'owner',1)).toMatchObject({running:false,queuePaused:true,messages:[{status:'paused'}]});
  await f.api.invoke('submit',{conversationId:'private',requestId:'third',text:'last'});
  expect(f.runtime.run).not.toHaveBeenCalled();
  await f.api.invoke('resumeQueue',{conversationId:'private',requestId:'resume'});
  await vi.waitFor(() => expect(f.running.has('first')).toBe(true));
  await f.api.invoke('cancel',{conversationId:'private',requestId:'stop'});
  expect(f.controller.current.queuedInputs?.map(input => input.id)).toEqual(['second','third']);
  await f.api.invoke('resumeQueue',{conversationId:'private',requestId:'resume-next'});
  await vi.waitFor(() => expect(f.running.has('second')).toBe(true));
  f.running.get('second')!({status:'success',output:{items:[]}});
  await vi.waitFor(() => expect(f.running.has('third')).toBe(true));
  f.running.get('third')!({status:'success',output:{items:[]}});await f.controller.idle();
  f.controller.dispose();
});
it('rejects a cancelled caller before creating a conversation', async () => {
  const f=fixture(),abort=new AbortController();abort.abort(new Error('caller stopped'));
  await expect(f.api.invoke('submit',{conversationId:'new',requestId:'r',text:'hello'},abort.signal)).rejects.toThrow('caller stopped');
  expect(f.controller.sessions.some(session=>session.id==='new')).toBe(false);f.controller.dispose();
});

it('withdraws just the named queued background request without stopping another active turn', async () => {
  const f = fixture(), conversationId = randomUUID(), first = randomUUID(), queued = randomUUID();
  await f.api.invoke('submit', { conversationId, requestId: first, text: 'running' });
  await f.api.invoke('submit', { conversationId, requestId: queued, text: 'queued' });
  const call = (action: string) => hostConversation(f.controller, f.api, f.runtime, f.project, { conversationId, requestId: queued, action });
  expect(await call('turn')).toMatchObject({ status: 'queued' });
  expect(await call('stop')).toMatchObject({ status: 'stopped' });
  expect(await call('turn')).toMatchObject({ status: 'missing' });
  expect(f.runtime.cancel).not.toHaveBeenCalled();
  f.running.get(first)!({ status: 'success' }); await f.controller.idle(); f.controller.dispose();
});

it('persists folder Bot history as host-owned and only recovers the requested IM turn', async () => {
  const conversationId = randomUUID(), requestId = randomUUID(), other = randomUUID(), otherRequest = randomUUID();
  const session = (id: string, runId: string): ConversationSession => ({ id, title: 'IM', origin: 'host',
    messages: [{ id: runId, runId, role: 'assistant', content: 'partial', status: 'running', args: ['--message', 'hello'] }] });
  const f = fixture({ sessions: [session(conversationId, requestId), session(other, otherRequest)] });
  f.project.conversation!.recovery!.startup = 'automatic';
  for (const session of f.controller.sessions) session.recoveryPaused = false;
  const call = (action: string, overrides = {}) => hostConversation(f.controller, f.api, f.runtime, f.project, { conversationId, requestId, action, ...overrides }, true);
  f.controller.recover();
  expect(f.runtime.run).not.toHaveBeenCalled();
  expect(await call('turn')).toMatchObject({ recovering: true });
  await expect(call('recover', { requestId: otherRequest })).rejects.toThrow('Another background request');
  await call('recover');
  await vi.waitFor(() => expect([...f.running.keys()]).toEqual([requestId]));
  f.running.get(requestId)!({ status: 'success' }); await f.controller.idle();
  const created = randomUUID();
  await call('ensure', { conversationId: created });
  const saved = structuredClone(f.controller.sessions);
  expect(saved.find(session => session.id === created)).toMatchObject({ origin: 'host' });
  f.controller.dispose();
  const reopened = fixture({ sessions: saved });
  await reopened.controller.create();
  expect(reopened.controller.current.origin).toBeUndefined();
  await expect(hostConversation(reopened.controller, reopened.api, reopened.runtime, reopened.project,
    { conversationId: reopened.controller.current.id, requestId, action: 'submit', text: 'hello' }, true)).rejects.toThrow('not owned');
  reopened.controller.dispose();
});

it('uses separate data roots for two instances of the same entry', () => {
  const project = randomUUID(), first = randomUUID(), second = randomUUID();
  const root = process.cwd();
  const local = webProjectDataDirectory(root, project, 'agent');
  const locations = [first, second].map(id => webProjectDataDirectory(folderBotDataRoot(root, id), project, 'agent'));
  expect(new Set([local, ...locations]).size).toBe(3);
  expect(() => folderBotDataRoot(root, '../other')).toThrow('identity');
});
