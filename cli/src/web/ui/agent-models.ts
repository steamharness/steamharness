import { AGENT_MODEL_PROTOCOLS, parseAgentModels, type ConfiguredAgentModel, type AgentModelCatalogEntry } from '@steamharness/project-configuration';
import { t } from '../localization';
import { iconButton } from './ui';

export function createAgentModelsControl(options: {
  value: unknown; disabled: boolean; changed(): void;
  loadCatalog(): Promise<{ entries: AgentModelCatalogEntry[]; subscriptionUrl?: string; unavailable?: boolean }>;
}) {
  let models = parseAgentModels(options.value ?? []), source: 'system' | 'third-party' = 'system';
  let editingId: string | undefined, formDirty = false, generation = 0;
  let catalog: Awaited<ReturnType<typeof options.loadCatalog>> | undefined;
  const element = document.createElement('div'); element.className = 'configuration-ai-models';
  const toolbar = document.createElement('div'); toolbar.className = 'configuration-ai-toolbar';
  const sources = document.createElement('div'); sources.role = 'group'; sources.ariaLabel = t('AI source'); sources.className = 'configuration-ai-sources';
  const button = (label: string, run: () => void) => { const control = document.createElement('button'); control.type = 'button'; control.textContent = t(label); control.disabled = options.disabled; control.onclick = run; return control; };
  const sourceButtons = (['system', 'third-party'] as const).map(value => {
    const control = button(value === 'system' ? 'System AI' : 'Third-party AI', () => {
      if (formDirty) { notice.textContent = t('Add or cancel the model being edited first.'); return; }
      source = value; open();
    });
    sources.append(control); return control;
  });
  const add = iconButton('add', t('Add model'), () => open()); add.disabled = options.disabled;
  toolbar.append(sources, add);
  const form = document.createElement('div'); form.className = 'configuration-ai-form'; form.hidden = true;
  const list = document.createElement('ul'); list.className = 'configuration-ai-list'; list.ariaLabel = t('Configured models');
  const notice = document.createElement('p'); notice.role = 'status'; notice.className = 'configuration-status';
  const help = document.createElement('small'); help.textContent = t('The first model is the default. Save configurations to apply model changes.');
  element.append(toolbar, form, list, notice, help);
  let name: HTMLInputElement, model: HTMLInputElement | HTMLSelectElement, key: HTMLInputElement, url: HTMLInputElement, protocol: HTMLSelectElement, credential: HTMLSelectElement;
  const edited = () => { formDirty = true; options.changed(); notice.textContent = ''; };
  function input(label: string, value = '', type = 'text') {
    const control = document.createElement('input'); control.type = type; control.value = value; control.autocomplete = 'off'; control.oninput = edited; control.disabled = options.disabled;
    field(label, control); return control;
  }
  function field(label: string, control: HTMLElement) {
    const row = document.createElement('label'); row.textContent = t(label); row.append(control); form.append(row);
  }
  async function load(refresh = false) {
    const request = ++generation;
    const saved = models.find(entry => entry.id === editingId);
    const status = document.createElement('div'); status.className = 'configuration-ai-catalog'; status.role = 'status';
    status.textContent = t('Loading system AI models...'); form.prepend(status);
    try {
      const result = refresh || !catalog ? await options.loadCatalog() : catalog;
      if (request !== generation || !element.isConnected || form.hidden || source !== 'system') return;
      const selectedCredential = credential.value || (saved?.source === 'system' ? saved.credentialId : '');
      const selectedModel = model.value || saved?.model || '';
      catalog = result;
      const entries = result.entries;
      status.replaceChildren();
      credential.replaceChildren();
      for (const entry of entries) credential.add(new Option(entry.name, entry.id));
      // A refresh must preserve the draft, including a selection whose
      // subscription has since disappeared. It must never choose another plan.
      if (selectedCredential && !entries.some(entry => entry.id === selectedCredential)) credential.add(new Option(selectedCredential, selectedCredential));
      if (selectedCredential) credential.value = selectedCredential;
      const updateModels = (selected?: string) => {
        model.replaceChildren();
        for (const entry of entries?.find(entry => entry.id === credential.value)?.models ?? []) (model as HTMLSelectElement).add(new Option(entry.name, entry.id));
        if (selected && ![...(model as HTMLSelectElement).options].some(option => option.value === selected)) (model as HTMLSelectElement).add(new Option(selected, selected));
        if (selected) model.value = selected;
      };
      updateModels(selectedModel);
      credential.onchange = () => { updateModels(); edited(); };
      if (!entries.length) {
        status.textContent = t(result.unavailable ? 'Sign in and configure system AI, or use a third-party model.' : 'No subscribed AI models. Subscribe to system AI to add a model.');
        if (result.subscriptionUrl) { const link = document.createElement('a'); link.href = result.subscriptionUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = t('Manage subscriptions'); status.append(' ', link); }
      }
    } catch (error) {
      if (request === generation && element.isConnected) status.textContent = t((error as Error).message);
    }
    if (request === generation) { const retry = iconButton('refresh', t('Refresh system AI models'), () => { status.remove(); void load(true); }); status.append(retry); }
  }
  function open(entry?: ConfiguredAgentModel) {
    if (formDirty) { notice.textContent = t('Add or cancel the model being edited first.'); return; }
    ++generation; editingId = entry?.id; formDirty = false;
    if (entry) source = entry.source;
    sourceButtons.forEach((control, index) => { control.ariaPressed = String((index === 0 ? 'system' : 'third-party') === source); });
    form.hidden = false; form.replaceChildren(); notice.textContent = '';
    name = input('Model name', entry?.name);
    if (source === 'system') {
      credential = document.createElement('select'); credential.ariaLabel = t('Subscribed AI'); field('Subscribed AI', credential);
      model = document.createElement('select'); model.ariaLabel = t('Model ID'); model.onchange = edited; field('Model ID', model);
      void load();
    } else {
      protocol = document.createElement('select'); for (const value of AGENT_MODEL_PROTOCOLS) protocol.add(new Option(value, value)); protocol.value = entry?.source === 'third-party' ? entry.apiKind : 'openai-completions'; protocol.onchange = edited; field('API protocol', protocol);
      url = input('Base URL', entry?.source === 'third-party' ? entry.baseUrl : '', 'url');
      model = input('Model ID', entry?.model);
      key = input('API key', entry?.source === 'third-party' ? entry.apiKey : '', 'password'); key.autocomplete = 'new-password';
    }
    const actions = document.createElement('div'); actions.className = 'configuration-ai-form-actions';
    actions.append(button('Cancel', () => { ++generation; form.hidden = true; formDirty = false; editingId = undefined; notice.textContent = ''; add.focus(); }), button('Apply model', () => {
      try {
        const common = { id: editingId ?? crypto.randomUUID(), name: name.value.trim() || model.value.trim(), model: model.value.trim() };
        const candidate = source === 'system' ? { ...common, source, credentialId: credential.value } : { ...common, source, apiKind: protocol.value, baseUrl: url.value, apiKey: key.value };
        const index = models.findIndex(model => model.id === editingId);
        const next = [...models]; if (index < 0) next.push(candidate as ConfiguredAgentModel); else next[index] = candidate as ConfiguredAgentModel;
        models = parseAgentModels(next); formDirty = false; form.hidden = true; editingId = undefined; options.changed(); display(); add.focus();
      } catch (error) { notice.textContent = t((error as Error).message); }
    })); form.append(actions); name.focus();
  }
  function display() {
    list.replaceChildren();
    if (!models.length) { const empty = document.createElement('li'); empty.textContent = t('No models configured. Add a system or third-party model.'); list.append(empty); }
    models.forEach((entry, index) => {
      const row = document.createElement('li'), text = document.createElement('div'); text.className = 'configuration-ai-model-name';
      const title = document.createElement('span'); title.textContent = entry.name;
      const detail = document.createElement('small'); detail.textContent = `${t(entry.source === 'system' ? 'System AI' : 'Third-party AI')} · ${entry.model}`;
      text.append(title, detail); row.append(text);
      if (!index) { const badge = document.createElement('span'); badge.className = 'configuration-active'; badge.textContent = t('Default model'); row.append(badge); }
      const controls = [
        ...(index ? [iconButton('arrow-up', t('Set as default model') + ': ' + entry.name, () => { if (formDirty) { notice.textContent = t('Add or cancel the model being edited first.'); return; } models = [entry, ...models.filter(model => model.id !== entry.id)]; options.changed(); display(); })] : []),
        iconButton('edit', t('Edit model') + ': ' + entry.name, () => { if (formDirty) { notice.textContent = t('Add or cancel the model being edited first.'); return; } open(entry); }),
        iconButton('trash', t('Delete model') + ': ' + entry.name, () => { if (formDirty) { notice.textContent = t('Add or cancel the model being edited first.'); return; } models = models.filter(model => model.id !== entry.id); if (editingId === entry.id) { form.hidden = true; ++generation; } options.changed(); display(); }),
      ];
      controls.forEach(control => { control.disabled = options.disabled; row.append(control); }); list.append(row);
    });
  }
  sourceButtons[0]!.ariaPressed = 'true'; sourceButtons[1]!.ariaPressed = 'false'; display();
  return { element, read() { if (formDirty && !form.hidden) throw new Error(t('Add or cancel the model being edited first.')); return structuredClone(models); }, invalidate() { catalog = undefined; ++generation; if (source === 'system' && !form.hidden) { form.querySelector('.configuration-ai-catalog')?.remove(); void load(true); } } };
}
