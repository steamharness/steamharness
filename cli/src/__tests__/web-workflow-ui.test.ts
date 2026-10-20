import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateProjectValues, type Project } from '../web/workflow-types';
import type { RunRecord } from '../web/workflow-workspace';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/workflow-fields', () => ({ Fields: class { close() {} render() {} update() {} } }));
vi.mock('../web/ui/conversation-output', () => ({ ConversationOutput: class { update() {} } }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { closeUsage() {} } }));
vi.mock('../web/ui/project-configurations', () => ({ projectConfigurationsButton: () => '', mountProjectConfigurations: () => {} }));
vi.mock('../web/ui/toolbar', () => ({ aiUsageButton: () => '', toolPermissionsButton: () => '', projectInfoButton: () => '', narrowMenuDismiss: () => () => {} }));

class Element {
  hidden = true;
  disabled = false;
  open = false;
  textContent = '';
  private html = '';
  get innerHTML() { return this.html; }
  set innerHTML(value: string) {
    this.html = value;
    this.replaceChildren();
    const icon = value.match(/^<span class="([^"]+)" aria-hidden="true"><\/span>$/);
    if (icon) { const glyph = new Element(); glyph.className = icon[1]; this.append(glyph); }
  }
  className = '';
  title = '';
  ariaLabel = '';
  value = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  parentElement?: Element;
  attributes = new Map<string, string>();
  get childNodes() { return this.children; }
  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children.at(-1); }
  onclick?: () => void;
  events = new Map<string, (event: { preventDefault(): void }) => void>();
  classList = { add: vi.fn(), toggle: vi.fn(), contains: (value: string) => this.className.split(' ').includes(value) };
  append(...elements: Element[]) { for (const element of elements) { this.insertBefore(element, null); } }
  insertBefore(element: Element, before: Element | null) {
    element.remove(); this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, element); element.parentElement = this;
  }
  prepend() {}
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = undefined; } }
  replaceChildren(...elements: Element[]) { for (const child of [...this.children]) { child.remove(); } this.append(...elements); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(type: string, callback: (event: { preventDefault(): void }) => void) { this.events.set(type, callback); }
  querySelector() { return undefined; }
  querySelectorAll(selector: string) { return selector === '.workflow-entry' ? this.children.filter(child => child.className === 'workflow-entry') : []; }
  close() { this.open = false; }
  click() { this.onclick?.(); this.events.get('click')?.({ preventDefault() {} }); }
}

const project: Project = {
  id: 'workflow-ui', uri: 'file:///workflow-ui', folderPath: '/workflow-ui', name: 'Studio Control', projectType: 'workflow', fields: [],
  defaultEntrypoint: 'theme', entrypoints: [
    { id: 'theme', title: 'Set Studio theme', fields: [{ name: 'theme', label: 'Theme', type: 'string', required: true }] },
    { id: 'state', title: 'Get Studio state', fields: [] },
  ],
};
function state(run?: RunRecord) {
  return { type: 'state', project, drafts: {}, runs: run ? [run] : [], run, running: false, runningCount: run?.status === 'running' ? 1 : 0,
    history: { total: run ? 1 : 0, hasMore: false, query: '' }, account: { status: 'unauthenticated' }, authenticationRevision: 0 };
}
function record(status: RunRecord['status']): RunRecord {
  return { id: status, scopeId: status, title: 'Get Studio state', entrypointId: 'state', status, createdAt: 1, updatedAt: 1,
    args: [], params: {}, policies: {}, items: [], files: [], events: [], nodes: [], logs: '', resolvedInputs: [],
    ...(status === 'failed' ? { error: 'Run failure' } : {}) };
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

async function fixture() {
  const elements = new Map<string, Element>();
  const element = (id: string) => { if (!elements.has(id)) { elements.set(id, new Element()); } return elements.get(id)!; };
  let receive!: (event: { data: unknown }) => void;
  vi.stubGlobal('document', { querySelector: element, getElementById: element, createElement: () => new Element() });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal('addEventListener', (_type: string, callback: typeof receive) => { receive = callback; });
  await import('../web/ui/workflow-main');
  const emit = (data: unknown) => receive({ data });
  emit(state()); emit({ type: 'connection', status: 'connected' });
  const request = (type: string) => host.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === type).at(-1)!;
  const resolved = () => { const message = request('resolve'); emit({ type: 'params', entrypointId: message.entrypointId, requestId: message.requestId, params: {} }); };
  const fail = (message: Record<string, unknown>, text = 'Please enter Theme.') => emit({ type: 'error', requestType: message.type, errorScope: message.errorScope, message: text });
  resolved();
  const select = (id: string) => { element('entrypoints').children.find(child => child.dataset.entrypoint === id)!.children[0].click(); resolved(); };
  return { element, emit, request, fail, select };
}

