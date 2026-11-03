import { expect, it, vi } from 'vitest';
import { ConversationController } from '../web/conversation-controller';
import { EntryConversations, conversationProjection } from '../web/entry-conversations';
import type { Project, Report, Runtime, ConversationSession } from '../web/workflow-types';

function fixture(saved: { sessions?: ConversationSession[] } = {}) {
  const project = { id:'aggregate',entryId:'bot',name:'Bot',aggregateName:'Aggregate',entries:[],defaultEntry:'bot',entryRoot:'/test',folderPath:'/test',uri:'/test',projectType:'conversation',databases:[],fields:[],entrypoints:[],conversation:{inputQueue:{enabled:true},recovery:{enabled:true,startup:'manual'}} } as Project;
  const running = new Map<string, (report: Report) => void>();
  const runtime = { run: vi.fn(async request => new Promise<Report>(resolve => running.set(request.runId!, resolve))),
    cancel: vi.fn(id => running.get(id!)?.({status:'aborted'})), cancelConversation: vi.fn(async () => {}) } as unknown as Runtime;
  const save = vi.fn(async () => {});
  const controller = new ConversationController(project, runtime, saved, { save, changed() {}, log() {} });
  const api = new EntryConversations(controller, session => conversationProjection('bot',session,'owner',1));
  return { controller, api, runtime, running, save };
}
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
