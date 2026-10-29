// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createAgentModelsControl } from '../web/ui/agent-models';
import { loadAgentModelCatalog } from '../web/agent-model-catalog';
vi.mock('../web/localization', () => ({ t: (text: string) => text }));
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const third = { id: 'third', name: 'Custom', source: 'third-party', model: 'custom-model', apiKind: 'openai-completions', baseUrl: 'https://models.example/v1', apiKey: 'private-test-key' };
const system = { id: 'system', name: 'Subscribed', source: 'system', model: 'system-model', credentialId: 'subscription' };
function mount(value: unknown = [], disabled = false, loadCatalog = vi.fn(async () => ({ entries: [{ id: 'subscription', name: 'Plan', models: [{ id: 'system-model', name: 'System model' }] }] })), allowThirdParty = true, loadUserModels?: () => Promise<import('@steamharness/project-configuration').UserAgentModelSummary[]>) {
  const changed = vi.fn(), control = createAgentModelsControl({ value, disabled, loadCatalog, changed, allowThirdParty, loadUserModels }); document.body.append(control.element);
  return { ...control, changed, loadCatalog };
}
const click = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.ariaLabel === name || button.textContent === name)!.click();
it('imports a host model as a reference without copying its connection and preserves missing selections', async () => {
  const load = vi.fn().mockResolvedValueOnce([{ id: third.id, name: third.name, model: third.model, source: third.source }]).mockResolvedValueOnce([]);
  const control = mount([], false, undefined, true, load);
  click('Add model'); click('Settings models');
  await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[aria-label="Settings model"]')!.value).toBe(third.id));
  expect(document.querySelector('input[type=password]')).toBeNull();
  click('Apply model');
  expect(control.read()).toEqual([{ id: expect.any(String), name: third.name, source: 'user-settings', modelId: third.id }]);
  expect(JSON.stringify(control.read())).not.toMatch(/apiKey|baseUrl|private-test-key/);
  click('Edit model: Custom');
  await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[aria-label="Settings model"]')!.textContent).toContain('Unavailable'));
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Settings model"]')!.value).toBe(third.id);
  click('Apply model'); expect(control.read()[0]).toMatchObject({ modelId: third.id });
});
it('allows system settings references in a restricted project and ignores stale reference loads', async () => {
  let finish!: (value: any) => void;
  const control = mount([], false, undefined, false, () => new Promise(resolve => { finish = resolve; }));
  click('Add model'); click('Settings models'); click('System AI');
  finish([{...system}]); await Promise.resolve();
  expect(document.querySelector('[aria-label="Settings model"]')).toBeNull();
  click('Settings models'); finish([third, system]);
  await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[aria-label="Settings model"]')!.options).toHaveLength(1));
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Settings model"]')!.value).toBe(system.id);
  click('Apply model'); expect(control.read()[0]).toMatchObject({ source: 'user-settings', modelId: system.id });
});
it('limits a system-only project to subscribed models and lets old third-party entries be removed or replaced', async () => {
  const control = mount([third, {...third,id:'other-third',name:'Other custom'}, system], false, undefined, false);
  expect(document.body.textContent).toContain('This project only allows system AI');
  expect(document.querySelector('.configuration-active')?.parentElement?.textContent).toContain(system.name);
  expect(() => control.read()).toThrow(/only allows system AI/);
  click('Edit model: Custom');
  expect(document.querySelector<HTMLElement>('[role="radiogroup"]')!.hidden).toBe(true);
  expect(document.querySelector('input[type=password]')).toBeNull();
  await vi.waitFor(() => expect(document.querySelector('select[aria-label="Model"]')?.textContent).toContain('System model'));
  click('Apply model'); expect(document.querySelector('dialog')!.open).toBe(false);
  expect(() => control.read()).toThrow(/only allows system AI/);
  click('Delete model: Other custom'); expect(control.read()[0]).toMatchObject({id:'third',source:'system',model:'system-model'});
  click('Delete model: Subscribed'); expect(control.read()).toHaveLength(1);
});
it('only suggests system AI when a restricted project has no configured models or account', async () => {
  const control = mount([], false, vi.fn(async () => ({entries:[],unavailable:true})), false);
  expect(document.body.textContent).toContain('No models configured. Add a system AI model.');
  click('Add model');
  await vi.waitFor(() => expect(document.body.textContent).toContain('Sign in and configure system AI.'));
  expect(document.body.textContent).not.toContain('or use a third-party model');
  click('Cancel'); expect(control.read()).toEqual([]);
});
function fill(label: string, value: string) {
  const row = [...document.querySelectorAll('label')].find(row => row.firstChild?.textContent === label)!;
  const input = row.querySelector('input')!; input.value = value; input.dispatchEvent(new Event('input'));
}
it.each(['light', 'dark'])('highlights the current AI source in the %s theme, including on hover', theme => {
  const colors: Record<string, string> = {
    '--vscode-button-background': '#0078d4', '--vscode-button-foreground': '#ffffff', '--vscode-button-hoverBackground': '#006ab1',
    '--vscode-button-secondaryBackground': theme === 'dark' ? '#333333' : '#eeeeee',
    '--vscode-button-secondaryForeground': theme === 'dark' ? '#cccccc' : '#333333',
    '--vscode-editor-background': theme === 'dark' ? '#1f1f1f' : '#ffffff',
    '--vscode-toolbar-hoverBackground': theme === 'dark' ? '#333333' : '#e8e8e8',
  };
  // jsdom does not resolve theme variables or expose a native pointer hover state.
  let css = readFileSync(path.join(import.meta.dirname, '../web/ui/project-configurations.css'), 'utf8').replaceAll(':hover', '[data-hover]');
  let previous: string;
  do {
    previous = css;
    css = css.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (expression, token: string, fallback?: string) => colors[token] ?? fallback ?? expression);
  } while (css !== previous);
  const style = document.createElement('style'); style.textContent = css; document.body.append(style);
  mount(); click('Add model');
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role=radio]')];
  for (const source of ['System AI', 'Third-party AI', 'System AI']) {
    click(source);
    const selected = buttons.find(button => button.textContent === source)!;
    const other = buttons.find(button => button !== selected)!;
    expect(selected.getAttribute('aria-checked')).toBe('true');
    expect(other.getAttribute('aria-checked')).toBe('false');
    for (const hovered of [undefined, selected, other]) {
      buttons.forEach(button => button.toggleAttribute('data-hover', button === hovered));
      expect(getComputedStyle(selected).backgroundColor).toBe(hovered === selected ? 'rgb(0, 106, 177)' : 'rgb(0, 120, 212)');
      expect(getComputedStyle(selected).color).toBe('rgb(255, 255, 255)');
      expect(getComputedStyle(other).backgroundColor).toBe(hovered === other ? theme === 'dark' ? 'rgb(51, 51, 51)' : 'rgb(232, 232, 232)' : 'rgba(0, 0, 0, 0)');
    }
  }
});
it('loads subscriptions only on demand and hides the other source form', async () => {
  const control = mount(); expect(control.loadCatalog).not.toHaveBeenCalled();
  expect(document.querySelector('input')).toBeNull();
  click('Add model'); expect(document.querySelector('dialog')!.open).toBe(true);
  click('Third-party AI'); expect(document.querySelector('input[type=password]')).toBeTruthy(); expect(control.loadCatalog).toHaveBeenCalledTimes(1);
  click('System AI'); await vi.waitFor(() => expect(document.querySelector('select[aria-label="Model"]')?.textContent).toContain('System model'));
  expect(document.querySelectorAll('dialog label')).toHaveLength(2);
  expect(document.querySelector('dialog input')).toBeNull();
  expect(document.querySelector('input[type=password]')).toBeNull();
  click('Apply model'); expect(control.read()).toMatchObject([{ name: 'System model', source: 'system', credentialId: 'subscription', model: 'system-model' }]);
  click('Add model'); click('Third-party AI'); fill('Model name', 'Custom'); fill('Base URL', third.baseUrl); fill('Model ID', third.model); fill('API key', third.apiKey); click('Apply model');
  expect(control.read().map(entry => entry.source)).toEqual(['system', 'third-party']); expect(document.body.textContent).not.toContain(third.apiKey);
});
it('edits, deletes and changes the default in one ordered list while protecting unfinished drafts', () => {
  const control = mount([system, third]); click('Edit model: Custom'); fill('Model name', 'Updated');
  expect(() => control.read()).toThrow(/Add or cancel/); click('Delete model: Subscribed'); expect(control.read.bind(control)).toThrow();
  click('Apply model'); expect(control.read()[1]!.name).toBe('Updated');
  click('Set as default model: Updated'); expect(control.read()[0]!.id).toBe('third');
  click('Delete model: Subscribed'); expect(control.read()).toHaveLength(1); expect(control.changed).toHaveBeenCalled();
});
it('keeps the saved list on invalid input and exposes no write controls for locked values', () => {
  const control = mount([third]); click('Edit model: Custom'); fill('Base URL', 'file:///invalid'); click('Apply model');
  expect(document.body.textContent).toContain('HTTP or HTTPS'); click('Cancel'); expect(control.read()).toEqual([third]);
  document.body.replaceChildren(); mount([third], true); expect([...document.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true);
});
it('ignores a stale catalogue after switching sources and explains an empty subscription', async () => {
  let complete!: (value: any) => void; const load = vi.fn(() => new Promise<any>(resolve => { complete = resolve; })); mount([], false, load);
  click('Add model'); click('Third-party AI'); complete({ entries: [] }); await Promise.resolve(); expect(document.querySelector('input[type=password]')).toBeTruthy();
  click('System AI'); complete({ entries: [] }); await vi.waitFor(() => expect(document.body.textContent).toContain('No subscribed AI models'));
});
it('uses the independent AI identity and returns only model display metadata', async () => {
  const fetcher = vi.fn(async () => Response.json({ errCode: 0, data: { credentials: [{ id: 'subscription', name: 'Plan', providerType: 'anthropic', models: ['model'], credentialToken: 'must-not-leak', apiKey: 'must-not-leak' }] } })); vi.stubGlobal('fetch', fetcher);
  const result = await loadAgentModelCatalog({ serverUrl: 'https://project.example', accessToken: 'project-token', aiServerUrl: 'https://ai.example', aiAccessToken: 'ai-token' } as any);
  expect(fetcher).toHaveBeenCalledWith('https://ai.example/api/ai/catalog', expect.objectContaining({ headers: { Authorization: 'Bearer ai-token' }, redirect: 'error' }));
  expect(JSON.stringify(result)).not.toContain('must-not-leak'); expect(result.entries[0]?.models[0]?.id).toBe('model');
  fetcher.mockClear(); expect((await loadAgentModelCatalog()).unavailable).toBe(true); expect(fetcher).not.toHaveBeenCalled();
});

it('preserves the selected subscription and model draft when refreshing its catalogue', async () => {
  const entries = [
    { id: 'subscription', name: 'Plan', models: [{ id: 'system-model', name: 'First' }] },
    { id: 'other', name: 'Other plan', models: [{ id: 'other-first', name: 'Other first' }, { id: 'other-second', name: 'Other second' }] },
  ];
  const control = mount([], false, vi.fn(async () => ({ entries })));
  click('Add model');
  await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!.options).toHaveLength(2));
  const subscription = document.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!;
  subscription.value = 'other'; subscription.dispatchEvent(new Event('change'));
  const model = document.querySelector<HTMLSelectElement>('[aria-label="Model"]')!;
  model.value = 'other-second'; model.dispatchEvent(new Event('change'));
  click('Refresh system AI models');
  await vi.waitFor(() => expect(control.loadCatalog).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(model.options).toHaveLength(2));
  expect(subscription.value).toBe('other'); expect(model.value).toBe('other-second');
  click('Apply model');
  expect(control.read()).toMatchObject([{ name: 'Other second', credentialId: 'other', model: 'other-second' }]);
});