describe('Workflow request alerts', () => {
  it('keeps required validation and clears its alert when a later run succeeds and a new run is opened', async () => {
    const { element, emit, request, fail, select } = await fixture();
    element('run').click();
    let validation = '';
    try { validateProjectValues(project.entrypoints[0].fields!, {}); } catch (error) { validation = (error as Error).message; }
    expect(validation).toContain('Theme'); fail(request('workflow-run'), validation);
    expect(element('error').hidden).toBe(false); expect(element('error').textContent).toBe(validation);
    select('state'); expect(element('error').hidden).toBe(true);
    element('run').click(); emit(state(record('success')));
    expect(element('error').hidden).toBe(true); expect(element('error').textContent).toBe('');
    element('new').click(); emit(state());
    expect(element('error').hidden).toBe(true);
  });

  it('clears the alert immediately on new, even before any server state update', async () => {
    const { element, request, fail } = await fixture();
    element('run').click(); fail(request('workflow-run'));
    element('new').click();
    expect(request('workflow-select').id).toBeUndefined();
    expect(element('error').hidden).toBe(true); expect(element('error').textContent).toBe('');
  });

  it('clears an old alert on retry and still displays the new request failure', async () => {
    const { element, request, fail } = await fixture();
    element('run').click(); fail(request('workflow-run'), 'First validation error');
    element('run').click(); expect(element('error').hidden).toBe(true);
    fail(request('workflow-run'), 'Second validation error');
    expect(element('error').hidden).toBe(false); expect(element('error').textContent).toBe('Second validation error');
  });

  it.each(['new', 'entrypoint'])('ignores a late failure after moving to %s without releasing a newer submission', async target => {
    const { element, request, fail, select } = await fixture();
    element('run').click(); const previous = request('workflow-run');
    if (target === 'new') { element('new').click(); } else { select('state'); }
    fail(previous); expect(element('error').hidden).toBe(true);
    expect(element('run').disabled).toBe(false);
    element('run').click(); const current = request('workflow-run');
    expect(element('run').disabled).toBe(true);
    fail(previous); expect(element('run').disabled).toBe(true); expect(element('error').hidden).toBe(true);
    fail(current, 'Current failure');
    expect(element('run').disabled).toBe(false); expect(element('error').textContent).toBe('Current failure');
  });

  it('clears request alerts on a changed run while preserving the run failure and history', async () => {
    const { element, emit, request, fail } = await fixture();
    element('run').click(); fail(request('workflow-run'));
    emit(state(record('failed')));
    expect(element('error').hidden).toBe(true); expect(element('run-error').hidden).toBe(false);
    expect(element('run-error').textContent).toBe('Run failure');
    element('new').click(); emit(state());
    expect(element('entrypoints').hidden).toBe(false); expect(element('run-detail').hidden).toBe(true);
    emit(state(record('failed'))); expect(element('run-error').textContent).toBe('Run failure');
  });

  it('still displays the current request failure when its state update arrives first', async () => {
    const { element, emit, request, fail } = await fixture();
    emit(state(record('success')));
    element('new').click(); const selection = request('workflow-select');
    emit(state()); fail(selection, 'Unable to save selection');
    expect(element('error').hidden).toBe(false); expect(element('error').textContent).toBe('Unable to save selection');
  });
});

describe('Workflow history indicators', () => {
  it('keeps rows and spinning glyphs stable across streamed updates, selection changes and reordering', async () => {
    const { element, emit, request } = await fixture();
    const running = record('running'), completed = record('success');
    emit({ ...state(running), runs: [running, completed] });
    const row = element('run-list').children[0], status = row.children[1].children[0], glyph = status.firstElementChild;
    expect(status.textContent).toBe(''); expect(status.title).toBe('Running');
    expect(status.ariaLabel).toBe('Running'); expect(glyph.className).toContain('codicon-loading');
    for (let index = 0; index < 4; index++) {
      emit({ ...state(completed), runningCount: 1, runs: [running, completed] });
      expect(element('run-list').children[0]).toBe(row); expect(status.firstElementChild).toBe(glyph);
    }
    emit({ ...state(completed), runningCount: 1, runs: [completed, { ...running, title: 'Renamed running workflow' }] });
    expect(element('run-list').children[1]).toBe(row); expect(status.firstElementChild).toBe(glyph);
    expect(row.children[0].textContent).toBe('Renamed running workflow'); row.click();
    expect(request('workflow-select').id).toBe(running.id);
    emit({ ...state(completed), runs: [completed, { ...running, status: 'failed' }] });
    expect(status.firstElementChild).toBe(glyph); expect(glyph.className).toContain('codicon-error');
    expect(status.title).toBe('Failed'); expect(status.textContent).toBe('');
    emit(state(completed)); expect(element('run-list').children).toHaveLength(1);
  });

  it('uses the project running count even when search or pagination hides the running record', async () => {
    const { element, emit } = await fixture();
    emit({ ...state(), runningCount: 1, history: { total: 40, hasMore: true, query: 'No match' } });
    const count = element('running-count'), glyph = count.firstElementChild;
    expect(element('run-list').children).toHaveLength(0); expect(count.hidden).toBe(false);
    expect(count.lastElementChild!.textContent).toBe('1'); expect(count.ariaLabel).toBe('Running workflows: 1');
    emit({ ...state(record('success')), runningCount: 1 });
    expect(count.hidden).toBe(false); expect(count.firstElementChild).toBe(glyph);
    emit(state(record('success'))); expect(count.hidden).toBe(true);
  });

  it('keeps the count working with an existing host that has not restarted to provide runningCount', async () => {
    const { element, emit } = await fixture();
    const { runningCount: _, ...previousState } = state();
    emit({ ...previousState, occupiedRun: record('running') });
    expect(element('running-count').hidden).toBe(false); expect(element('running-count').lastElementChild!.textContent).toBe('1');
    emit({ ...previousState, occupiedRun: record('waiting_for_input') }); expect(element('running-count').hidden).toBe(true);
    emit(previousState); expect(element('running-count').hidden).toBe(true);
  });
});
