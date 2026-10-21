// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createConfigurationState,bindConfigurationTemplate,createPublicationDraft,freezeConfigurationTemplate,applyConfigurationAction,type ProjectConfigurationState} from '@steamharness/project-configuration';
import {mountProjectConfigurations,projectConfigurationsButton} from '../web/ui/project-configurations';
vi.mock('../web/localization',()=>({t:(text:string,...args:unknown[])=>text.replace(/\{(\d+)\}/g,(_,i)=>String(args[Number(i)]))}));
let state:ProjectConfigurationState,fail=false;
let upload=vi.fn();
let listener: ((event:MessageEvent)=>void) | undefined;
const message=(data:unknown)=>window.dispatchEvent(new MessageEvent('message',{data,source:null}));
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
beforeEach(()=>{
 state=createConfigurationState([{name:'title',type:'string',defaultValue:'Original'},{name:'data',type:'json',defaultValue:null}],()=> 'profile');
 fail=false;
 upload=vi.fn();
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.open=false;this.dispatchEvent(new Event('close'));}});
 for(const [method,newState] of [['showPopover','open'],['hidePopover','closed']] as const) Object.defineProperty(HTMLElement.prototype,method,{configurable:true,value:function(this:HTMLElement){
   const event=new Event('beforetoggle');Object.assign(event,{newState});this.dispatchEvent(event);this.hidden=newState==='closed';
 }});
 const original=window.addEventListener.bind(window);
 vi.spyOn(window,'addEventListener').mockImplementation(((type:any,callback:any,...args:any[])=>{if(type==='message')listener=callback;original(type,callback,...args);}) as typeof window.addEventListener);
 document.body.innerHTML=projectConfigurationsButton();
 mountProjectConfigurations({postMessage(message:any){queueMicrotask(async()=>{
   try {if(fail)throw new Error('Configuration changed');
    if(message.type==='project-configuration-upload') {
      const value=await upload(message);
      window.dispatchEvent(new MessageEvent('message',{data:{type:'project-configuration-upload-result',requestId:message.requestId,value},source:null}));return;
    }
    state=message.call.action==='get'?state:applyConfigurationAction(state,message.call,()=>crypto.randomUUID());
    window.dispatchEvent(new MessageEvent('message',{data:{type:'project-configuration-result',requestId:message.requestId,value:state},source:null}));
   }catch(error){window.dispatchEvent(new MessageEvent('message',{data:{type:'error',requestId:message.requestId,message:(error as Error).message},source:null}));}
 });}});
});
const imageFile={id:'wf_ab12',name:'底图.png',mimeType:'image/png',size:3,storage:'server' as const,projectId:'project'};
const fileInput=()=>document.querySelector<HTMLInputElement>('input[type=file][aria-label="Choose file for image"]')!;
async function selectImage(file=new File(['png'],'底图.png',{type:'image/png'})) {
 Object.defineProperty(fileInput(),'files',{configurable:true,value:[file]});fileInput().dispatchEvent(new Event('change'));
 await vi.waitFor(()=>expect(upload).toHaveBeenCalled());await settle();
}
it('selects and uploads a file directly, locks pending changes and saves only the returned reference',async()=>{
 state=createConfigurationState([{name:'image',type:'file',accept:['image/png']}],()=> 'file-profile');
 let finish!:(value:unknown)=>void;upload.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 document.getElementById('project-configurations')!.click();await settle();
 expect(fileInput().accept).toBe('image/png');expect(document.querySelector('textarea')).toBeNull();
 await selectImage();
 expect(button('Save').disabled).toBe(true);expect(button('New configuration').disabled).toBe(true);
 expect(upload).toHaveBeenCalledWith(expect.objectContaining({id:'file-profile',revision:0,key:'image',file:{name:'底图.png',mimeType:'image/png',data:'cG5n'}}));
 finish(imageFile);await settle();
 expect(document.body.textContent).toContain('底图.png');expect(button('Save').disabled).toBe(false);
 button('Save').click();await settle();expect(state.configurations[0]!.values.image).toEqual(imageFile);
 button('Clear file selection').click();button('Save').click();await settle();expect(state.configurations[0]!.values).toEqual({});
});
it('keeps the existing file on upload failure and refuses an unacceptable file before upload',async()=>{
 state=createConfigurationState([{name:'image',type:'file',accept:['image/png'],defaultValue:imageFile}],()=> 'file-profile');
 upload.mockRejectedValue(new Error('Permission denied'));
 document.getElementById('project-configurations')!.click();await settle();
 await selectImage();expect(document.body.textContent).toContain('Permission denied');expect(document.body.textContent).toContain('底图.png');
 upload.mockClear();Object.defineProperty(fileInput(),'files',{configurable:true,value:[new File(['data'],'wrong.txt',{type:'text/plain'})]});fileInput().dispatchEvent(new Event('change'));await settle();
 expect(upload).not.toHaveBeenCalled();expect(document.body.textContent).toContain('not accepted');
});
it('creates a custom file field with accept types through the field editor',async()=>{
 document.getElementById('project-configurations')!.click();await settle();button('Add field').click();
 const editor=document.querySelector<HTMLDialogElement>('.configuration-field-editor')!;
 editor.querySelector<HTMLInputElement>('input')!.value='photo';
 const type=editor.querySelector('select')!;type.value='file';type.dispatchEvent(new Event('change'));
 const accept=[...editor.querySelectorAll('label')].find(label=>label.textContent?.startsWith('Accepted file types'))!.querySelector('textarea')!;
 expect(accept.parentElement!.hidden).toBe(false);accept.value='image/png\n.webp';
 editor.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
 expect(state.customFields[0]).toMatchObject({name:'photo',type:'file',accept:['image/png','.webp']});
 expect(document.querySelector('input[aria-label="Choose file for photo"]')).toBeTruthy();
});
it('leaves an unselected file unset while saving another field directly',async()=>{
 state=createConfigurationState([{name:'image',type:'file'},{name:'title',type:'string'}],()=> 'file-profile');
 document.getElementById('project-configurations')!.click();await settle();
 expect(document.querySelector('.configuration-field-heading input[type=checkbox]')).toBeNull();
 expect(title().disabled).toBe(false);title().value='Map';title().dispatchEvent(new Event('input'));
 button('Save').click();await settle();expect(state.configurations[0]!.values).toEqual({title:'Map'});
});
afterEach(()=>{if(listener)window.removeEventListener('message',listener);listener=undefined;document.body.replaceChildren();vi.restoreAllMocks();});
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.ariaLabel===text||b.textContent===text)!;
const title=()=>document.querySelector<HTMLInputElement>('input[aria-label="title"]')!;
it('edits inherited values directly and resets overrides without saving untouched defaults',async()=>{
 state=createConfigurationState([
  {name:'title',type:'string',defaultValue:'Original'}, {name:'blank',type:'string'},
  {name:'count',type:'number',defaultValue:2}, {name:'active',type:'boolean',defaultValue:true},
  {name:'data',type:'json',defaultValue:{original:true}},
  {name:'mode',type:'string',options:[{value:'auto'},{value:'manual'}],defaultValue:'auto'},
  {name:'tags',type:'string',multiple:true,options:[{value:'east'},{value:'west'}],defaultValue:['east']},
 ],()=> 'profile');state.configurations[0]!.values={};
 document.getElementById('project-configurations')!.click();await settle();
 const input=(key:string)=>document.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(`[aria-label="${key}"]`)!;
 for(const key of ['title','blank','count','active','data','mode','tags'])expect(input(key).disabled).toBe(false);
 expect(document.querySelectorAll('.configuration-field-heading input')).toHaveLength(0);
 const set=(key:string,value:string)=>{input(key).value=value;input(key).dispatchEvent(new Event('input'));};
 set('title','');set('blank','');set('count','0');set('data','null');set('mode','manual');
 (input('active') as HTMLInputElement).click();
 const tags=input('tags') as HTMLSelectElement;tags.options[0]!.selected=false;tags.options[1]!.selected=true;tags.dispatchEvent(new Event('change'));
 button('Save').click();await settle();
 expect(state.configurations[0]!.values).toEqual({title:'',blank:'',count:0,active:false,data:null,mode:'manual',tags:['west']});
 for(const key of ['title','count','active','data','mode','tags'])button(`Restore default for ${key}`).click();
 button('Clear value for blank').click();
 expect(input('title').value).toBe('Original');expect(input('count').value).toBe('2');
 expect((input('active') as HTMLInputElement).checked).toBe(true);expect(input('data').value).toBe('{\n  "original": true\n}');
 expect(input('mode').value).toBe('auto');expect(Array.from((input('tags') as HTMLSelectElement).selectedOptions).map(o=>o.value)).toEqual(['east']);
 set('title','Only this field');button('Save').click();await settle();
 expect(state.configurations[0]!.values).toEqual({title:'Only this field'});
 expect(input('count').disabled).toBe(false);expect(input('data').value).toContain('original');
});
it('restores a default file immediately when its override is cleared',async()=>{
 state=createConfigurationState([{name:'image',type:'file',defaultValue:imageFile}],()=> 'profile');
 state.configurations[0]!.values.image={...imageFile,id:'wf_cd34',name:'replacement.png'};
 document.getElementById('project-configurations')!.click();await settle();
 button('Clear file selection').click();expect(document.body.textContent).toContain('底图.png');expect(document.body.textContent).not.toContain('replacement.png');
 button('Save').click();await settle();expect(state.configurations[0]!.values).toEqual({});
 expect(document.body.textContent).toContain('底图.png');
});
it('keeps an optional enum unset until selected, including its first option',async()=>{
 state=createConfigurationState([{name:'title',type:'string'},{name:'mode',type:'string',options:[{value:'auto'},{value:'manual'}]}],()=> 'profile');
 document.getElementById('project-configurations')!.click();await settle();
 const mode=()=>document.querySelector<HTMLSelectElement>('select[aria-label="mode"]')!;
 expect(mode().selectedIndex).toBe(-1);title().value='Draft';title().dispatchEvent(new Event('input'));
 button('Save').click();await settle();expect(state.configurations[0]!.values).toEqual({title:'Draft'});
 mode().value='auto';mode().dispatchEvent(new Event('change'));button('Save').click();await settle();
 expect(state.configurations[0]!.values).toEqual({title:'Draft',mode:'auto'});
 button('Clear value for mode').click();expect(mode().selectedIndex).toBe(-1);
});
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

