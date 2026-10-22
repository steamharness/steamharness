// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentModelsControl } from '../web/ui/agent-models';
import { loadAgentModelCatalog } from '../web/agent-model-catalog';
vi.mock('../web/localization', () => ({ t: (text: string) => text }));
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const third = { id: 'third', name: 'Custom', source: 'third-party', model: 'custom-model', apiKind: 'openai-completions', baseUrl: 'https://models.example/v1', apiKey: 'private-test-key' };
const system = { id: 'system', name: 'Subscribed', source: 'system', model: 'system-model', credentialId: 'subscription' };
function mount(value: unknown = [], disabled = false, loadCatalog = vi.fn(async () => ({ entries: [{ id: 'subscription', name: 'Plan', models: [{ id: 'system-model', name: 'System model' }] }] }))) {
  const changed = vi.fn(), control = createAgentModelsControl({ value, disabled, loadCatalog, changed }); document.body.append(control.element);
  return { ...control, changed, loadCatalog };
}
const click = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.ariaLabel === name || button.textContent === name)!.click();
function fill(label: string, value: string) {
  const row = [...document.querySelectorAll('label')].find(row => row.firstChild?.textContent === label)!;
  const input = row.querySelector('input')!; input.value = value; input.dispatchEvent(new Event('input'));
}
it('loads subscriptions only on demand and hides the other source form', async () => {
  const control = mount(); expect(control.loadCatalog).not.toHaveBeenCalled();
  click('Third-party AI'); expect(document.querySelector('input[type=password]')).toBeTruthy(); expect(control.loadCatalog).not.toHaveBeenCalled();
  click('System AI'); await vi.waitFor(() => expect(document.querySelector('select[aria-label="Model ID"]')?.textContent).toContain('System model'));
  expect(document.querySelector('input[type=password]')).toBeNull();
  click('Apply model'); expect(control.read()).toMatchObject([{ source: 'system', credentialId: 'subscription', model: 'system-model' }]);
  click('Third-party AI'); fill('Model name', 'Custom'); fill('Base URL', third.baseUrl); fill('Model ID', third.model); fill('API key', third.apiKey); click('Apply model');
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
  click('System AI'); click('Third-party AI'); complete({ entries: [] }); await Promise.resolve(); expect(document.querySelector('input[type=password]')).toBeTruthy();
  click('System AI'); complete({ entries: [] }); await vi.waitFor(() => expect(document.body.textContent).toContain('No subscribed AI models'));
});
it('uses the independent AI identity and returns only model display metadata', async () => {
  const fetcher = vi.fn(async () => Response.json({ errCode: 0, data: { credentials: [{ id: 'subscription', name: 'Plan', providerType: 'anthropic', models: ['model'], credentialToken: 'must-not-leak', apiKey: 'must-not-leak' }] } })); vi.stubGlobal('fetch', fetcher);
  const result = await loadAgentModelCatalog({ serverUrl: 'https://project.example', accessToken: 'project-token', aiServerUrl: 'https://ai.example', aiAccessToken: 'ai-token' } as any);
  expect(fetcher).toHaveBeenCalledWith('https://ai.example/api/ai/catalog', expect.objectContaining({ headers: { Authorization: 'Bearer ai-token' }, redirect: 'error' }));
  expect(JSON.stringify(result)).not.toContain('must-not-leak'); expect(result.entries[0]?.models[0]?.id).toBe('model');
  fetcher.mockClear(); expect((await loadAgentModelCatalog()).unavailable).toBe(true); expect(fetcher).not.toHaveBeenCalled();
});