it('retains subscription guidance when reopening an empty cached catalogue', async () => {
  const control = mount([], false, vi.fn(async () => ({ entries: [], unavailable: true, subscriptionUrl: 'https://ai.example/settings/ai' })));
  click('Add model');
  await vi.waitFor(() => expect(document.body.textContent).toContain('Sign in and configure system AI'));
  click('Cancel'); click('Add model');
  await vi.waitFor(() => expect(document.body.textContent).toContain('Sign in and configure system AI'));
  expect(document.querySelector('a')?.href).toBe('https://ai.example/settings/ai');
  expect(control.loadCatalog).toHaveBeenCalledTimes(1);
});

it('retains an unavailable selection after an account change instead of choosing another plan', async () => {
  const load = vi.fn().mockResolvedValueOnce({ entries: [{ id: 'subscription', name: 'Plan', models: [{ id: 'system-model', name: 'System model' }] }] })
    .mockResolvedValueOnce({ entries: [{ id: 'different', name: 'Different plan', models: [{ id: 'different-model', name: 'Different model' }] }] });
  const control = mount([system], false, load);
  click('Edit model: Subscribed');
  await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[aria-label="Model"]')!.value).toBe('system-model'));
  control.invalidate();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!.options).toHaveLength(2));
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!.value).toBe('subscription');
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Model"]')!.value).toBe('system-model');
  click('Apply model'); expect(control.read()).toEqual([system]);
});