it('applies published lock rules to direct fields, nested JSON and file controls',async()=>{
 const author=createConfigurationState([{name:'fixed',type:'string',defaultValue:'Official',sharing:{includeValue:true,editable:false}},{name:'settings',type:'json',defaultValue:{locked:0,open:false},sharing:{includeValue:true},paths:{'/locked':{editable:false}}},{name:'image',type:'file',sharing:{editable:false}}],()=> 'author');
 state=bindConfigurationTemplate(createConfigurationState([],()=> 'personal'),freezeConfigurationTemplate(createPublicationDraft(author),{projectId:'project',projectVersion:'1.0.0',sourceHash:'a'.repeat(64)}));
 document.getElementById('project-configurations')!.click();await settle();
 expect(document.querySelector<HTMLInputElement>('[aria-label="fixed"]')!.disabled).toBe(true);
 expect(fileInput().disabled).toBe(true);
 const nested=Array.from(document.querySelectorAll('label')).find(label=>label.textContent==='/locked')!.querySelector('input')!;expect(nested.disabled).toBe(true);
 expect(Array.from(document.querySelectorAll('label')).find(label=>label.textContent==='/open')!.querySelector('input')!.disabled).toBe(false);
});
it('updates author permissions at the same configuration revision and provides per-path publication controls',async()=>{
 document.getElementById('project-configurations')!.click();await settle();
 state={...state,canManagePublication:true,publication:createPublicationDraft(state)};message({type:'state',configurations:state});await settle();
 button('Publication and permissions').click();
 const pointer=document.querySelector<HTMLInputElement>('[aria-label="data: JSON Pointer"]')!;pointer.value='/connection/host';button('Add path').click();
 expect(document.querySelector('select[aria-label="/connection/host: Allow user edits"]')).toBeTruthy();
 button('Recipient preview').click();expect(document.body.textContent).toContain('steamharness-configuration-template');
 state={...state,canManagePublication:false,publication:undefined};message({type:'state',configurations:state});await settle();
 expect(button('Publication and permissions').hidden).toBe(true);
 expect(document.querySelector('.configuration-recipient-preview')).toBeNull();
 expect(document.querySelector<HTMLElement>('.configuration-body')!.hidden).toBe(false);
});
