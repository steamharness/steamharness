import {afterEach,expect,it,vi} from 'vitest';
import {ConversationController} from '../web/conversation-controller';
import type {Project,Report,Run,Runtime} from '../web/workflow-types';

const controllers:ConversationController[]=[];
afterEach(()=>{for(const controller of controllers.splice(0))controller.dispose();});
const ask={id:'profile-ask',profileKey:'ask',subject:'server:alice'};
const build={id:'profile-build',profileKey:'build',subject:'server:alice'};
function fixture(){
  const project:Project={id:'restricted',uri:'',folderPath:'/fixture',name:'Restricted',projectType:'conversation',fields:[],entrypoints:[],conversation:{inputQueue:{enabled:true},recovery:{enabled:true}}};
  const runtime={available:true,run:vi.fn(async(_request:Run)=>({status:'success'})),cancel:vi.fn()} as unknown as Runtime;
  const options={save:vi.fn(async()=>{}),changed:vi.fn(),log:vi.fn()};
  const controller=new ConversationController(project,runtime,{},options);controllers.push(controller);
  return {controller,runtime,options,project};
}
it('keeps the configuration chosen for a queued input and preserves its draft and history when execution is rejected',async()=>{
  const {controller,runtime}=fixture();
  let finish!:(report:Report)=>void;
  vi.mocked(runtime.run).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await controller.send({text:'First',params:{},attachments:[],configurationSelection:ask});
  await controller.send({text:'Build later',params:{},attachments:[],configurationSelection:build});
  controller.current.draft={text:'Keep this draft',attachments:[]};
  vi.mocked(runtime.run).mockRejectedValueOnce(new Error('This configuration is not available to this account.'));
  finish({status:'success'});
  await controller.idle();
  expect(vi.mocked(runtime.run).mock.calls.map(([request])=>request.configurationSelection)).toEqual([ask,build]);
  expect(controller.current.messages.at(-1)).toMatchObject({status:'failed',configurationSelection:build});
  expect(controller.current.messages[0].content).toBe('First');
  expect(controller.current.draft.text).toBe('Keep this draft');
});
it('restores the original configuration selection and requires its verified run snapshot',async()=>{
  const {controller,runtime,options,project}=fixture();
  await controller.send({text:'Original Build',params:{},attachments:[],configurationSelection:build});await controller.idle();
  const sessions=structuredClone(controller.sessions);
  Object.assign(sessions[0].messages.at(-1)!,{status:'running',recovering:true});
  controller.dispose();vi.mocked(runtime.run).mockClear();
  const restored=new ConversationController(project,runtime,{sessions},options);controllers.push(restored);
  restored.recover();await restored.idle();
  expect(runtime.run).toHaveBeenCalledWith(expect.objectContaining({configurationSelection:build,resumeConfiguration:true}),expect.any(Function));
});
