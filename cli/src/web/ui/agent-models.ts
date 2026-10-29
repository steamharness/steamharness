import { AGENT_MODEL_PROTOCOLS, parseAgentModels, type ConfiguredAgentModel, type AgentModelCatalogEntry } from '@steamharness/project-configuration';
import { t } from '../localization';
import { iconButton, iconHtml } from './ui';

export function createAgentModelsControl(options: {
  value: unknown; disabled: boolean; allowThirdParty?: boolean; changed(): void;
  loadCatalog(): Promise<{ entries: AgentModelCatalogEntry[]; subscriptionUrl?: string; unavailable?: boolean }>;
}) {
  let models = parseAgentModels(options.value ?? []), source: 'system' | 'third-party' = 'system';
  const systemOnly = options.allowThirdParty === false;
  let editingId: string | undefined, formDirty = false, generation = 0;
  let catalog: Awaited<ReturnType<typeof options.loadCatalog>> | undefined;
  let opener: HTMLElement | undefined;
  const element = document.createElement('div'); element.className = 'configuration-ai-models';
  const button = (label: string, run: () => void) => { const control = document.createElement('button'); control.type = 'button'; control.textContent = t(label); control.disabled = options.disabled; control.onclick = run; return control; };
  const toolbar = document.createElement('div'); toolbar.className = 'configuration-ai-toolbar';
  const count = document.createElement('span'); count.className = 'configuration-count';
  const add = button('Add model', () => open()); add.prepend(document.createRange().createContextualFragment(iconHtml('add'))); add.setAttribute('aria-haspopup', 'dialog');
  toolbar.append(count, add);
  const list = document.createElement('ul'); list.className = 'configuration-ai-list'; list.ariaLabel = t('Configured models');
  const notice = document.createElement('p'); notice.role = 'status'; notice.className = 'configuration-status';
  const help = document.createElement('small'); help.textContent = t('The first model is the default. Save configurations to apply model changes.');
  const policyNotice = document.createElement('small'); policyNotice.textContent = systemOnly ? t('This project only allows system AI. Existing third-party models are unavailable; remove them or change their source before saving.') : '';
  policyNotice.hidden = !systemOnly;

  const dialog = document.createElement('dialog'); dialog.className = 'conversation-dialog project-configurations configuration-ai-editor'; dialog.id = `configuration-model-${crypto.randomUUID()}`;
  const heading = document.createElement('header'), title = document.createElement('h2'); title.id = `${dialog.id}-title`; dialog.setAttribute('aria-labelledby', title.id); add.setAttribute('aria-controls', dialog.id);
  const close = iconButton('close', t('Close'), () => dialog.close()); close.disabled = options.disabled; heading.append(title, close);
  const body = document.createElement('div'); body.className = 'dialog-body configuration-ai-editor-body';
  const sources = document.createElement('div'); sources.role = 'radiogroup'; sources.ariaLabel = t('AI source'); sources.className = 'configuration-ai-sources';
  const availableSources: ('system' | 'third-party')[] = systemOnly ? ['system'] : ['system', 'third-party'];
  sources.hidden = systemOnly;
  const sourceButtons = availableSources.map(value => {
    const control = button(value === 'system' ? 'System AI' : 'Third-party AI', () => {
      if (source === value || !clean()) return;
      source = value; renderForm();
    });
    control.role = 'radio'; sources.append(control); return control;
  });
  sources.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? sourceButtons.length - 1 : source === 'system' ? sourceButtons.length - 1 : 0;
    sourceButtons[index]!.click(); sourceButtons[source === 'system' ? 0 : 1]!.focus();
  };
  const form = document.createElement('div'); form.className = 'configuration-ai-form';
  const formNotice = document.createElement('p'); formNotice.role = 'status'; formNotice.className = 'configuration-status error';
  body.append(sources, form, formNotice);
  const footer = document.createElement('footer'); footer.className = 'configuration-footer configuration-ai-form-actions';
  const apply = button('Apply model', () => {
    try {
      const saved = models.find(entry => entry.id === editingId);
      const modelName = catalog?.entries.find(entry => entry.id === credential?.value)?.models.find(entry => entry.id === model.value)?.name;
      const common = { id: editingId ?? crypto.randomUUID(), name: source === 'system' ? modelName || (saved?.source === 'system' ? saved.name : '') || model.value.trim() : name.value.trim() || model.value.trim(), model: model.value.trim() };
      const candidate = source === 'system' ? { ...common, source, credentialId: credential.value } : { ...common, source, apiKind: protocol.value, baseUrl: url.value, apiKey: key.value };
      parseAgentModels([candidate], options);
      const index = models.findIndex(model => model.id === editingId), next = [...models];
      if (index < 0) next.push(candidate as ConfiguredAgentModel); else next[index] = candidate as ConfiguredAgentModel;
      models = parseAgentModels(next); formDirty = false; options.changed(); display(); dialog.close();
    } catch (error) { formNotice.textContent = t((error as Error).message); }
  });
  apply.className = 'configuration-primary';
  footer.append(button('Cancel', () => dialog.close()), apply); dialog.append(heading, body, footer);
  element.append(toolbar, list, policyNotice, notice, help, dialog);
  let name: HTMLInputElement, model: HTMLInputElement | HTMLSelectElement, key: HTMLInputElement, url: HTMLInputElement, protocol: HTMLSelectElement, credential: HTMLSelectElement;
  const edited = () => { formDirty = true; options.changed(); formNotice.textContent = ''; };
  function clean() {
    if (!formDirty) return true;
    notice.textContent = formNotice.textContent = t('Add or cancel the model being edited first.'); return false;
  }
  function input(label: string, value = '', type = 'text') {
    const control = document.createElement('input'); control.type = type; control.value = value; control.autocomplete = 'off'; control.oninput = edited; control.disabled = options.disabled;
    field(label, control); return control;
  }
  function field(label: string, control: HTMLElement) {
    const row = document.createElement('label'); row.textContent = t(label); row.append(control); form.append(row);
  }
  async function load(refresh = false) {
    const request = ++generation, saved = models.find(entry => entry.id === editingId);
    const status = document.createElement('div'); status.className = 'configuration-ai-catalog'; status.role = 'status';
    status.textContent = t('Loading system AI models...'); form.append(status);
    try {
      const result = await (refresh || !catalog ? options.loadCatalog() : catalog);
      if (request !== generation || !element.isConnected || !dialog.open || source !== 'system') return;
      const selectedCredential = credential.value || (saved?.source === 'system' ? saved.credentialId : ''), selectedModel = model.value || (saved?.source === 'system' ? saved.model : '') || '';
      catalog = result;
      const entries = result.entries;
      status.replaceChildren(); credential.replaceChildren();
      for (const entry of entries) credential.add(new Option(entry.name, entry.id));
      // Preserve a removed subscription/model instead of silently using another plan.
      if (selectedCredential && !entries.some(entry => entry.id === selectedCredential)) credential.add(new Option(selectedCredential, selectedCredential));
      if (selectedCredential) credential.value = selectedCredential;
      const updateModels = (selected?: string) => {
        model.replaceChildren();
        for (const entry of entries.find(entry => entry.id === credential.value)?.models ?? []) (model as HTMLSelectElement).add(new Option(entry.name, entry.id));
        if (selected && ![...(model as HTMLSelectElement).options].some(option => option.value === selected)) (model as HTMLSelectElement).add(new Option(selected, selected));
        if (selected) model.value = selected;
      };
      updateModels(selectedModel); credential.onchange = () => { updateModels(); edited(); };
      if (!entries.length) {
        status.textContent = t(result.unavailable ? systemOnly ? 'Sign in and configure system AI.' : 'Sign in and configure system AI, or use a third-party model.' : 'No subscribed AI models. Subscribe to system AI to add a model.');
        if (result.subscriptionUrl) { const link = document.createElement('a'); link.href = result.subscriptionUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = t('Manage subscriptions'); status.append(' ', link); }
      }
    } catch (error) {
      if (request === generation && dialog.open) status.textContent = t((error as Error).message);
    }
    if (request === generation && dialog.open) { const retry = iconButton('refresh', t('Refresh system AI models'), () => { status.remove(); void load(true); }); status.append(retry); }
  }
  function renderForm() {
    ++generation; form.replaceChildren(); formNotice.textContent = '';
    const entry = models.find(entry => entry.id === editingId && entry.source === source);
    sourceButtons.forEach((control, index) => { const active = index === (source === 'system' ? 0 : 1); control.setAttribute('aria-checked', String(active)); control.tabIndex = active ? 0 : -1; });
    if (source === 'system') {
      credential = document.createElement('select'); credential.ariaLabel = t('Provider'); field('Provider', credential);
      model = document.createElement('select'); model.ariaLabel = t('Model'); model.onchange = edited; field('Model', model);
      void load();
    } else {
      name = input('Model name', entry?.name);
      protocol = document.createElement('select'); for (const value of AGENT_MODEL_PROTOCOLS) protocol.add(new Option(value, value)); protocol.value = entry?.source === 'third-party' ? entry.apiKind : 'openai-completions'; protocol.onchange = edited; field('API protocol', protocol);
      url = input('Base URL', entry?.source === 'third-party' ? entry.baseUrl : '', 'url');
      model = input('Model ID', entry?.model);
      key = input('API key', entry?.source === 'third-party' ? entry.apiKey : '', 'password'); key.autocomplete = 'new-password';
      key.closest('label')!.className = 'configuration-ai-wide';
    }
  }
  function open(entry?: ConfiguredAgentModel) {
    if (options.disabled || !clean()) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : add;
    editingId = entry?.id; formDirty = false; source = systemOnly ? 'system' : entry?.source ?? source;
    title.textContent = t(entry ? 'Edit model' : 'Add model'); notice.textContent = '';
    renderForm(); if (!dialog.open) dialog.showModal();
    (source === 'system' ? credential : name).focus();
  }
  dialog.addEventListener('cancel', event => event.stopPropagation());
  dialog.addEventListener('close', event => {
    event.stopPropagation(); ++generation; formDirty = false; editingId = undefined; form.replaceChildren(); notice.textContent = formNotice.textContent = '';
    (opener?.isConnected ? opener : add).focus();
  });
  function display() {
    list.replaceChildren(); count.textContent = `${t('Configured models')} · ${models.length}`;
    if (!models.length) { const empty = document.createElement('li'); empty.className = 'configuration-ai-empty'; empty.textContent = t(systemOnly ? 'No models configured. Add a system AI model.' : 'No models configured. Add a system or third-party model.'); list.append(empty); }
    const defaultIndex = models.findIndex(entry => !systemOnly || entry.source === 'system');
    models.forEach((entry, index) => {
      const row = document.createElement('li'), text = document.createElement('div'); text.className = 'configuration-ai-model-name';
      const number = document.createElement('span'); number.className = 'configuration-ai-model-index'; number.textContent = String(index + 1); number.ariaHidden = 'true';
      const title = document.createElement('span'); title.textContent = entry.name;
      const detail = document.createElement('small'); detail.textContent = `${t(entry.source === 'system' ? 'System AI' : 'Third-party AI')} · ${entry.model}`;
      text.append(title, detail); row.append(number, text);
      if (systemOnly && entry.source === 'third-party') detail.append(` · ${t('Unavailable')}`);
      if (index === defaultIndex) { const badge = document.createElement('span'); badge.className = 'configuration-active'; badge.textContent = t('Default model'); row.append(badge); }
      const controls = document.createElement('div'); controls.className = 'configuration-ai-model-actions';
      const actions = [
        ...(index !== defaultIndex && (!systemOnly || entry.source === 'system') ? [iconButton('arrow-up', t('Set as default model') + ': ' + entry.name, () => { if (!clean()) return; models = [entry, ...models.filter(model => model.id !== entry.id)]; options.changed(); display(); })] : []),
        iconButton('edit', t('Edit model') + ': ' + entry.name, () => open(entry)),
        iconButton('trash', t('Delete model') + ': ' + entry.name, () => { if (!clean()) return; models = models.filter(model => model.id !== entry.id); options.changed(); display(); }),
      ];
      actions.forEach(control => { control.disabled = options.disabled; controls.append(control); }); row.append(controls); list.append(row);
    });
  }
  display();
  return {
    element,
    read() { if (formDirty && dialog.open) throw new Error(t('Add or cancel the model being edited first.')); return parseAgentModels(models, options); },
    invalidate() { catalog = undefined; ++generation; if (source === 'system' && dialog.open) { form.querySelector('.configuration-ai-catalog')?.remove(); void load(true); } },
    dispose() { ++generation; if (dialog.open) dialog.close(); },
  };
}
