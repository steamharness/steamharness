// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AGENT_MODELS_CONFIGURATION_FIELD,AGENT_MODELS_CONFIGURATION_KEY,createConfigurationState,bindConfigurationTemplate,createPublicationDraft,freezeConfigurationTemplate,applyConfigurationAction,type ProjectConfigurationState} from '@steamharness/project-configuration';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {mountProjectConfigurations,projectConfigurationsButton,type ProjectConfigurationsPanel} from '../web/ui/project-configurations';
vi.mock('../web/localization',()=>({t:(text:string,...args:unknown[])=>text.replace(/\{(\d+)\}/g,(_,i)=>String(args[Number(i)]))}));
let state:ProjectConfigurationState,fail=false;
let upload=vi.fn();
let listener: ((event:MessageEvent)=>void) | undefined;
let panel: ProjectConfigurationsPanel;
let readConfiguration: () => Promise<ProjectConfigurationState>;
let beforeSelect: () => Promise<void>;
const message=(data:unknown)=>window.dispatchEvent(new MessageEvent('message',{data,source:null}));
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
beforeEach(()=>{
 state=createConfigurationState([{name:'title',type:'string',defaultValue:'Original'},{name:'data',type:'json',defaultValue:null}],()=> 'profile');
 fail=false;
 readConfiguration=async()=>state;
 beforeSelect=async()=>{};
 upload=vi.fn();
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.open=false;this.dispatchEvent(new Event('close'));}});
 for(const [method,newState] of [['showPopover','open'],['hidePopover','closed']] as const) Object.defineProperty(HTMLElement.prototype,method,{configurable:true,value:function(this:HTMLElement){
   const event=new Event('beforetoggle');Object.assign(event,{newState});this.dispatchEvent(event);this.hidden=newState==='closed';
 }});
 const original=window.addEventListener.bind(window);
 vi.spyOn(window,'addEventListener').mockImplementation(((type:any,callback:any,...args:any[])=>{if(type==='message')listener=callback;original(type,callback,...args);}) as typeof window.addEventListener);
 document.body.innerHTML=projectConfigurationsButton();
 const styles=document.createElement('style');styles.textContent=readFileSync(path.join(import.meta.dirname,'../web/ui/project-configurations.css'),'utf8');document.body.append(styles);
 panel=mountProjectConfigurations({postMessage(message:any){queueMicrotask(async()=>{
   try {if(fail)throw new Error('Configuration changed');
    if(message.type==='project-configuration-upload') {
      const value=await upload(message);
      window.dispatchEvent(new MessageEvent('message',{data:{type:'project-configuration-upload-result',requestId:message.requestId,value},source:null}));return;
    }
    if(message.call.action==='select')await beforeSelect();
    const value=message.call.action==='get'?await readConfiguration():(state=applyConfigurationAction(state,message.call,()=>crypto.randomUUID()));
    window.dispatchEvent(new MessageEvent('message',{data:{type:'project-configuration-result',requestId:message.requestId,value},source:null}));
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
 await openPanel();
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
 await openPanel();
 await selectImage();expect(document.body.textContent).toContain('Permission denied');expect(document.body.textContent).toContain('底图.png');
 upload.mockClear();Object.defineProperty(fileInput(),'files',{configurable:true,value:[new File(['data'],'wrong.txt',{type:'text/plain'})]});fileInput().dispatchEvent(new Event('change'));await settle();
 expect(upload).not.toHaveBeenCalled();expect(document.body.textContent).toContain('not accepted');
});
it('creates a custom file field with accept types through the field editor',async()=>{
 await openPanel();button('Add field').click();
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
 await openPanel();
 expect(document.querySelector('.configuration-field-heading input[type=checkbox]')).toBeNull();
 expect(title().disabled).toBe(false);title().value='Map';title().dispatchEvent(new Event('input'));
 button('Save').click();await settle();expect(state.configurations[0]!.values).toEqual({title:'Map'});
});
afterEach(()=>{if(listener)window.removeEventListener('message',listener);listener=undefined;document.body.replaceChildren();vi.restoreAllMocks();});
async function openPanel() {
 document.getElementById('project-configurations')!.click();await settle();
 const entry=document.querySelector<HTMLButtonElement>('.configuration-profile-link')!;entry.click();await settle();
}
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.ariaLabel===text||b.textContent===text)!;
const title=()=>document.querySelector<HTMLInputElement>('input[aria-label="title"]')!;
it('saves Agent models through the profile service and blocks unapplied model drafts',async()=>{
 state=createConfigurationState([AGENT_MODELS_CONFIGURATION_FIELD,{name:'title',type:'string'}],()=> 'profile');
 await openPanel();button('Add model').click();button('Third-party AI').click();
 const fill=(label:string,value:string)=>{const row=[...document.querySelectorAll('label')].find(row=>row.firstChild?.textContent===label)!;const input=row.querySelector('input')!;input.value=value;input.dispatchEvent(new Event('input'));};
 fill('Model name','My model');fill('Base URL','https://models.example/v1');fill('Model ID','actual-model');fill('API key','test-only-key');
 button('Save').click();await settle();expect(state.revision).toBe(0);expect(document.body.textContent).toContain('Add or cancel the model being edited first.');
 button('Apply model').click();button('Save').click();await settle();
 expect(state.configurations[0]!.values[AGENT_MODELS_CONFIGURATION_KEY]).toMatchObject([{name:'My model',model:'actual-model',source:'third-party',apiKey:'test-only-key'}]);
 expect(state.activeConfigurationId).toBe('profile');expect(document.querySelector('input[type=password]')).toBeNull();
});
it('opens the active profile AI models directly without changing the selected configuration',async()=>{
 state=createConfigurationState([AGENT_MODELS_CONFIGURATION_FIELD,{name:'title',type:'string'}],()=> 'profile');
 state=applyConfigurationAction(state,{action:'create',name:'Other',revision:state.revision},()=> 'other');
 state=applyConfigurationAction(state,{action:'select',id:'profile',revision:state.revision},()=>crypto.randomUUID());
 message({type:'state',configurations:state});expect(panel.needsAgentModels()).toBe(true);
 await openPanel();button('Close').click();
 panel.openAgentModels();await settle();
 expect(document.querySelector<HTMLDialogElement>('.project-configurations')!.open).toBe(true);
 expect(document.querySelector<HTMLElement>('.configuration-body')!.hidden).toBe(false);
 expect(document.querySelector('.configuration-profile-name')!.textContent).toContain('Default');
 expect(document.activeElement).toBe(button('Add model'));
 expect(state.activeConfigurationId).toBe('profile');
 expect(document.querySelector<HTMLDialogElement>('.configuration-ai-editor')!.open).toBe(false);
 button('Close').click();document.getElementById('project-configurations')!.click();await settle();
 expect(document.querySelector<HTMLElement>('.configuration-list')!.hidden).toBe(false);
});
it('preserves a non-current profile draft when the model setup shortcut is used',async()=>{
 state=createConfigurationState([AGENT_MODELS_CONFIGURATION_FIELD,{name:'title',type:'string'}],()=> 'profile');
 state=applyConfigurationAction(state,{action:'create',name:'Other',revision:state.revision},()=> 'other');
 state=applyConfigurationAction(state,{action:'select',id:'profile',revision:state.revision},()=>crypto.randomUUID());
 document.getElementById('project-configurations')!.click();await settle();
 document.querySelectorAll<HTMLButtonElement>('.configuration-profile-link')[1]!.click();
 title().value='Keep this draft';title().dispatchEvent(new Event('input'));button('Close').click();
 panel.openAgentModels();await settle();
 expect(title().value).toBe('Keep this draft');
 expect(document.querySelector('.configuration-profile-name')!.textContent).toContain('Other');
 expect(document.querySelector('.configuration-footer > .configuration-status')!.textContent).toContain('Save or discard');
 expect(state.activeConfigurationId).toBe('profile');
});
it('opens cached model settings immediately and keeps later navigation when the refresh is slow',async()=>{
 state=createConfigurationState([AGENT_MODELS_CONFIGURATION_FIELD],()=> 'profile');
 message({type:'state',configurations:state});
 let finish!:(state:ProjectConfigurationState)=>void;
 readConfiguration=()=>new Promise(resolve=>{finish=resolve;});
 panel.openAgentModels();await settle();
 expect(document.querySelector<HTMLElement>('.configuration-body')!.hidden).toBe(false);
 expect(document.activeElement).toBe(button('Add model'));
 button('Back to list').click();button('Close').click();
 finish(state);await settle();
 expect(document.querySelector<HTMLDialogElement>('.project-configurations')!.open).toBe(false);
 expect(document.querySelector<HTMLElement>('.configuration-list')!.hidden).toBe(false);
 expect(document.activeElement).toBe(document.getElementById('project-configurations'));
});
it('does not navigate or steal focus after closing before the first configuration response',async()=>{
 state=createConfigurationState([AGENT_MODELS_CONFIGURATION_FIELD],()=> 'profile');
 let finish!:(state:ProjectConfigurationState)=>void;
 readConfiguration=()=>new Promise(resolve=>{finish=resolve;});
 panel.openAgentModels();await settle();button('Close').click();finish(state);await settle();
 expect(document.querySelector<HTMLDialogElement>('.project-configurations')!.open).toBe(false);
 expect(document.querySelector<HTMLElement>('.configuration-body')!.hidden).toBe(true);
 expect(document.activeElement).toBe(document.getElementById('project-configurations'));
});
it('derives missing models from the current effective configuration without validating unrelated conflicts',async()=>{
 message({type:'state',configurations:state});expect(panel.needsAgentModels()).toBe(false);
 const model={id:'saved',name:'Saved',model:'example',source:'system',credentialId:'credential'};
 state=createConfigurationState([{...AGENT_MODELS_CONFIGURATION_FIELD,defaultValue:[model]},{name:'limit',type:'number'}],()=> 'profile');
 state.revision=1;
 state.configurations[0]!.values.limit='Old string';
 state.conflicts=[{configurationId:'profile',key:'limit',value:'Old string',reason:'Field type changed'}];
 message({type:'state',configurations:state});expect(panel.needsAgentModels()).toBe(false);
 state={...state,revision:2,configurations:state.configurations.map(profile=>({...profile,values:{...profile.values,[AGENT_MODELS_CONFIGURATION_KEY]:[]}}))};
 message({type:'state',configurations:state});expect(panel.needsAgentModels()).toBe(true);
 panel.openAgentModels();await settle();
 expect(document.querySelector<HTMLElement>('.configuration-body')!.hidden).toBe(false);
 expect(document.querySelector('.configuration-footer > .configuration-status')!.textContent).toContain('Some field types changed');
});
it('edits inherited values directly and resets overrides without saving untouched defaults',async()=>{
 state=createConfigurationState([
  {name:'title',type:'string',defaultValue:'Original'}, {name:'blank',type:'string'},
  {name:'count',type:'number',defaultValue:2}, {name:'active',type:'boolean',defaultValue:true},
  {name:'data',type:'json',defaultValue:{original:true}},
  {name:'mode',type:'string',options:[{value:'auto'},{value:'manual'}],defaultValue:'auto'},
  {name:'tags',type:'string',multiple:true,options:[{value:'east'},{value:'west'}],defaultValue:['east']},
 ],()=> 'profile');state.configurations[0]!.values={};
 await openPanel();
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
 await openPanel();
 button('Clear file selection').click();expect(document.body.textContent).toContain('底图.png');expect(document.body.textContent).not.toContain('replacement.png');
 button('Save').click();await settle();expect(state.configurations[0]!.values).toEqual({});
 expect(document.body.textContent).toContain('底图.png');
});
it('keeps an optional enum unset until selected, including its first option',async()=>{
 state=createConfigurationState([{name:'title',type:'string'},{name:'mode',type:'string',options:[{value:'auto'},{value:'manual'}]}],()=> 'profile');
 await openPanel();
 const mode=()=>document.querySelector<HTMLSelectElement>('select[aria-label="mode"]')!;
 expect(mode().selectedIndex).toBe(-1);title().value='Draft';title().dispatchEvent(new Event('input'));
 button('Save').click();await settle();expect(state.configurations[0]!.values).toEqual({title:'Draft'});
 mode().value='auto';mode().dispatchEvent(new Event('change'));button('Save').click();await settle();
 expect(state.configurations[0]!.values).toEqual({title:'Draft',mode:'auto'});
 button('Clear value for mode').click();expect(mode().selectedIndex).toBe(-1);
});
it('opens the common editor without declared fields and accepts external open commands',async()=>{
 state=createConfigurationState([],()=> 'empty');message({type:'project-configurations-open'});await settle();
 document.querySelector<HTMLButtonElement>('.configuration-profile-link')!.click();await settle();
 expect(document.querySelector('dialog')?.open).toBe(true);
 expect(button('Add field')).toBeTruthy();expect(document.body.textContent).toContain('No configuration fields.');
 button('Add field').click();
 expect(document.querySelector('.configuration-field-editor')?.getAttribute('aria-label')).toBe('Add field');
});
it('keeps dirty values across newer states and failed saves, then refreshes from the service',async()=>{
 await openPanel();
 title().value='Draft';title().dispatchEvent(new Event('input'));
 state={...state,revision:1};message({type:'state',configurations:state});
 expect(title().value).toBe('Draft');expect(document.body.textContent).toContain('draft is preserved');
 fail=true;button('Save').click();await settle();expect(title().value).toBe('Draft');
 fail=false;button('Refresh and discard draft').click();await settle();expect(title().value).toBe('Original');
});
it('saves JSON null as a native value without converting it to an empty string',async()=>{
 await openPanel();
 const data=document.querySelector<HTMLTextAreaElement>('textarea[aria-label="data"]')!;
 expect(data.value).toBe('null');data.value='{"enabled":false,"items":[null,0]}';data.dispatchEvent(new Event('input'));
 button('Save').click();await settle();expect(state.configurations[0]!.values.data).toEqual({enabled:false,items:[null,0]});
});
it('locks the form during a save and ignores delayed older configuration states',async()=>{
 await openPanel();
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
 await openPanel();
 expect(button('Back to list')).toBeTruthy();expect(document.querySelector('.configuration-profiles select')).toBeNull();
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
 await openPanel();
 button('Configuration actions').click();expect(button('Delete').disabled).toBe(true);
 button('Copy').click();await settle();
 expect(state.configurations).toHaveLength(2);expect(button('Delete').disabled).toBe(false);
 expect(button('Configuration actions').ariaExpanded).toBe('false');
});
it('uses accessible icons for custom fields and sensitive visibility, and edits in a titled dialog',async()=>{
 state=applyConfigurationAction(state,{action:'field.save',revision:0,field:{name:'token',type:'string',secret:true}},()=>crypto.randomUUID());
 await openPanel();
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
 await openPanel();
 expect(document.querySelector<HTMLInputElement>('[aria-label="fixed"]')!.disabled).toBe(true);
 expect(fileInput().disabled).toBe(true);
 const nested=Array.from(document.querySelectorAll('label')).find(label=>label.textContent==='/locked')!.querySelector('input')!;expect(nested.disabled).toBe(true);
 expect(Array.from(document.querySelectorAll('label')).find(label=>label.textContent==='/open')!.querySelector('input')!.disabled).toBe(false);
});
it('updates author permissions at the same configuration revision and provides per-path publication controls',async()=>{
 await openPanel();
 expect(document.querySelector<HTMLElement>('.configuration-view-tabs')!.hidden).toBe(true);
 state={...state,canManagePublication:true,publication:createPublicationDraft(state)};message({type:'state',configurations:state});await settle();
 expect(document.querySelector<HTMLElement>('.configuration-view-tabs')!.hidden).toBe(false);
 button('Configuration values').focus();
 document.querySelector('.configuration-view-tabs')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
 expect(button('Publication and permissions')).toBe(document.activeElement);
 const properties=document.querySelector<HTMLDetailsElement>('.configuration-publication-paths')!;properties.open=true;
 const pointer=document.querySelector<HTMLInputElement>('[aria-label="data: JSON Pointer"]')!;pointer.value='/connection/host';button('Add path').click();
 expect(document.querySelector('select[aria-label="/connection/host: Allow user edits"]')).toBeTruthy();
 button('Recipient preview').click();expect(document.body.textContent).toContain('steamharness-configuration-template');
 state={...state,canManagePublication:false,publication:undefined};message({type:'state',configurations:state});await settle();
 expect(button('Publication and permissions').hidden).toBe(true);
 expect(document.querySelector<HTMLElement>('.configuration-view-tabs')!.hidden).toBe(true);
 expect(document.querySelector('.configuration-recipient-preview')).toBeNull();
 expect(document.querySelector<HTMLElement>('.configuration-body')!.hidden).toBe(false);
});

it('starts with the list and edits another profile without selecting it for runs',async()=>{
 state=applyConfigurationAction(state,{action:'create',name:'Secondary',revision:0},()=> 'secondary');
 state.activeConfigurationId='profile';state.configurations[1]!.values.title='Second value';
 document.getElementById('project-configurations')!.click();await settle();
 expect(document.querySelector<HTMLElement>('.configuration-list')!.hidden).toBe(false);
 expect(document.querySelector('[aria-label="title"]')).toBeNull();
 expect(button('Save').hidden).toBe(true);expect(getComputedStyle(button('Save')).display).toBe('none');
 button('Secondary').click();await settle();expect(title().value).toBe('Second value');expect(state.activeConfigurationId).toBe('profile');
 title().value='Edited second';title().dispatchEvent(new Event('input'));button('Save').click();await settle();
 expect(state.configurations[1]!.values.title).toBe('Edited second');expect(state.configurations[0]!.values.title).toBe('Original');expect(state.activeConfigurationId).toBe('profile');
 button('Back to list').click();expect(document.querySelector('[aria-label="title"]')).toBeNull();
 button('Use this configuration: Secondary').click();await settle();expect(state.activeConfigurationId).toBe('secondary');
 expect(document.querySelector<HTMLElement>('.configuration-list')!.hidden).toBe(false);
});
it('distinguishes the active profile from explicit use actions in the list and details',async()=>{
 state=applyConfigurationAction(state,{action:'create',name:'Secondary',revision:0},()=> 'secondary');state.activeConfigurationId='profile';
 document.getElementById('project-configurations')!.click();await settle();
 const active=button('Default');expect(active.getAttribute('aria-current')).toBe('true');
 expect(active.closest('li')!.dataset.active).toBe('true');expect(active.closest('li')!.textContent).toContain('In use');
 expect(button('Secondary').hasAttribute('aria-current')).toBe(false);
 expect(button('Use this configuration: Secondary').textContent).toBe('Use this configuration');
 expect([...document.querySelectorAll('button')].some(control=>control.ariaLabel==='Use this configuration: Default'&&!control.hidden)).toBe(false);
 button('Secondary').click();expect(state.activeConfigurationId).toBe('profile');
 const details=document.querySelector<HTMLElement>('.configuration-profiles:not(.configuration-list-toolbar)')!;
 expect(details.querySelector('.configuration-active')).toBeNull();expect(details.querySelector<HTMLButtonElement>('.configuration-use')!.hidden).toBe(false);
 button('Back to list').click();button('Default').click();
 expect(details.querySelector('.configuration-active')!.textContent).toBe('In use');expect(details.querySelector<HTMLButtonElement>('.configuration-use')!.hidden).toBe(true);
});
it('keeps the committed selection during a pending or failed switch and updates it only on success',async()=>{
 state=applyConfigurationAction(state,{action:'create',name:'Secondary',revision:0},()=> 'secondary');state.activeConfigurationId='profile';
 let finish!:()=>void,reject!:(error:Error)=>void;
 beforeSelect=vi.fn(()=>new Promise<void>((resolve,fail)=>{finish=resolve;reject=fail;}));
 document.getElementById('project-configurations')!.click();await settle();
 const use=button('Use this configuration: Secondary');use.click();await settle();
 expect(use.disabled).toBe(true);expect(use.getAttribute('aria-busy')).toBe('true');expect(use.textContent).toBe('Switching...');
 expect(button('Default').getAttribute('aria-current')).toBe('true');use.click();expect(beforeSelect).toHaveBeenCalledTimes(1);
 reject(new Error('Configuration changed'));await settle();
 expect(use.disabled).toBe(false);expect(use.getAttribute('aria-busy')).toBe('false');expect(use.textContent).toBe('Use this configuration');
 expect(button('Default').getAttribute('aria-current')).toBe('true');expect(document.body.textContent).toContain('Configuration changed');
 use.click();await settle();finish();await settle();
 expect(button('Secondary').getAttribute('aria-current')).toBe('true');expect(button('Default').hasAttribute('aria-current')).toBe(false);
 expect(button('Secondary').closest('li')!.textContent).toContain('In use');expect(button('Use this configuration: Default').disabled).toBe(false);
 state=applyConfigurationAction(state,{action:'select',id:'profile',revision:state.revision},()=> 'unused');message({type:'state',configurations:state});
 expect(button('Default').getAttribute('aria-current')).toBe('true');expect(button('Secondary').hasAttribute('aria-current')).toBe(false);
});
it('updates detail usage after an external switch without overwriting unsaved values',async()=>{
 state=applyConfigurationAction(state,{action:'create',name:'Secondary',revision:0},()=> 'secondary');state.activeConfigurationId='profile';
 await openPanel();title().value='Keep draft';title().dispatchEvent(new Event('input'));
 const header=document.querySelector('.configuration-profile-name')!;expect(header.textContent).toContain('In use');
 state=applyConfigurationAction(state,{action:'select',id:'secondary',revision:state.revision},()=> 'unused');message({type:'state',configurations:state});
 expect(title().value).toBe('Keep draft');expect(header.textContent).not.toContain('In use');
 const use=document.querySelector<HTMLButtonElement>('.configuration-profiles:not(.configuration-list-toolbar) .configuration-use')!;
 expect(use.hidden).toBe(false);use.click();await settle();expect(state.activeConfigurationId).toBe('secondary');expect(title().value).toBe('Keep draft');
 expect(document.body.textContent).toContain('Save or discard');
});
it('protects both value and publication drafts when returning to the list',async()=>{
 state=createConfigurationState([AGENT_MODELS_CONFIGURATION_FIELD,...state.fields],()=> 'profile');
 state={...state,canManagePublication:true,publication:createPublicationDraft(state)};
 await openPanel();title().value='Draft';title().dispatchEvent(new Event('input'));
 button('Back to list').click();expect(title().value).toBe('Draft');expect(document.body.textContent).toContain('Save or discard');
 button('Refresh and discard draft').click();await settle();button('Back to list').click();expect(document.querySelector('[aria-label="title"]')).toBeNull();
 button('Default').click();button('Publication and permissions').click();
 const include=document.querySelector<HTMLInputElement>('[aria-label="title: Include value"]')!;include.click();
 button('Back to list').click();expect(include.checked).toBe(true);expect(document.querySelector<HTMLElement>('.configuration-publication')!.hidden).toBe(false);
 button('Close').click();panel.openAgentModels();await settle();
 expect(include.checked).toBe(true);expect(document.querySelector<HTMLElement>('.configuration-publication')!.hidden).toBe(false);
 expect(document.querySelector('.configuration-publication + .configuration-footer + .configuration-footer .configuration-status')!.textContent).toContain('Save or discard');
 button('Refresh and discard publication draft').click();button('Back to list').click();
 expect(document.querySelector<HTMLElement>('.configuration-list')!.hidden).toBe(false);
});
it('returns to the list when the viewed profile is deleted externally and keeps a dirty draft',async()=>{
 state=applyConfigurationAction(state,{action:'create',name:'Secondary',revision:0},()=> 'secondary');
 document.getElementById('project-configurations')!.click();await settle();button('Secondary').click();
 state=applyConfigurationAction(state,{action:'delete',id:'secondary',revision:state.revision},()=> 'unused');message({type:'state',configurations:state});
 expect(document.querySelector<HTMLElement>('.configuration-list')!.hidden).toBe(false);expect(button('Delete: Default').disabled).toBe(true);
 button('Default').click();title().value='Keep this';title().dispatchEvent(new Event('input'));
 const newer={...state,revision:state.revision+1};message({type:'state',configurations:newer});
 expect(title().value).toBe('Keep this');expect(document.body.textContent).toContain('draft is preserved');
});
it('creates, renames and deletes configurations from the list',async()=>{
 document.getElementById('project-configurations')!.click();await settle();button('New configuration').click();
 const prompt=()=>document.querySelector<HTMLDialogElement>('.action-dialog')!;
 prompt().querySelector<HTMLInputElement>('input')!.value='Created';prompt().querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
 expect(document.querySelector('.configuration-profile-name')!.textContent).toContain('Created');
 button('Back to list').click();button('Rename: Created').click();prompt().querySelector<HTMLInputElement>('input')!.value='Renamed';prompt().querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
 expect(button('Renamed')).toBeTruthy();button('Delete: Renamed').click();prompt().querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await settle();
 expect(state.configurations).toHaveLength(1);expect(button('Delete: Default').disabled).toBe(true);
});