it('does not unlock configuration controls when a catalogue request finishes during a save', async () => {
  let finish!: (result: any) => void;
  mount([system], false, vi.fn(() => new Promise(resolve => { finish = resolve; })));
  click('Edit model: Subscribed');
  const subscription = document.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!;
  const model = document.querySelector<HTMLSelectElement>('[aria-label="Model"]')!;
  // The enclosing configuration panel locks its controls while saving.
  subscription.disabled = true; model.disabled = true;
  finish({ entries: [{ id: 'subscription', name: 'Plan', models: [{ id: 'system-model', name: 'System model' }] }] });
  await vi.waitFor(() => expect(model.value).toBe('system-model'));
  expect(subscription.disabled).toBe(true); expect(model.disabled).toBe(true);
});

it('discards only the popup draft, clears credentials and restores focus on cancel', () => {
  const control = mount([third]);
  const add = document.querySelector<HTMLButtonElement>('[aria-haspopup=dialog]')!; add.focus(); add.click();
  click('Third-party AI'); fill('API key', 'discard-me');
  expect(() => control.read()).toThrow(); click('Cancel');
  expect(document.querySelector('dialog')!.open).toBe(false);
  expect(document.querySelector('input[type=password]')).toBeNull();
  expect(document.activeElement).toBe(add); expect(control.read()).toEqual([third]);
});

it('uses keyboard source selection and preserves the model ID when changing its source', async () => {
  const control = mount([third]); click('Edit model: Custom');
  const sources = document.querySelector('[role=radiogroup]')!;
  sources.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(document.activeElement).toBe(document.querySelector('[role=radio][aria-checked=true]'));
  await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>('[aria-label=Model]')!.value).toBe('system-model'));
  click('Apply model'); expect(control.read()).toMatchObject([{ id: 'third', source: 'system', name: 'System model' }]);
});

it('ignores a catalogue that arrives after closing and disposes an open modal', async () => {
  let finish!: (result: any) => void;
  const control = mount([], false, vi.fn(() => new Promise(resolve => { finish = resolve; })));
  click('Add model'); click('Cancel'); finish({ entries: [] }); await Promise.resolve();
  expect(document.querySelector('dialog')!.open).toBe(false); expect(document.querySelector('dialog select')).toBeNull();
  click('Add model'); control.dispose(); expect(document.querySelector('dialog')!.open).toBe(false);
});
