// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createConfigurationState,applyConfigurationAction,type ProjectConfigurationState} from '@steamharness/project-configuration';
import {mountProjectConfigurations,projectConfigurationsButton} from '../web/ui/project-configurations';
vi.mock('../web/localization',()=>({t:(text:string,...args:unknown[])=>text.replace(/\{(\d+)\}/g,(_,i)=>String(args[Number(i)]))}));
let state:ProjectConfigurationState,fail=false;
let listener: ((event:MessageEvent)=>void) | undefined;
const message=(data:unknown)=>window.dispatchEvent(new MessageEvent('message',{data,source:null}));
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
beforeEach(()=>{
 state=createConfigurationState([{name:'title',type:'string',defaultValue:'Original'},{name:'data',type:'json',defaultValue:null}],()=> 'profile');
 fail=false;
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.open=false;this.dispatchEvent(new Event('close'));}});
 for(const [method,newState] of [['showPopover','open'],['hidePopover','closed']] as const) Object.defineProperty(HTMLElement.prototype,method,{configurable:true,value:function(this:HTMLElement){
   const event=new Event('beforetoggle');Object.assign(event,{newState});this.dispatchEvent(event);this.hidden=newState==='closed';
 }});
 const original=window.addEventListener.bind(window);
 vi.spyOn(window,'addEventListener').mockImplementation(((type:any,callback:any,...args:any[])=>{if(type==='message')listener=callback;original(type,callback,...args);}) as typeof window.addEventListener);
 document.body.innerHTML=projectConfigurationsButton();
 mountProjectConfigurations({postMessage(message:any){queueMicrotask(()=>{
   try {if(fail)throw new Error('Configuration changed');
    state=message.call.action==='get'?state:applyConfigurationAction(state,message.call,()=>crypto.randomUUID());
    window.dispatchEvent(new MessageEvent('message',{data:{type:'project-configuration-result',requestId:message.requestId,value:state},source:null}));
   }catch(error){window.dispatchEvent(new MessageEvent('message',{data:{type:'error',requestId:message.requestId,message:(error as Error).message},source:null}));}
 });}});
});
afterEach(()=>{if(listener)window.removeEventListener('message',listener);listener=undefined;document.body.replaceChildren();vi.restoreAllMocks();});
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.ariaLabel===text||b.textContent===text)!;
const title=()=>document.querySelector<HTMLInputElement>('input[aria-label="title"]')!;
it('opens the common editor without declared fields and accepts external open commands',async()=>{
 state=createConfigurationState([],()=> 'empty');message({type:'project-configurations-open'});await settle();
 expect(document.querySelector('dialog')?.open).toBe(true);
 expect(button('Add field')).toBeTruthy();expect(document.body.textContent).toContain('No configuration fields.');
 button('Add field').click();
 expect(document.querySelector('.configuration-field-editor')?.getAttribute('aria-label')).toBe('Add field');
});
it('keeps dirty values across newer states and failed saves, then refreshes from the service',async()=>{
 document.getElementById('project-configurations')!.click();await settle();
 title().value='Draft';title().dispatchEvent(new Event('input'));
 state={...state,revision:1};message({type:'state',configurations:state});
 expect(title().value).toBe('Draft');expect(document.body.textContent).toContain('draft is preserved');
 fail=true;button('Save').click();await settle();expect(title().value).toBe('Draft');
 fail=false;button('Refresh and discard draft').click();await settle();expect(title().value).toBe('Original');
});
it('saves JSON null as a native value without converting it to an empty string',async()=>{
 document.getElementById('project-configurations')!.click();await settle();
 const data=document.querySelector<HTMLTextAreaElement>('textarea[aria-label="data"]')!;
 expect(data.value).toBe('null');data.value='{"enabled":false,"items":[null,0]}';data.dispatchEvent(new Event('input'));
 button('Save').click();await settle();expect(state.configurations[0]!.values.data).toEqual({enabled:false,items:[null,0]});
});
it('locks the form during a save and ignores delayed older configuration states',async()=>{
 document.getElementById('project-configurations')!.click();await settle();
 const stale=structuredClone(state);
 title().value='Saved';title().dispatchEvent(new Event('input'));
 button('Save').click();
 expect(title().disabled).toBe(true);
 expect(button('Add field').disabled).toBe(true);
 await settle();
 expect(title().disabled).toBe(false);expect(title().value).toBe('Saved');
 message({type:'state',configurations:stale});
 expect(title().value).toBe('Saved');
});
it('separates profile menus, field editing and the persistent save footer',async()=>{
 document.getElementById('project-configurations')!.click();await settle();
 expect(document.querySelector('.configuration-profiles select')).toBeTruthy();
 expect(document.querySelector('.configuration-fields-heading')!.contains(button('Add field'))).toBe(true);
 expect(document.querySelector('.configuration-footer')!.contains(button('Save'))).toBe(true);
 expect(button('Close').classList.contains('icon-button')).toBe(true);
 const transfer=button('Import / export');transfer.click();
 expect(transfer.ariaExpanded).toBe('true');
 expect(document.activeElement).toBe(button('Import'));
 const menu=button('Import').parentElement!;
 expect(menu.textContent).toContain('including sensitive fields');
 expect(document.querySelector('[role=status]')!.textContent).not.toContain('Exports');
 menu.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));expect(document.activeElement).toBe(button('Export current'));
 menu.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));expect(document.activeElement).toBe(button('Export all'));
 menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));expect(document.activeElement).toBe(transfer);expect(transfer.ariaExpanded).toBe('false');
 expect(document.querySelector<HTMLDialogElement>('dialog')!.open).toBe(true);
});
it('keeps the last profile and performs copy from the compact actions menu',async()=>{
 document.getElementById('project-configurations')!.click();await settle();
 button('Configuration actions').click();expect(button('Delete').disabled).toBe(true);
 button('Copy').click();await settle();
 expect(state.configurations).toHaveLength(2);expect(button('Delete').disabled).toBe(false);
 expect(button('Configuration actions').ariaExpanded).toBe('false');
});
it('uses accessible icons for custom fields and sensitive visibility, and edits in a titled dialog',async()=>{
 state=applyConfigurationAction(state,{action:'field.save',revision:0,field:{name:'token',type:'string',secret:true}},()=>crypto.randomUUID());
 document.getElementById('project-configurations')!.click();await settle();
 const secret=document.querySelector<HTMLInputElement>('input[aria-label="token"]')!;
 expect(secret.type).toBe('password');button('Show sensitive values').click();expect(secret.type).toBe('text');
 expect(button('Hide sensitive values').ariaPressed).toBe('true');button('Hide sensitive values').click();expect(secret.type).toBe('password');
 expect(button('Edit field').classList.contains('icon-button')).toBe(true);
 button('Edit field').click();
 const editor=document.querySelector<HTMLDialogElement>('.configuration-field-editor')!;
 expect(editor.open).toBe(true);expect(editor.querySelector('header h2')?.textContent).toBe('Edit field');
 const key=editor.querySelector<HTMLInputElement>('input')!;expect(key.value).toBe('token');key.value='renamed';
 editor.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
 expect(state.customFields[0]!.name).toBe('renamed');expect(document.querySelector('.configuration-field-editor')).toBeNull();
});
