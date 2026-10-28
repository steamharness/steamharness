import { t } from '../localization';
import { iconButton, iconHtml, updateIcon } from './ui';
import { requestAction } from './action-dialog';
import { AGENT_MODELS_CONFIGURATION_KEY,applyTemplateValues,configurationCapability,configurationSnapshot,configurationPointerPart,createPublicationDraft,freezeConfigurationTemplate,type ConfigurationPublicationDraft, parseConfigurationField, parseConfigurationFile, validateConfigurationFileSelection, type ProjectConfigurationFile, type ProjectConfigurationAction, type ProjectConfigurationField, type ProjectConfigurationState, type ConfigurationValues } from '@steamharness/project-configuration';
import './project-configurations.css';
import { createAgentModelsControl } from './agent-models';

type Host = { postMessage(message: Record<string, unknown>): void };
export interface ProjectConfigurationsPanel {
  needsAgentModels(): boolean;
  openAgentModels(): void;
}
export function projectConfigurationsButton(): string {
  return `<button id="project-configurations" class="icon-button" aria-haspopup="dialog" title="${t('Project configurations')}" aria-label="${t('Project configurations')}">${iconHtml('settings-gear')}</button>`;
}
/** Shared by all three local project pages. Drafts keep their original revision until saved/discarded. */
export function mountProjectConfigurations(host: Host): ProjectConfigurationsPanel {
  const trigger = document.getElementById('project-configurations')!;
  const dialog = document.createElement('dialog'); dialog.id = 'project-configurations-dialog'; dialog.className = 'conversation-dialog project-configurations';
  let suspendedDetailId:string|undefined;
  let detailId:string|undefined, selectingId:string|undefined, publicationView=false, publicationDirty=false, missingAgentModels=false;
  let opening = 0;
  let opener: HTMLElement | undefined;
  const fieldRows = new Map<string, HTMLElement>();
  const modeStatus=document.createElement('span');modeStatus.className='configuration-current-profile';modeStatus.hidden=true;
  document.querySelector('.composer-toolbar .run-options')?.append(modeStatus);
  const listActionButtons:HTMLButtonElement[]=[];
  const heading = document.createElement('header'), title = document.createElement('h2'); title.textContent = t('Project configurations');
  title.id = 'project-configurations-title'; dialog.setAttribute('aria-labelledby', title.id);
  const close = iconButton('close', t('Close'), () => dialog.close()); heading.append(title, close);
  const body = document.createElement('div'); body.className = 'dialog-body configuration-body';
  const status = document.createElement('p'); status.role = 'status'; status.className = 'configuration-status'; status.textContent = t('Loading...');
  const toolbar = document.createElement('section'); toolbar.className = 'configuration-profiles';
  const profileLabel = document.createElement('h3');profileLabel.className='configuration-profile-name';
  const profileControls = document.createElement('div'); profileControls.className = 'configuration-profile-controls';
  const back=iconButton('arrow-left',t('Back to list'),()=>{if(!working&&clean()){++opening;detailId=undefined;showView(false);draft=undefined;if(latest)render(latest);}});
  const useCurrent=useButton(()=>{if(detailId&&clean())void dispatch({action:'select',id:detailId});});
  const listToolbar=document.createElement('section');listToolbar.className='configuration-profiles configuration-list-toolbar';
  const listTitle=document.createElement('h3');listTitle.textContent=t('Project configurations');listToolbar.append(listTitle);
  const listBody=document.createElement('div');listBody.className='dialog-body configuration-list';
  const list=document.createElement('ul');list.ariaLabel=t('Project configurations');listBody.append(list);
  const fieldsHeader = document.createElement('div'); fieldsHeader.className = 'configuration-fields-heading';
  const fieldsTitle = document.createElement('h3'); fieldsTitle.textContent = t('Configuration fields');
  const fieldCount = document.createElement('span'); fieldCount.className = 'configuration-count';
  const fields = document.createElement('div'); fields.className = 'configuration-fields';
  const actions = document.createElement('footer'); actions.className = 'configuration-footer';
  const footerButtons = document.createElement('div'); footerButtons.className = 'configuration-footer-actions';
  const save = button(t('Save'), () => void commit());
  save.className = 'configuration-primary'; save.prepend(document.createRange().createContextualFragment(iconHtml('check')));
  const refresh = iconButton('refresh', t('Refresh and discard draft'), () => void reload());
  footerButtons.append(refresh, save); actions.append(status, footerButtons);
  fieldsHeader.append(fieldsTitle, fieldCount);
  const tabs=document.createElement('nav');tabs.className='configuration-view-tabs';tabs.ariaLabel=t('Project configurations');
  const valuesTab=button(t('Configuration values'),()=>{if(clean())showView(false);});
  const publicationTab=button(t('Publication and permissions'),()=>{if(clean()){showView(true);renderPublication();}});
  const publicationBody=document.createElement('div');publicationBody.className='dialog-body configuration-publication';publicationBody.hidden=true;
  const publicationFooter=document.createElement('footer');publicationFooter.className='configuration-footer';publicationFooter.hidden=true;
  const publicationStatus=document.createElement('p');publicationStatus.className='configuration-status';publicationStatus.role='status';
  const publicationPreview=document.createElement('pre');publicationPreview.className='configuration-recipient-preview';publicationPreview.hidden=true;
  const publicationButtons=document.createElement('div');publicationButtons.className='configuration-footer-actions';
  const previewPublication=iconButton('eye',t('Recipient preview'),()=>{
    if(!publicationDraft)return;
    try{publicationPreview.textContent=JSON.stringify(freezeConfigurationTemplate(publicationDraft,{projectId:'preview',entryId:'preview',projectVersion:'preview',sourceHash:'0'.repeat(64)}),null,2);publicationPreview.hidden=false;publicationStatus.textContent='';publicationStatus.classList.remove('error');}
    catch(e){error(e);}
  });
  const savePublication=button(t('Save publication draft'),()=>void(async()=>{
    if(!publicationDraft)return;
    try{freezeConfigurationTemplate(publicationDraft,{projectId:'preview',entryId:'preview',projectVersion:'preview',sourceHash:'0'.repeat(64)});if(await dispatch({action:'publication.save',publication:publicationDraft})){publicationDraft=undefined;publicationDirty=false;renderPublication();publicationStatus.textContent='';publicationStatus.classList.remove('error');}}
    catch(e){error(e);}
  })());
  savePublication.className='configuration-primary';savePublication.prepend(document.createRange().createContextualFragment(iconHtml('check')));
  const discardPublication=iconButton('discard',t('Refresh and discard publication draft'),()=>{publicationDraft=undefined;publicationDirty=false;renderPublication();publicationStatus.textContent='';publicationStatus.classList.remove('error');});
  publicationButtons.append(discardPublication,previewPublication,savePublication);publicationFooter.append(publicationStatus,publicationButtons);
  tabs.role='tablist';
  for(const [tab,panel,id]of [[valuesTab,body,'values'],[publicationTab,publicationBody,'publication']]as const){tab.role='tab';tab.id=`configuration-${id}-tab`;panel.id=`configuration-${id}-panel`;panel.role='tabpanel';panel.setAttribute('aria-labelledby',tab.id);tab.setAttribute('aria-controls',panel.id);}
  function showView(publication:boolean){publicationView=publication;body.hidden=!detailId||publication;toolbar.hidden=!detailId;profileControls.hidden=publication;tabs.hidden=!detailId||publicationTab.hidden;listToolbar.hidden=!!detailId;listBody.hidden=!!detailId;actions.hidden=!!detailId&&publication;save.hidden=!detailId;publicationBody.hidden=!detailId||!publication;publicationFooter.hidden=!detailId||!publication;valuesTab.ariaSelected=String(!publication);publicationTab.ariaSelected=String(publication);valuesTab.tabIndex=publication?-1:0;publicationTab.tabIndex=publication?0:-1;}
  showView(false);
  tabs.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||publicationTab.hidden)return;event.preventDefault();const next=event.key==='Home'?valuesTab:event.key==='End'?publicationTab:document.activeElement===valuesTab?publicationTab:valuesTab;next.click();next.focus();};
  tabs.append(valuesTab,publicationTab);
  body.append(fieldsHeader,fields); dialog.append(heading,listToolbar,listBody,toolbar,tabs,body,publicationBody,actions,publicationFooter); document.body.append(dialog);
  let latest: ProjectConfigurationState | undefined, draft: ProjectConfigurationState | undefined, dirty = false, working = false, editingField = false;
  const readers = new Map<string, () => unknown>(), overrides = new Set<string>(), resets = new Map<string, HTMLButtonElement>();
  const modelControls: ReturnType<typeof createAgentModelsControl>[] = [];
  let authenticationRevision: number | undefined;
  const pending = new Map<string,{resolve(value:any):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
  const error = (e: unknown) => { for(const output of [status,publicationStatus]){output.textContent = t((e as Error).message ?? String(e)); output.classList.add('error');} };
  function button(text: string, run: () => void): HTMLButtonElement { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = run; return b; }
  function useButton(run: () => void): HTMLButtonElement {
    const control=button('',run);control.className='configuration-use';
    const label=document.createElement('span');label.className='configuration-use-label';label.textContent=t('Use this configuration');
    control.append(document.createRange().createContextualFragment(iconHtml('arrow-swap')),label);return control;
  }
  function activeBadge(): HTMLElement {
    const badge=document.createElement('span');badge.className='configuration-active configuration-in-use';
    badge.append(document.createRange().createContextualFragment(iconHtml('pass-filled')),document.createTextNode(t('In use')));return badge;
  }
  const menus: { trigger: HTMLButtonElement; panel: HTMLDivElement; items: HTMLButtonElement[] }[] = [];
  function hideMenus() { for (const menu of menus) if (menu.trigger.ariaExpanded === 'true') menu.panel.hidePopover(); }
  function menu(icon: string, label: string, entries: {icon: string; label: string; run(): void; danger?: boolean}[], notice?: string) {
    const panel = document.createElement('div'); panel.className = 'session-menu configuration-menu'; panel.popover = 'auto'; panel.role = 'menu'; panel.ariaLabel = label; panel.id = `configuration-menu-${menus.length}`;
    const trigger = iconButton(icon, label, () => {
      if (trigger.ariaExpanded === 'true') { panel.hidePopover(); return; }
      hideMenus(); panel.showPopover();
      const anchor = trigger.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, innerHeight - bounds.height - 8))}px`;
      items.find(item => !item.disabled)?.focus();
    });
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-controls', panel.id); trigger.ariaExpanded = 'false';
    const items = entries.map(entry => {
      const item = button(entry.label, () => { panel.hidePopover(); trigger.focus(); entry.run(); });
      item.className = 'session-action'; item.role = 'menuitem'; item.tabIndex = -1;
      if (entry.danger) item.dataset.action = 'delete';
      item.prepend(document.createRange().createContextualFragment(iconHtml(entry.icon))); panel.append(item); return item;
    });
    if (notice) { const help = document.createElement('p'); help.className = 'configuration-menu-notice'; help.id = `${panel.id}-notice`; help.textContent = notice; panel.setAttribute('aria-describedby', help.id); panel.append(help); }
    // beforetoggle keeps the trigger state in sync before the next key/click event.
    panel.addEventListener('beforetoggle', event => { trigger.ariaExpanded = String((event as ToggleEvent).newState === 'open'); });
    panel.addEventListener('keydown', event => {
      const available = items.filter(item => !item.disabled), index = available.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault(); available[event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length]?.focus();
      } else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); panel.hidePopover(); trigger.focus(); }
    });
    trigger.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (trigger.ariaExpanded !== 'true') trigger.click(); (event.key === 'ArrowUp' ? [...items].reverse() : items).find(item => !item.disabled)?.focus(); } });
    const result = {trigger,panel,items}; menus.push(result); dialog.append(panel); return result;
  }
  function request(call: ProjectConfigurationAction): Promise<any> {
    return send({type:'project-configuration',call});
  }
  function send(message: Record<string,unknown>, timeout = 30_000): Promise<any> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve,reject) => { const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(t('The request timed out. Check the current status.'))); },timeout); pending.set(requestId,{resolve,reject,timer}); host.postMessage({...message,requestId}); });
  }
  function changed(key?: string) { if (key) overrides.add(key); dirty = true; updateActions(); status.textContent = t('Unsaved changes'); status.classList.remove('error'); }
  function lockControls(root: ParentNode): () => void {
    const controls = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button')].map(control => [control, control.disabled] as const);
    for (const [control] of controls) control.disabled = true;
    return () => { for (const [control, disabled] of controls) if (control.isConnected) control.disabled = disabled; };
  }
  async function reload() {
    if (working) return;
    hideMenus(); working = true; const unlock = lockControls(dialog);
    try { const next = await request({action:'get'}); dirty = false; draft = undefined; suspendedDetailId=undefined; render(latest && latest.revision > next.revision ? latest : next); }
    catch (e) { error(e); }
    finally { working = false; unlock(); updateActions(); }
  }
  async function dispatch(call: ProjectConfigurationAction) {
    if (!draft || working) return false;
    hideMenus(); working = true; selectingId=call.action==='select'?call.id:undefined;
    const unlock = lockControls(dialog);updateActions();
    try { const result = await request({...call,revision:draft.revision});
      if(call.action==='create'||call.action==='duplicate'){detailId=result.activeConfigurationId;showView(false);}
      draft = undefined; dirty = false; render(latest && latest.revision > result.revision ? latest : result); return true; }
    catch (e) { error(e); return false; }
    finally { working = false; selectingId=undefined; unlock(); updateActions(); }
  }
  async function commit() {
    if (!draft || !detailId || !dirty || working) return;
    try {
      const values: ConfigurationValues = {}, unset: string[] = [];
      for (const field of draft.fields) {
        if (!overrides.has(field.name)) { unset.push(field.name); continue; }
        values[field.name] = readers.get(field.name)!() as any;
      }
      await dispatch({action:'save',id:detailId,values,unset});
    } catch (e) { error(e); }
  }
  function clean(): boolean { if (dirty||publicationDirty) { error(new Error(t('Save or discard your draft before changing configurations.'))); return false; } return true; }
  function openDetails(id:string) {if(working||!clean()||!latest)return;++opening;detailId=id;showView(false);draft=undefined;render(latest);back.focus();}
  async function profileOperation(action: ProjectConfigurationAction['action'],id=detailId) {
    if (!draft || working || !clean()) return;
    editingField = true;
    try {
    const name = action === 'create' || action === 'rename' ? await requestAction({title:t(action === 'create' ? 'New configuration' : 'Rename configuration'),label:t('Configuration name'),value:action === 'rename' ? draft.configurations.find(c => c.id === id)?.name : '',confirm:t('Save')})
      : action === 'delete' ? await requestAction({title:t('Delete this configuration?'),confirm:t('Delete'),danger:true}) : '';
    if (name !== undefined) await dispatch({action,id,...(name ? {name} : {})});
    } finally { editingField = false; if (latest && !dirty) { draft = undefined; render(latest); } }
  }
  const create = iconButton('add', t('New configuration'), () => void profileOperation('create'));
  const profilesMenu = menu('ellipsis', t('Configuration actions'), [
    {icon:'copy',label:t('Copy'),run:() => void profileOperation('duplicate')},
    {icon:'edit',label:t('Rename'),run:() => void profileOperation('rename')},
    {icon:'trash',label:t('Delete'),run:() => void profileOperation('delete'),danger:true},
  ]);
  const transferMenu = menu('arrow-swap', t('Import / export'), [
    {icon:'import',label:t('Import'),run:importFile},
    {icon:'export',label:t('Export current'),run:() => void download(false)},
    {icon:'export',label:t('Export all'),run:() => void download(true)},
  ], t('Exports include all values, including sensitive fields.'));
  transferMenu.trigger.classList.add('configuration-transfer');
  const publicationMenu=menu('ellipsis',t('Configuration actions'),[
    {icon:'refresh',label:t('Refresh published values from current profiles'),run:()=>{if(publicationDraft&&draft){publicationDraft.configurationRevision=draft.revision;for(const profile of publicationDraft.configurations)if(draft.configurations.some(c=>c.id===profile.id))profile.values=configurationSnapshot(draft,profile.id,false).values;publicationEdited();}}},
    {icon:'refresh',label:t('Refresh fields from the project'),run:()=>{if(publicationDraft&&draft){publicationDraft.fields=draft.fields.map(field=>({...field,sharing:publicationDraft!.fields.find(old=>old.name===field.name)?.sharing??field.sharing,paths:publicationDraft!.fields.find(old=>old.name===field.name)?.paths??field.paths}));publicationEdited();renderPublication();}}},
  ]);
  const addField = button(t('Add field'), () => { if (draft && clean()) void editField(); });
  addField.className = 'configuration-add-field'; addField.prepend(document.createRange().createContextualFragment(iconHtml('add')));
  fieldsHeader.append(addField); profileControls.append(useCurrent,profilesMenu.trigger); toolbar.append(back,profileLabel,profileControls);listToolbar.append(create,transferMenu.trigger);
  function renderList(next:ProjectConfigurationState) {
    list.replaceChildren();listActionButtons.length=0;
    for(const profile of next.configurations) {
      const active=profile.id===next.activeConfigurationId;
      const row=document.createElement('li'),open=button('',()=>openDetails(profile.id));row.dataset.active=String(active);open.className='configuration-profile-link';open.ariaLabel=profile.name;
      const label=document.createElement('span');label.className='configuration-profile-text';label.textContent=profile.name;open.append(label);
      const capability=next.configurationCapabilities?.[profile.id];
      if(capability){
        const summary=document.createElement('span');summary.className='configuration-profile-summary';
        if(capability.description){const description=document.createElement('small');description.textContent=capability.description;summary.append(description);}
        for(const text of [...capability.tags,t({guest:'Available to guests',developer:'Developer and above',maintainer:'Maintainer and above',owner:'Owner only'}[capability.minimumRole])]){const badge=document.createElement('span');badge.className='configuration-profile-badge';badge.textContent=text;summary.append(badge);}
        label.append(summary);
      }
      if(active){open.setAttribute('aria-current','true');open.setAttribute('aria-description',t('In use'));}
      open.append(document.createRange().createContextualFragment(iconHtml('chevron-right')));
      const usage=document.createElement('div');usage.className='configuration-profile-usage';
      if(active)usage.append(activeBadge());
      else {
        const use=useButton(()=>{if(clean())void dispatch({action:'select',id:profile.id});});use.dataset.configurationId=profile.id;
        use.ariaLabel=t('Use this configuration')+': '+profile.name;usage.append(use);listActionButtons.push(use);
      }
      const controls=document.createElement('div');controls.className='configuration-profile-controls';
      if(next.capabilities?.manageConfigurations!==false){controls.append(iconButton('copy',t('Copy')+': '+profile.name,()=>void profileOperation('duplicate',profile.id)));if(capability?.rename!==false)controls.append(iconButton('edit',t('Rename')+': '+profile.name,()=>void profileOperation('rename',profile.id)));}
      const remove=iconButton('trash',t('Delete')+': '+profile.name,()=>void profileOperation('delete',profile.id));remove.dataset.last=String(next.configurations.length<=1||!!next.profilePolicy&&next.configurations.filter(item=>item.profileKey===profile.profileKey).length===1);if(next.capabilities?.manageConfigurations!==false&&capability?.delete!==false)controls.append(remove);
      listActionButtons.push(open,...controls.querySelectorAll<HTMLButtonElement>('button'));row.append(open,usage,controls);list.append(row);
    }
  }
  function updateActions() {
    for (const control of [back,useCurrent,create,addField,...listActionButtons,...menus.flatMap(menu => [menu.trigger,...menu.items])]) control.disabled = working || !draft;
    for(const control of listActionButtons)if(control.dataset.last==='true')control.disabled=true;
    transferMenu.items[1]!.hidden=!detailId;
    const manage=(latest??draft)?.capabilities?.manageConfigurations!==false;
    create.hidden=!manage; addField.hidden=!manage; profilesMenu.trigger.hidden=!manage; transferMenu.items[0]!.hidden=!manage;
    useCurrent.hidden=!detailId||detailId===(latest??draft)?.activeConfigurationId;
    for(const control of dialog.querySelectorAll<HTMLButtonElement>('.configuration-use')) {
      const selecting=working&&!!selectingId&&control.dataset.configurationId===selectingId;
      control.setAttribute('aria-busy',String(selecting));
      control.querySelector('.configuration-use-label')!.textContent=t(selecting?'Switching...':'Use this configuration');
    }
    profilesMenu.items[1]!.hidden = (latest??draft)?.configurationCapabilities?.[detailId??'']?.rename===false;
    profilesMenu.items[2]!.hidden = (latest??draft)?.configurationCapabilities?.[detailId??'']?.delete===false;
    profilesMenu.items[2]!.disabled = working || !draft || draft.configurations.length <= 1;
    refresh.disabled = working; save.disabled = working || !dirty || !draft;
    for (const [key, reset] of resets) reset.disabled = working || !overrides.has(key) || !!draft && !configurationCapability(draft,draft.fields.find(f=>f.name===key)!).editable;
  }
  updateActions();
  async function download(all: boolean) {
    if (!draft || !clean()) return;
    try { const document = await request({action:'export',id:all ? undefined : detailId});
      const url = URL.createObjectURL(new Blob([JSON.stringify(document,null,2)],{type:'application/json'}));
      const a = window.document.createElement('a'); a.href = url; a.download = 'project-configurations.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    } catch (e) { error(e); }
  }
  function importFile() {
    if (!clean()) return;
    const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.json,application/json';
    picker.onchange = () => void (async () => { try {
      const file = picker.files?.[0]; if (!file) return;
      if (file.size > 1024*1024) throw new Error(t('Configuration exceeds 1 MiB.'));
      const document = JSON.parse(await file.text());
      if (clean()) await dispatch({action:'import',document});
    } catch (e) { error(e); } })(); picker.click();
  }
  async function editField(field?: ProjectConfigurationField) {
    editingField = true;
    const editor = document.createElement('dialog'); editor.className = 'conversation-dialog project-configurations configuration-field-editor';
    editor.setAttribute('aria-label', t(field ? 'Edit field' : 'Add field'));
    const editorHeader = document.createElement('header'), editorTitle = document.createElement('h2'); editorTitle.textContent = t(field ? 'Edit field' : 'Add field');
    editorHeader.append(editorTitle,iconButton('close',t('Close'),()=>editor.close()));
    const form = document.createElement('form'); form.className = 'configuration-editor-form';
    const editorBody = document.createElement('div'); editorBody.className = 'dialog-body configuration-fields';
    const inputs = new Map<string,HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>();
    const label = (text:string,control:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement,key:string) => { const l = document.createElement('label'); l.textContent = t(text); l.append(control); editorBody.append(l); inputs.set(key,control); };
    const key = document.createElement('input'); key.value = field?.name ?? ''; key.required = true; key.readOnly = false; label('Field key',key,'name');
    const type = document.createElement('select'); for (const value of ['string','number','boolean','json','file']) type.add(new Option(value,value)); type.value = field?.type ?? 'string'; label('Field type',type,'type');
    for (const [key,text] of [['label','Label'],['description','Description'],['defaultValue','Default value (JSON)'],['options','Options (one per line)'],['accept','Accepted file types (one per line)']]) {
      const input = document.createElement('textarea'); input.rows = 2;
      input.value = key === 'defaultValue' ? (field?.defaultValue === undefined ? '' : JSON.stringify(field.defaultValue)) : key === 'options' ? field?.options?.map(o=>o.value).join('\n') ?? '' : key === 'accept' ? field?.accept?.join('\n') ?? '' : String(field?.[key as 'label'] ?? ''); label(text,input,key);
    }
    for (const [key,text] of [['required','Required'],['secret','Sensitive'],['multiple','Multiple values']]) { const input=document.createElement('input'); input.type='checkbox'; input.checked=!!field?.[key as 'secret']; label(text,input,key); }
    const updateType=()=>{ for(const key of ['options','accept']) inputs.get(key)!.parentElement!.hidden = key === 'accept' ? type.value !== 'file' : type.value !== 'string'; };
    type.onchange=updateType; updateType();
    const message = document.createElement('p'); message.role = 'alert'; editorBody.append(message);
    const editorFooter = document.createElement('footer'); editorFooter.className = 'configuration-footer configuration-editor-actions';
    const apply = document.createElement('button'); apply.type = 'submit'; apply.className = 'configuration-primary'; apply.textContent=t('Save'); editorFooter.append(button(t('Cancel'),()=>editor.close()),apply); form.append(editorBody,editorFooter);
    form.onsubmit = event => { event.preventDefault(); void (async () => { try {
      const get = (key:string) => inputs.get(key)!.value;
      const updated = parseConfigurationField({name:get('name'),type:get('type'),label:get('label'),description:get('description'),required:(inputs.get('required') as HTMLInputElement).checked,secret:(inputs.get('secret') as HTMLInputElement).checked,multiple:(inputs.get('multiple') as HTMLInputElement).checked,
        ...(get('defaultValue').trim() ? {defaultValue:JSON.parse(get('defaultValue'))} : {}),...(type.value==='string' && get('options').trim() ? {options:get('options').split('\n').filter(Boolean).map(value=>({value}))} : {}),...(type.value==='file' && get('accept').trim() ? {accept:get('accept').split('\n').map(value=>value.trim()).filter(Boolean)} : {})});
      apply.disabled = true;
      const unlock = lockControls(editor);
      try {
        if (await dispatch({action:'field.save',field:updated,key:field?.name})) editor.close();
        else message.textContent = status.textContent;
      } finally { unlock(); }
    } catch (e) { message.textContent=(e as Error).message; } finally { apply.disabled = false; } })(); };
    editor.append(editorHeader,form); document.body.append(editor); editor.addEventListener('close',()=>{ editingField = false; editor.remove(); addField.focus(); if(latest && !dirty) { draft = undefined; render(latest); } },{once:true}); editor.showModal(); key.focus();
  }
  function fileControl(field: ProjectConfigurationField, value: unknown, defaultValue: unknown): HTMLElement {
    const control=document.createElement('div'); control.className='configuration-file';
    const list=document.createElement('div'); list.className='configuration-file-list';
    const picker=document.createElement('input'); picker.type='file'; picker.hidden=true; picker.accept=field.accept?.join(',')??''; picker.multiple=!!field.multiple; picker.ariaLabel=t('Choose file for {0}',field.label||field.name);
    let references: ProjectConfigurationFile[] = [];
    try { references=(value===undefined?[]:field.multiple&&Array.isArray(value)?value:[value]).map(parseConfigurationFile); }
    catch(e) { error(e); }
    readers.set(field.name,()=>{if(!field.multiple&&!references.length)throw new Error(t('Choose a file before saving.'));return field.multiple?references:references[0];});
    const choose=button(t('Choose file'),()=>picker.click()); choose.id=`configuration-field-${field.name}`; choose.prepend(document.createRange().createContextualFragment(iconHtml('cloud-upload')));
    const clear=iconButton('clear-all',t('Clear file selection'),()=>{references=(defaultValue===undefined?[]:field.multiple&&Array.isArray(defaultValue)?defaultValue:[defaultValue]).map(parseConfigurationFile);overrides.delete(field.name);changed();display();});
    resets.set(field.name,clear);
    function display() {
      list.replaceChildren(); clear.disabled=working||!overrides.has(field.name);
      choose.lastChild!.textContent=t(references.length?'Replace file':'Choose file');
      for(const reference of references) {
        const row=document.createElement('div'); row.className='configuration-file-reference';
        const name=document.createElement('span'); name.textContent=reference.name; name.title=reference.name;
        const size=document.createElement('small'); size.textContent=reference.size<1024?`${reference.size} B`:reference.size<1024*1024?`${(reference.size/1024).toFixed(1)} KiB`:`${(reference.size/1024/1024).toFixed(1)} MiB`;
        row.innerHTML=iconHtml(reference.mimeType.startsWith('image/')?'file-media':'file'); row.append(name,size);list.append(row);
      }
      if(!references.length) { const empty=document.createElement('small'); empty.textContent=t('No file selected'); list.append(empty); }
    }
    picker.onchange=()=>void(async()=>{
      const files=Array.from(picker.files??[]);picker.value='';if(!files.length||working||!draft)return;
      const scope=draft, id=detailId;
      working=true;const unlock=lockControls(dialog);status.classList.remove('error');status.textContent=t('Uploading to server...');
      try {
        if(files.length>(field.multiple?32:1))throw new Error(t('Select at most {0} files.',field.multiple?32:1));
        for(const file of files)validateConfigurationFileSelection(field,{name:file.name,mimeType:file.type||'application/octet-stream',size:file.size});
        const uploaded:ProjectConfigurationFile[]=[];
        for(const file of files) {
          const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]!);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
          uploaded.push(parseConfigurationFile(await send({type:'project-configuration-upload',id,revision:scope.revision,key:field.name,file:{name:file.name,mimeType:file.type||'application/octet-stream',data}},120_000)));
        }
        if(draft!==scope)return;
        references=uploaded;changed(field.name);display();
        if(latest?.revision!==draft.revision)error(new Error(t('Configuration changed. Your draft is preserved. Refresh before saving.')));
      } catch(e) {if(draft===scope)error(e);}
      finally {working=false;unlock();display();updateActions();}
    })();
    const actions=document.createElement('div'); actions.className='configuration-file-actions';actions.append(choose,clear);control.append(list,actions,picker);display();return control;
  }
  function jsonObjectControl(field:ProjectConfigurationField,value:unknown,state:ProjectConfigurationState,raw:()=>HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement):HTMLElement {
    const group=document.createElement('div');group.className='configuration-json-properties';
    const walk=(item:any,parts:string[])=>{
      if(item&&typeof item==='object'&&!Array.isArray(item)){for(const [key,entry]of Object.entries(item))walk(entry,[...parts,key]);return;}
      const pointer=parts.map(key=>`/${configurationPointerPart(key)}`).join(''),cap=configurationCapability(state,field,pointer);
      const row=document.createElement('label');row.textContent=pointer;const input=document.createElement('input');input.value=typeof item==='string'?item:JSON.stringify(item);input.disabled=!cap.editable;input.title=!cap.editable?t('Locked by the project author for this version'):pointer;
      input.onchange=()=>{try{const copy=JSON.parse(raw().value);let parent=copy;for(const key of parts.slice(0,-1))parent=parent[key];parent[parts.at(-1)!]=typeof item==='string'?input.value:JSON.parse(input.value);raw().value=JSON.stringify(copy,null,2);changed(field.name);}catch(e){error(e);}};
      row.append(input);group.append(row);
    };walk(value,[]);return group;
  }
  let publicationDraft:ConfigurationPublicationDraft|undefined;
  const openPublicationPaths=new Set<string>();
  function publicationEdited() {
    publicationDirty=true;
    publicationPreview.hidden=true;
    publicationStatus.textContent=t('Unsaved changes');publicationStatus.classList.remove('error');
  }
  function publicationTable(headings:string[]) {
    const table=document.createElement('table');table.className='configuration-publication-table';
    const head=table.createTHead().insertRow();
    for(const text of headings){const cell=document.createElement('th');cell.scope='col';cell.textContent=t(text);head.append(cell);}
    return table;
  }
  function renderPublication() {
    if(!draft)return;publicationBody.replaceChildren();publicationPreview.hidden=true;
    publicationDraft??=structuredClone(draft.publication??createPublicationDraft(draft));
    const publication=publicationDraft;
    const help=document.createElement('p');help.className='configuration-publication-help';help.textContent=t('Only selected profiles are published. Personal values are never included automatically. Save the draft before publishing a project version.');
    const toolbar=document.createElement('section');toolbar.className='configuration-publication-toolbar';
    const profiles=document.createElement('fieldset');profiles.className='configuration-publication-profiles';
    const legend=document.createElement('legend');legend.textContent=t('Published profiles');profiles.append(legend);
    const choices=document.createElement('div');choices.className='configuration-publication-choices';profiles.append(choices);
    const available=[...draft.configurations,...publication.configurations.filter(profile=>!draft!.configurations.some(c=>c.id===profile.id))];
    for(const profile of available){
      const row=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=publication.configurations.some(p=>p.id===profile.id);
      check.onchange=()=>{publication.configurations=check.checked?[...publication.configurations,{id:profile.id,name:profile.name,...(profile.profileKey?{profileKey:profile.profileKey}:{}),values:draft!.configurations.some(c=>c.id===profile.id)?configurationSnapshot(draft!,profile.id,false).values:profile.values}]:publication.configurations.filter(p=>p.id!==profile.id);if(!publication.configurations.some(p=>p.id===publication.defaultConfigurationId))publication.defaultConfigurationId=publication.configurations[0]?.id??'';publicationEdited();renderPublication();};
      row.append(check,profile.name);choices.append(row);
    }
    const defaultLabel=document.createElement('label');defaultLabel.className='configuration-publication-default';defaultLabel.textContent=t('Default recipient profile');
    const defaultSelect=document.createElement('select');defaultSelect.disabled=!publication.configurations.length;
    for(const profile of publication.configurations)defaultSelect.add(new Option(profile.name,profile.id));defaultSelect.value=publication.defaultConfigurationId;
    defaultSelect.onchange=()=>{publication.defaultConfigurationId=defaultSelect.value;publicationEdited();};defaultLabel.append(defaultSelect);
    toolbar.append(profiles,defaultLabel,publicationMenu.trigger);publicationBody.append(help,toolbar);
    const table=publicationTable(['Configuration fields','Publish field','Include value','Allow user edits']);table.ariaLabel=t('Publication and permissions');
    const columns=[['publish','Publish field'],['includeValue','Include value'],['editable','Allow user edits']]as const;
    for(const field of publication.fields){
      const group=table.createTBody(),row=group.insertRow(),name=document.createElement('th');name.scope='row';name.textContent=field.control==='ai-models'?t('AI models'):field.label||field.name;row.append(name);
      for(const [key,label]of columns){
        const cell=row.insertCell(),check=document.createElement('input');check.type='checkbox';check.ariaLabel=`${field.control==='ai-models'?t('AI models'):field.label||field.name}: ${t(label)}`;check.checked=({publish:true,includeValue:false,editable:true,...field.sharing})[key];
        check.onchange=()=>{field.sharing={...field.sharing,[key]:check.checked};publicationEdited();};cell.append(check);
      }
      if(field.type==='json'){
        const cell=group.insertRow().insertCell();cell.colSpan=4;
        const details=document.createElement('details');details.className='configuration-publication-paths';details.open=openPublicationPaths.has(field.name);
        details.ontoggle=()=>{if(details.open)openPublicationPaths.add(field.name);else openPublicationPaths.delete(field.name);};
        const summary=document.createElement('summary');summary.textContent=t('JSON Pointer');details.append(summary);
        const pathBody=document.createElement('div');pathBody.className='configuration-publication-path-body';details.append(pathBody);
        if(Object.keys(field.paths??{}).length){
          const paths=publicationTable(['JSON Pointer','Publish field','Include value','Allow user edits','Configuration actions']);
          const body=paths.createTBody();
          for(const [pointer,rule]of Object.entries(field.paths??{})){
            const pathRow=body.insertRow(),name=document.createElement('th');name.scope='row';name.textContent=pointer;pathRow.append(name);
            for(const [key,label]of columns){
              const select=document.createElement('select');select.ariaLabel=`${pointer}: ${t(label)}`;
              for(const [value,label]of [['inherit','Inherit'],['true','Yes'],['false','No']])select.add(new Option(t(label!),value));
              select.value=rule[key]===undefined?'inherit':String(rule[key]);select.onchange=()=>{if(select.value==='inherit')delete rule[key];else rule[key]=select.value==='true';publicationEdited();};pathRow.insertCell().append(select);
            }
            pathRow.insertCell().append(iconButton('trash',t('Delete path'),()=>{delete field.paths![pointer];publicationEdited();renderPublication();}));
          }
          const scroll=document.createElement('div');scroll.className='configuration-publication-table-scroll';scroll.tabIndex=0;scroll.append(paths);pathBody.append(scroll);
        }
        const label=document.createElement('label');label.className='configuration-publication-add-path';label.textContent=t('JSON Pointer');
        const controls=document.createElement('div'),pointer=document.createElement('input');pointer.ariaLabel=`${field.name}: ${t('JSON Pointer')}`;pointer.placeholder='/connection/host';
        const add=iconButton('add',t('Add path'),()=>{try{const next=parseConfigurationField({...field,paths:{...field.paths,[pointer.value]:{}}});field.paths=next.paths;openPublicationPaths.add(field.name);publicationEdited();renderPublication();}catch(e){error(e);}});
        controls.append(pointer,add);label.append(controls);pathBody.append(label);cell.append(details);
      }
    }
    const scroll=document.createElement('div');scroll.className='configuration-publication-table-scroll';scroll.tabIndex=0;scroll.append(table);publicationBody.append(scroll,publicationPreview);
  }
  function render(next: ProjectConfigurationState) {
    if (latest && next.capabilities?.subject===latest.capabilities?.subject && next.revision < latest.revision) return;
    if (!latest || latest.revision !== next.revision || latest.activeConfigurationId !== next.activeConfigurationId) {
      const field = next.fields.find(field => field.name === AGENT_MODELS_CONFIGURATION_KEY && field.control === 'ai-models');
      const current = next.configurations.find(profile => profile.id === next.activeConfigurationId);
      // Resolve just this field: unrelated schema conflicts must leave the configuration UI usable.
      const models = field && current ? applyTemplateValues(next, current, {
        [field.name]: Object.hasOwn(current.values, field.name) ? current.values[field.name]! : field.defaultValue ?? [],
      })[field.name] ?? [] : undefined;
      missingAgentModels = Array.isArray(models) && !models.some(model => field?.allowThirdParty !== false || !!model && typeof model === 'object' && !Array.isArray(model) && model.source === 'system');
    }
    latest = next;
    const activeProfile=next.configurations.find(profile=>profile.id===next.activeConfigurationId);
    modeStatus.hidden=!next.profilePolicy;modeStatus.textContent=activeProfile?.name??'';
    modeStatus.title=next.configurationCapabilities?.[next.activeConfigurationId]?.description??'';
    // Usage reflects committed state even when value or publication drafts must be preserved.
    profileLabel.querySelector('.configuration-in-use')?.remove();
    if(detailId===next.activeConfigurationId)profileLabel.append(activeBadge());
    useCurrent.hidden=!detailId||detailId===next.activeConfigurationId;
    publicationTab.hidden=!next.canManagePublication;
    tabs.hidden=!detailId||publicationTab.hidden;
    if(!next.canManagePublication) {
      publicationDraft=undefined;publicationDirty=false;publicationBody.replaceChildren();publicationStatus.textContent='';publicationStatus.classList.remove('error');publicationPreview.textContent='';
      if(!publicationBody.hidden)showView(false);
      if(draft) {draft.canManagePublication=next.canManagePublication;delete draft.publication;delete draft.publicationPreview;}
    }
    const sameAccount=!draft||draft.capabilities?.subject===next.capabilities?.subject;
    if(detailId&&(!sameAccount||!next.configurations.some(profile=>profile.id===detailId))){
      suspendedDetailId=detailId;detailId=undefined;hideMenus();showView(false);
    }else if(suspendedDetailId&&sameAccount&&next.configurations.some(profile=>profile.id===suspendedDetailId)){
      detailId=suspendedDetailId;suspendedDetailId=undefined;showView(false);
    }
    if(draft&&next.capabilities){draft.capabilities={...next.capabilities!,subject:draft.capabilities?.subject??next.capabilities?.subject??'guest'};draft.configurationCapabilities=next.configurationCapabilities;}
    renderList(next);updateActions();
    if ((editingField || working) && draft) return;
    if ((dirty||publicationDirty) && draft) { if (draft.revision !== next.revision) error(new Error(t('Configuration changed. Your draft is preserved. Refresh before saving.'))); return; }
    if (draft?.revision === next.revision && JSON.stringify(draft)===JSON.stringify(next)) return;
    modelControls.forEach(control=>control.dispose());
    draft = structuredClone(next); dirty = false; fields.replaceChildren(); fieldRows.clear(); readers.clear(); overrides.clear(); resets.clear(); modelControls.length = 0;
    if(detailId&&!next.configurations.some(c=>c.id===detailId)){detailId=undefined;publicationDraft=undefined;showView(false);}
    renderList(next);
    const current=next.configurations.find(c=>c.id===(detailId??next.activeConfigurationId))!;
    profileLabel.textContent=current.name;
    useCurrent.dataset.configurationId=current.id;useCurrent.ariaLabel=t('Use this configuration')+': '+current.name;
    if(current.id===next.activeConfigurationId)profileLabel.append(activeBadge());
    (detailId?profileControls:listToolbar).append(transferMenu.trigger);
    showView(publicationView);
    const values = next.template?configurationSnapshot(next,current.id,false).values:current.values;
    const defaults = {...Object.fromEntries(next.fields.filter(field=>field.defaultValue!==undefined).map(field=>[field.name,field.defaultValue])),...(next.template?applyTemplateValues(next,{...current,deletedPaths:undefined},{}):{})};
    for (const key of Object.keys(current.values)) overrides.add(key);
    for (const key of Object.keys(current.deletedPaths??{})) overrides.add(key);
    status.textContent = next.conflicts?.length?t('Some field types changed. Saved drafts are preserved; resolve them before running.'):''; status.classList.remove('error'); save.disabled=true; fieldCount.textContent=String(next.fields.length); updateActions();
    if(!detailId)return;
    if (!next.fields.length) { const empty=document.createElement('div'); empty.className='configuration-empty'; empty.innerHTML=iconHtml('settings-gear'); const text=document.createElement('p'); text.textContent=t('No configuration fields. Add a custom field to get started.'); empty.append(text); fields.append(empty); }
    for (const field of [...next.fields].sort((a,b)=>Number(b.control==='ai-models')-Number(a.control==='ai-models'))) {
      const row=document.createElement('section'); row.className='configuration-field'; const fieldHeading=document.createElement('div'); fieldHeading.className='configuration-field-heading';
      row.tabIndex=-1;fieldRows.set(field.name,row);
      const title=document.createElement('label'); title.htmlFor=`configuration-field-${field.name}`; title.textContent=(field.control==='ai-models'?t('AI models'):field.label || field.name)+(field.required?' *':''); fieldHeading.append(title); row.append(fieldHeading);
      const controls=document.createElement('div'); controls.className='configuration-field-actions'; fieldHeading.append(controls);
      if (next.capabilities?.manageConfigurations!==false && next.customFields.some(f=>f.name===field.name)) {
        const remove=iconButton('trash',t('Delete field'),()=>{if(clean())void dispatch({action:'field.delete',key:field.name});}); remove.dataset.action='delete';
        controls.append(iconButton('edit',t('Edit field'),()=>{if(clean())void editField(field);}),remove);
      }
      const value=Object.hasOwn(values,field.name)?values[field.name]:field.defaultValue,capability=configurationCapability(next,field);
      if(!capability.editable){const locked=document.createElement('span');locked.innerHTML=iconHtml('lock');locked.title=t('Locked by the project author for this version');fieldHeading.append(locked);}
      if (field.control === 'ai-models') {
        const models = createAgentModelsControl({ value, disabled: !capability.editable, allowThirdParty: field.allowThirdParty, changed: () => changed(field.name), loadCatalog: () => send({type:'project-ai-catalog'}) });
        modelControls.push(models); readers.set(field.name, () => models.read()); row.append(models.element); fields.append(row); continue;
      }
      if(field.type==='file') {
        const file=fileControl(field,value,defaults[field.name]);if(!capability.editable)for(const control of file.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input'))control.disabled=true;row.append(file);
        const help=document.createElement('small');help.textContent=field.description??t('Files are uploaded to the server. Save to apply the selection.');row.append(help);fields.append(row);continue;
      }
      let input: HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;
      if (field.options) { const select=document.createElement('select'); select.multiple=!!field.multiple; for (const option of field.options) { const o=new Option(option.label??option.value,option.value); o.selected=field.multiple ? Array.isArray(value)&&value.includes(option.value) : value===option.value; select.add(o); } if(!field.multiple)select.value=value===undefined?'':String(value); input=select; readers.set(field.name,()=>field.multiple ? Array.from(select.selectedOptions).map(o=>o.value) : select.value); }
      else if (field.type==='json'||field.multiple) { const text=document.createElement('textarea'); text.rows=4; text.value=value===undefined?'':JSON.stringify(value,null,2); input=text; readers.set(field.name,()=>JSON.parse(text.value)); }
      else { const text=document.createElement('input'); text.type=field.type==='boolean'?'checkbox':field.type==='number'?'number':field.secret?'password':'text'; text.step='any'; text.value=value===undefined?'':String(value); text.checked=value===true; input=text; readers.set(field.name,()=>field.type==='boolean'?text.checked:field.type==='number'?(text.value.trim()?Number(text.value):NaN):text.value); }
      if(field.type==='json' && value && typeof value==='object' && !Array.isArray(value)) {
        row.append(jsonObjectControl(field,value,next,()=>input));
      }
      input.disabled=!capability.editable && !(field.type==='json' && Object.keys(field.paths??{}).some(pointer=>configurationCapability(next,field,pointer).editable));
      input.id=title.htmlFor; input.ariaLabel=field.label||field.name;
      input.oninput=()=>changed(field.name); input.onchange=()=>changed(field.name);
      const reset=iconButton('discard',t(defaults[field.name]===undefined?'Clear value for {0}':'Restore default for {0}',field.label||field.name),()=>{
        const value=defaults[field.name];
        if(input instanceof HTMLSelectElement) {if(field.multiple)for(const option of input.options)option.selected=Array.isArray(value)&&value.includes(option.value);else input.value=value===undefined?'':String(value);}
        else if(input instanceof HTMLInputElement&&field.type==='boolean')input.checked=value===true;
        else input.value=value===undefined?'':field.type==='json'||field.multiple?JSON.stringify(value,null,2):String(value);
        overrides.delete(field.name);changed();input.focus();
      }); if(!capability.editable)reset.disabled=true;resets.set(field.name,reset);controls.prepend(reset);
      const control=document.createElement('div'); control.className='configuration-field-control'; control.append(input); row.append(control);
      if (field.secret && input instanceof HTMLInputElement && input.type==='password') {
        const reveal=iconButton('eye',t('Show sensitive values'),()=>{const hidden=input.type==='password'; input.type=hidden?'text':'password'; updateIcon(reveal,hidden?'eye-closed':'eye'); reveal.title=reveal.ariaLabel=t(hidden?'Hide sensitive values':'Show sensitive values'); reveal.ariaPressed=String(hidden);}); reveal.ariaPressed='false'; control.classList.add('configuration-secret'); control.append(reveal);
      }
      const help=document.createElement('small'); help.textContent=field.description??field.name; row.append(help);
      fields.append(row);
    }
    updateActions();
  }
  function focusField(field: string) {
    const row=fieldRows.get(field);
    row?.scrollIntoView?.({block:'start'});
    (row?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') ?? row)?.focus();
  }
  function showActiveField(field: string) {
    if (!latest) return;
    detailId=latest.activeConfigurationId;draft=undefined;showView(false);render(latest);
    focusField(field);
  }
  async function open(field?: string) {
    const attempt = ++opening, hadState = !!latest;
    if (!dialog.open) opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : trigger;
    const blocked = !!field && (working || editingField || !clean());
    if(!working&&!editingField&&!dirty&&!publicationDirty){detailId=undefined;draft=undefined;showView(false);}
    if (latest) render(latest);
    if (!dialog.open) dialog.showModal();
    if (blocked) return;
    if (field && hadState) showActiveField(field);
    try {
      render(await request({action:'get'}));
      // A slow refresh must not navigate again after the user closes or browses the panel.
      if (!field || hadState || attempt !== opening || !dialog.open || working || editingField || !clean()) return;
      showActiveField(field);
    } catch (e) { if (attempt === opening && dialog.open) error(e); }
  }
  trigger.onclick = () => { void open(); };
  dialog.addEventListener('close',()=>{++opening;hideMenus();(opener?.isConnected?opener:trigger).focus();});
  window.addEventListener('message',event=>{
    if(event.source!==null) return;
    const message=event.data;
    if(message?.requestId && pending.has(message.requestId)) { const wait=pending.get(message.requestId)!; clearTimeout(wait.timer); pending.delete(message.requestId); message.type==='error'?wait.reject(new Error(message.message)):wait.resolve(message.value); }
    if(message?.type==='state'&&message.configurations) render(message.configurations);
    if(message?.type==='state'&&message.configurationError) error(new Error(message.configurationError));
    if (message?.type === 'state' && typeof message.authenticationRevision === 'number' && message.authenticationRevision !== authenticationRevision) {
      authenticationRevision = message.authenticationRevision; modelControls.forEach(control => control.invalidate());
    }
    if(message?.type==='project-configurations-open') (trigger as HTMLButtonElement).click();
  });
  return { needsAgentModels: () => missingAgentModels, openAgentModels: () => { void open(AGENT_MODELS_CONFIGURATION_KEY); } };
}
