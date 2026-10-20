import { t } from '../localization';
import { iconHtml } from './ui';
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
  const close = button(t('Close'), () => dialog.close()); heading.append(title, close);
  const body = document.createElement('div'); body.className = 'dialog-body';
  const status = document.createElement('p'); status.role = 'status';
  const toolbar = document.createElement('div'); toolbar.className = 'configuration-toolbar';
  const select = document.createElement('select'); select.ariaLabel = t('Current configuration');
  const fields = document.createElement('div'); fields.className = 'configuration-fields';
  const actions = document.createElement('div'); actions.className = 'configuration-toolbar';
  const save = button(t('Save'), () => void commit());
  const refresh = button(t('Refresh and discard draft'), () => void reload());
  actions.append(save, refresh);
  body.append(status,toolbar,fields,actions); dialog.append(heading,body); document.body.append(dialog);
  let latest: ProjectConfigurationState | undefined, draft: ProjectConfigurationState | undefined, dirty = false, working = false, editingField = false;
  const readers = new Map<string, () => unknown>(), enabled = new Map<string, HTMLInputElement>();
  const pending = new Map<string,{resolve(value:any):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
  const error = (e: unknown) => { status.textContent = (e as Error).message ?? String(e); status.className = 'error'; };
  function button(text: string, run: () => void): HTMLButtonElement { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = run; return b; }
  function request(call: ProjectConfigurationAction): Promise<any> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve,reject) => { const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(t('The request timed out. Check the current status.'))); },30_000); pending.set(requestId,{resolve,reject,timer}); host.postMessage({type:'project-configuration',requestId,call}); });
  }
  function changed() { dirty = true; save.disabled = working; status.textContent = t('Unsaved changes'); status.className = ''; }
  function lockControls(root: ParentNode): () => void {
    const controls = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button')].map(control => [control, control.disabled] as const);
    for (const [control] of controls) control.disabled = true;
    return () => { for (const [control, disabled] of controls) if (control.isConnected) control.disabled = disabled; };
  }
  async function reload() {
    if (working) return;
    working = true; const unlock = lockControls(dialog);
    try { const next = await request({action:'get'}); dirty = false; draft = undefined; render(latest && latest.revision > next.revision ? latest : next); }
    catch (e) { error(e); }
    finally { working = false; unlock(); save.disabled = !dirty; }
  }
  async function dispatch(call: ProjectConfigurationAction) {
    if (!draft || working) return false;
    working = true; const unlock = lockControls(dialog);
    try { const result = await request({...call,revision:draft.revision}); draft = undefined; dirty = false; render(latest && latest.revision > result.revision ? latest : result); return true; }
    catch (e) { error(e); return false; }
    finally { working = false; unlock(); save.disabled = !dirty; }
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
  toolbar.append(select, ...(['create','duplicate','rename','delete'] as const).map((action,i) => button(t(['New configuration','Copy','Rename','Delete'][i]),() => void profile(action))));
  toolbar.append(button(t('Add field'),() => { if (clean()) void editField(); }),button(t('Export current'),() => void download(false)),button(t('Export all'),() => void download(true)),button(t('Import'),importFile));
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
    const editor = document.createElement('dialog'); editor.className = 'conversation-dialog project-configurations';
    editor.setAttribute('aria-label', t('Edit field'));
    const form = document.createElement('form'); form.className = 'dialog-body configuration-fields';
    const inputs = new Map<string,HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>();
    const label = (text:string,control:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement,key:string) => { const l = document.createElement('label'); l.textContent = t(text); l.append(control); form.append(l); inputs.set(key,control); };
    const key = document.createElement('input'); key.value = field?.name ?? ''; key.required = true; key.readOnly = false; label('Field key',key,'name');
    const type = document.createElement('select'); for (const value of ['string','number','boolean','json']) type.add(new Option(value,value)); type.value = field?.type ?? 'string'; label('Field type',type,'type');
    for (const [key,text] of [['label','Label'],['description','Description'],['defaultValue','Default value (JSON)'],['options','Options (one per line)']]) {
      const input = document.createElement('textarea'); input.rows = 2;
      input.value = key === 'defaultValue' ? (field?.defaultValue === undefined ? '' : JSON.stringify(field.defaultValue)) : key === 'options' ? field?.options?.map(o=>o.value).join('\n') ?? '' : String(field?.[key as 'label'] ?? ''); label(text,input,key);
    }
    for (const [key,text] of [['required','Required'],['secret','Sensitive'],['multiple','Multiple values']]) { const input=document.createElement('input'); input.type='checkbox'; input.checked=!!field?.[key as 'secret']; label(text,input,key); }
    const message = document.createElement('p'); message.role = 'alert'; form.append(message);
    const apply = document.createElement('button'); apply.type = 'submit'; apply.textContent=t('Save'); form.append(apply,button(t('Cancel'),()=>editor.close()));
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
    editor.append(form); document.body.append(editor); editor.addEventListener('close',()=>{ editingField = false; editor.remove(); if(latest && !dirty) { draft = undefined; render(latest); } },{once:true}); editor.showModal();
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
    status.textContent = t('Exports include all values, including sensitive fields.'); status.className=''; save.disabled=true;
    if (!next.fields.length) { const empty=document.createElement('p'); empty.textContent=t('No configuration fields. Add a custom field to get started.'); fields.append(empty); }
    for (const field of next.fields) {
      const row=document.createElement('section'), title=document.createElement('label'), toggle=document.createElement('input'); toggle.type='checkbox'; toggle.checked=Object.hasOwn(values,field.name); toggle.ariaLabel=t('Set value for {0}',field.name); enabled.set(field.name,toggle);
      const caption=document.createElement('span'); caption.textContent=(field.label || field.name)+(field.required?' *':''); title.append(toggle,caption); row.append(title);
      const value=Object.hasOwn(values,field.name) ? values[field.name] : field.defaultValue;
      let input: HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;
      if (field.options) { const select=document.createElement('select'); select.multiple=!!field.multiple; for (const option of field.options) { const o=new Option(option.label??option.value,option.value); o.selected=field.multiple ? Array.isArray(value)&&value.includes(option.value) : value===option.value; select.add(o); } input=select; readers.set(field.name,()=>field.multiple ? Array.from(select.selectedOptions).map(o=>o.value) : select.value); }
      else if (field.type==='json'||field.multiple) { const text=document.createElement('textarea'); text.rows=4; text.value=value===undefined?'':JSON.stringify(value,null,2); input=text; readers.set(field.name,()=>JSON.parse(text.value)); }
      else { const text=document.createElement('input'); text.type=field.type==='boolean'?'checkbox':field.type==='number'?'number':field.secret?'password':'text'; text.step='any'; text.value=value===undefined?'':String(value); text.checked=value===true; input=text; readers.set(field.name,()=>field.type==='boolean'?text.checked:field.type==='number'?(text.value.trim()?Number(text.value):NaN):text.value); }
      input.ariaLabel=field.label||field.name; input.disabled=!toggle.checked;
      toggle.onchange=()=>{input.disabled=!toggle.checked;changed();}; input.oninput=changed; input.onchange=changed; row.append(input);
      if (field.secret && input instanceof HTMLInputElement && input.type==='password') row.append(button(t('Show / hide'),()=>{input.type=input.type==='password'?'text':'password';}));
      const help=document.createElement('small'); help.textContent=field.description??field.name; row.append(help);
      if (next.customFields.some(f=>f.name===field.name)) row.append(button(t('Edit field'),()=>{if(clean())void editField(field);}),button(t('Delete field'),()=>{if(clean())void dispatch({action:'field.delete',key:field.name});}));
      fields.append(row);
    }
  }
  trigger.onclick = () => { if (latest) render(latest); dialog.showModal(); void request({action:'get'}).then(render).catch(error); };
  dialog.addEventListener('close',()=>trigger.focus());
  window.addEventListener('message',event=>{
    if(event.source!==null) return;
    const message=event.data;
    if(message?.requestId && pending.has(message.requestId)) { const wait=pending.get(message.requestId)!; clearTimeout(wait.timer); pending.delete(message.requestId); message.type==='error'?wait.reject(new Error(message.message)):wait.resolve(message.value); }
    if(message?.type==='state'&&message.configurations) render(message.configurations);
    if(message?.type==='state'&&message.configurationError) error(new Error(message.configurationError));
    if(message?.type==='project-configurations-open') (trigger as HTMLButtonElement).click();
  });
}
