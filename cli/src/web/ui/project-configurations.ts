import { t } from '../localization';
import { iconButton, iconHtml, updateIcon } from './ui';
import { requestAction } from './action-dialog';
import { parseConfigurationField, type ProjectConfigurationAction, type ProjectConfigurationField, type ProjectConfigurationState, type ConfigurationValues } from '@steamharness/project-configuration';
import './project-configurations.css';

type Host = { postMessage(message: Record<string, unknown>): void };
export function projectConfigurationsButton(): string {
  return `<button id="project-configurations" class="icon-button" aria-haspopup="dialog" title="${t('Project configurations')}" aria-label="${t('Project configurations')}">${iconHtml('settings-gear')}</button>`;
}
/** Shared by all three local project pages. Drafts keep their original revision until saved/discarded. */
export function mountProjectConfigurations(host: Host): void {
  const trigger = document.getElementById('project-configurations')!;
  const dialog = document.createElement('dialog'); dialog.className = 'conversation-dialog project-configurations';
  const heading = document.createElement('header'), title = document.createElement('h2'); title.textContent = t('Project configurations');
  title.id = 'project-configurations-title'; dialog.setAttribute('aria-labelledby', title.id);
  const close = iconButton('close', t('Close'), () => dialog.close()); heading.append(title, close);
  const body = document.createElement('div'); body.className = 'dialog-body configuration-body';
  const status = document.createElement('p'); status.role = 'status'; status.className = 'configuration-status'; status.textContent = t('Loading...');
  const toolbar = document.createElement('section'); toolbar.className = 'configuration-profiles';
  const profileLabel = document.createElement('label'); profileLabel.textContent = t('Current configuration'); profileLabel.htmlFor = 'configuration-profile';
  const profileControls = document.createElement('div'); profileControls.className = 'configuration-profile-controls';
  const select = document.createElement('select'); select.id = profileLabel.htmlFor;
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
  body.append(fieldsHeader,fields); dialog.append(heading,toolbar,body,actions); document.body.append(dialog);
  let latest: ProjectConfigurationState | undefined, draft: ProjectConfigurationState | undefined, dirty = false, working = false, editingField = false;
  const readers = new Map<string, () => unknown>(), enabled = new Map<string, HTMLInputElement>();
  const pending = new Map<string,{resolve(value:any):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
  const error = (e: unknown) => { status.textContent = (e as Error).message ?? String(e); status.classList.add('error'); };
  function button(text: string, run: () => void): HTMLButtonElement { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = run; return b; }
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
    const requestId = crypto.randomUUID();
    return new Promise((resolve,reject) => { const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(t('The request timed out. Check the current status.'))); },30_000); pending.set(requestId,{resolve,reject,timer}); host.postMessage({type:'project-configuration',requestId,call}); });
  }
  function changed() { dirty = true; save.disabled = working; status.textContent = t('Unsaved changes'); status.classList.remove('error'); }
  function lockControls(root: ParentNode): () => void {
    const controls = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button')].map(control => [control, control.disabled] as const);
    for (const [control] of controls) control.disabled = true;
    return () => { for (const [control, disabled] of controls) if (control.isConnected) control.disabled = disabled; };
  }
  async function reload() {
    if (working) return;
    hideMenus(); working = true; const unlock = lockControls(dialog);
    try { const next = await request({action:'get'}); dirty = false; draft = undefined; render(latest && latest.revision > next.revision ? latest : next); }
    catch (e) { error(e); }
    finally { working = false; unlock(); updateActions(); }
  }
  async function dispatch(call: ProjectConfigurationAction) {
    if (!draft || working) return false;
    hideMenus(); working = true; const unlock = lockControls(dialog);
    try { const result = await request({...call,revision:draft.revision}); draft = undefined; dirty = false; render(latest && latest.revision > result.revision ? latest : result); return true; }
    catch (e) { error(e); return false; }
    finally { working = false; unlock(); updateActions(); }
  }
  async function commit() {
    if (!draft || !dirty || working) return;
    try {
      const values: ConfigurationValues = {}, unset: string[] = [];
      for (const field of draft.fields) {
        if (!enabled.get(field.name)?.checked) { unset.push(field.name); continue; }
        values[field.name] = readers.get(field.name)!() as any;
      }
      await dispatch({action:'save',id:draft.activeConfigurationId,values,unset});
    } catch (e) { error(e); }
  }
  function clean(): boolean { if (dirty) { error(new Error(t('Save or discard your draft before changing configurations.'))); return false; } return true; }
  async function profile(action: ProjectConfigurationAction['action']) {
    if (!draft || working || !clean()) return;
    editingField = true;
    try {
    const name = action === 'create' || action === 'rename' ? await requestAction({title:t(action === 'create' ? 'New configuration' : 'Rename configuration'),label:t('Configuration name'),value:action === 'rename' ? draft.configurations.find(c => c.id === draft!.activeConfigurationId)?.name : '',confirm:t('Save')})
      : action === 'delete' ? await requestAction({title:t('Delete this configuration?'),confirm:t('Delete'),danger:true}) : '';
    if (name !== undefined) await dispatch({action,id:draft.activeConfigurationId,...(name ? {name} : {})});
    } finally { editingField = false; if (latest && !dirty) { draft = undefined; render(latest); } }
  }
  select.onchange = () => { const id = select.value; if (clean()) void dispatch({action:'select',id}); else select.value = draft!.activeConfigurationId; };
  const create = iconButton('add', t('New configuration'), () => void profile('create'));
  const profilesMenu = menu('ellipsis', t('Configuration actions'), [
    {icon:'copy',label:t('Copy'),run:() => void profile('duplicate')},
    {icon:'edit',label:t('Rename'),run:() => void profile('rename')},
    {icon:'trash',label:t('Delete'),run:() => void profile('delete'),danger:true},
  ]);
  const transferMenu = menu('arrow-swap', t('Import / export'), [
    {icon:'import',label:t('Import'),run:importFile},
    {icon:'export',label:t('Export current'),run:() => void download(false)},
    {icon:'export',label:t('Export all'),run:() => void download(true)},
  ], t('Exports include all values, including sensitive fields.'));
  transferMenu.trigger.classList.add('configuration-transfer');
  const addField = button(t('Add field'), () => { if (draft && clean()) void editField(); });
  addField.className = 'configuration-add-field'; addField.prepend(document.createRange().createContextualFragment(iconHtml('add')));
  fieldsHeader.append(addField); profileControls.append(select,create,profilesMenu.trigger,transferMenu.trigger); toolbar.append(profileLabel,profileControls);
  function updateActions() {
    for (const control of [select,create,addField,...menus.flatMap(menu => [menu.trigger,...menu.items])]) control.disabled = working || !draft;
    profilesMenu.items[2]!.disabled = working || !draft || draft.configurations.length <= 1;
    refresh.disabled = working; save.disabled = working || !dirty || !draft;
  }
  updateActions();
  async function download(all: boolean) {
    if (!draft || !clean()) return;
    try { const document = await request({action:'export',id:all ? undefined : draft.activeConfigurationId});
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
    const type = document.createElement('select'); for (const value of ['string','number','boolean','json']) type.add(new Option(value,value)); type.value = field?.type ?? 'string'; label('Field type',type,'type');
    for (const [key,text] of [['label','Label'],['description','Description'],['defaultValue','Default value (JSON)'],['options','Options (one per line)']]) {
      const input = document.createElement('textarea'); input.rows = 2;
      input.value = key === 'defaultValue' ? (field?.defaultValue === undefined ? '' : JSON.stringify(field.defaultValue)) : key === 'options' ? field?.options?.map(o=>o.value).join('\n') ?? '' : String(field?.[key as 'label'] ?? ''); label(text,input,key);
    }
    for (const [key,text] of [['required','Required'],['secret','Sensitive'],['multiple','Multiple values']]) { const input=document.createElement('input'); input.type='checkbox'; input.checked=!!field?.[key as 'secret']; label(text,input,key); }
    const message = document.createElement('p'); message.role = 'alert'; editorBody.append(message);
    const editorFooter = document.createElement('footer'); editorFooter.className = 'configuration-footer configuration-editor-actions';
    const apply = document.createElement('button'); apply.type = 'submit'; apply.className = 'configuration-primary'; apply.textContent=t('Save'); editorFooter.append(button(t('Cancel'),()=>editor.close()),apply); form.append(editorBody,editorFooter);
    form.onsubmit = event => { event.preventDefault(); void (async () => { try {
      const get = (key:string) => inputs.get(key)!.value;
      const updated = parseConfigurationField({name:get('name'),type:get('type'),label:get('label'),description:get('description'),required:(inputs.get('required') as HTMLInputElement).checked,secret:(inputs.get('secret') as HTMLInputElement).checked,multiple:(inputs.get('multiple') as HTMLInputElement).checked,
        ...(get('defaultValue').trim() ? {defaultValue:JSON.parse(get('defaultValue'))} : {}),...(get('options').trim() ? {options:get('options').split('\n').filter(Boolean).map(value=>({value}))} : {})});
      apply.disabled = true;
      const unlock = lockControls(editor);
      try {
        if (await dispatch({action:'field.save',field:updated,key:field?.name})) editor.close();
        else message.textContent = status.textContent;
      } finally { unlock(); }
    } catch (e) { message.textContent=(e as Error).message; } finally { apply.disabled = false; } })(); };
    editor.append(editorHeader,form); document.body.append(editor); editor.addEventListener('close',()=>{ editingField = false; editor.remove(); addField.focus(); if(latest && !dirty) { draft = undefined; render(latest); } },{once:true}); editor.showModal(); key.focus();
  }
  function render(next: ProjectConfigurationState) {
    if (latest && next.revision < latest.revision) return;
    latest = next;
    if ((editingField || working) && draft) return;
    if (dirty && draft) { if (draft.revision !== next.revision) error(new Error(t('Configuration changed. Your draft is preserved. Refresh before saving.'))); return; }
    if (draft?.revision === next.revision) return;
    draft = structuredClone(next); dirty = false; fields.replaceChildren(); readers.clear(); enabled.clear();
    select.replaceChildren(...next.configurations.map(c=>new Option(c.name,c.id))); select.value=next.activeConfigurationId;
    const values = next.configurations.find(c=>c.id===next.activeConfigurationId)!.values;
    status.textContent = ''; status.classList.remove('error'); save.disabled=true; fieldCount.textContent=String(next.fields.length); updateActions();
    if (!next.fields.length) { const empty=document.createElement('div'); empty.className='configuration-empty'; empty.innerHTML=iconHtml('settings-gear'); const text=document.createElement('p'); text.textContent=t('No configuration fields. Add a custom field to get started.'); empty.append(text); fields.append(empty); }
    for (const field of next.fields) {
      const row=document.createElement('section'); row.className='configuration-field'; const fieldHeading=document.createElement('div'); fieldHeading.className='configuration-field-heading';
      const title=document.createElement('label'), toggle=document.createElement('input'); toggle.type='checkbox'; toggle.checked=Object.hasOwn(values,field.name); toggle.ariaLabel=t('Set value for {0}',field.name); toggle.title=toggle.ariaLabel; enabled.set(field.name,toggle);
      const caption=document.createElement('span'); caption.textContent=(field.label || field.name)+(field.required?' *':''); title.append(toggle,caption); fieldHeading.append(title); row.append(fieldHeading);
      if (next.customFields.some(f=>f.name===field.name)) {
        const controls=document.createElement('div'); controls.className='configuration-field-actions'; controls.append(iconButton('edit',t('Edit field'),()=>{if(clean())void editField(field);}),iconButton('trash',t('Delete field'),()=>{if(clean())void dispatch({action:'field.delete',key:field.name});})); fieldHeading.append(controls);
      }
      const value=Object.hasOwn(values,field.name) ? values[field.name] : field.defaultValue;
      let input: HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;
      if (field.options) { const select=document.createElement('select'); select.multiple=!!field.multiple; for (const option of field.options) { const o=new Option(option.label??option.value,option.value); o.selected=field.multiple ? Array.isArray(value)&&value.includes(option.value) : value===option.value; select.add(o); } input=select; readers.set(field.name,()=>field.multiple ? Array.from(select.selectedOptions).map(o=>o.value) : select.value); }
      else if (field.type==='json'||field.multiple) { const text=document.createElement('textarea'); text.rows=4; text.value=value===undefined?'':JSON.stringify(value,null,2); input=text; readers.set(field.name,()=>JSON.parse(text.value)); }
      else { const text=document.createElement('input'); text.type=field.type==='boolean'?'checkbox':field.type==='number'?'number':field.secret?'password':'text'; text.step='any'; text.value=value===undefined?'':String(value); text.checked=value===true; input=text; readers.set(field.name,()=>field.type==='boolean'?text.checked:field.type==='number'?(text.value.trim()?Number(text.value):NaN):text.value); }
      input.ariaLabel=field.label||field.name; input.disabled=!toggle.checked;
      toggle.onchange=()=>{input.disabled=!toggle.checked;changed();}; input.oninput=changed; input.onchange=changed;
      const control=document.createElement('div'); control.className='configuration-field-control'; control.append(input); row.append(control);
      if (field.secret && input instanceof HTMLInputElement && input.type==='password') {
        const reveal=iconButton('eye',t('Show sensitive values'),()=>{const hidden=input.type==='password'; input.type=hidden?'text':'password'; updateIcon(reveal,hidden?'eye-closed':'eye'); reveal.title=reveal.ariaLabel=t(hidden?'Hide sensitive values':'Show sensitive values'); reveal.ariaPressed=String(hidden);}); reveal.ariaPressed='false'; control.classList.add('configuration-secret'); control.append(reveal);
      }
      const help=document.createElement('small'); help.textContent=field.description??field.name; row.append(help);
      fields.append(row);
    }
  }
  trigger.onclick = () => { if (latest) render(latest); dialog.showModal(); void request({action:'get'}).then(render).catch(error); };
  dialog.addEventListener('close',()=>{hideMenus();trigger.focus();});
  window.addEventListener('message',event=>{
    if(event.source!==null) return;
    const message=event.data;
    if(message?.requestId && pending.has(message.requestId)) { const wait=pending.get(message.requestId)!; clearTimeout(wait.timer); pending.delete(message.requestId); message.type==='error'?wait.reject(new Error(message.message)):wait.resolve(message.value); }
    if(message?.type==='state'&&message.configurations) render(message.configurations);
    if(message?.type==='state'&&message.configurationError) error(new Error(message.configurationError));
    if(message?.type==='project-configurations-open') (trigger as HTMLButtonElement).click();
  });
}
