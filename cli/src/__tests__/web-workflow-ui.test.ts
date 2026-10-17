import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateWorkflowValues, type WorkflowProject } from '../web/workflow-types';
import type { WorkflowRunRecord } from '../web/workflow-workspace';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireWorkflowHost: () => host }));
vi.mock('../web/ui/workflow-fields', () => ({ WorkflowFields: class { close() {} render() {} update() {} } }));
vi.mock('../web/ui/conversation-output', () => ({ ConversationOutput: class { update() {} } }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { closeUsage() {} } }));
vi.mock('../web/ui/ui', () => ({ iconHtml: () => '', iconButton: () => ({}), escapeHtml: (value: string) => value }));
vi.mock('../web/ui/toolbar', () => ({ aiUsageButton: () => '', toolPermissionsButton: () => '', projectInfoButton: () => '', narrowMenuDismiss: () => () => {} }));

class Element {
  hidden = true;
  disabled = false;
  open = false;
  textContent = '';
  innerHTML = '';
  className = '';
  value = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  onclick?: () => void;
  events = new Map<string, (event: { preventDefault(): void }) => void>();
  classList = { add: vi.fn(), toggle: vi.fn() };
  append(...elements: Element[]) { this.children.push(...elements); }
  prepend() {}
  remove() {}
  replaceChildren(...elements: Element[]) { this.children = elements; }
  setAttribute() {}
  addEventListener(type: string, callback: (event: { preventDefault(): void }) => void) { this.events.set(type, callback); }
  querySelector() { return undefined; }
  querySelectorAll(selector: string) { return selector === '.workflow-entry' ? this.children.filter(child => child.className === 'workflow-entry') : []; }
  close() { this.open = false; }
  click() { this.onclick?.(); this.events.get('click')?.({ preventDefault() {} }); }
}

const project: WorkflowProject = {
  id: 'workflow-ui', uri: 'file:///workflow-ui', folderPath: '/workflow-ui', name: 'Studio Control', projectType: 'workflow', fields: [],
  defaultEntrypoint: 'theme', entrypoints: [
    { id: 'theme', title: 'Set Studio theme', fields: [{ name: 'theme', label: 'Theme', type: 'string', required: true }] },
    { id: 'state', title: 'Get Studio state', fields: [] },
  ],
};
function state(run?: WorkflowRunRecord) {
  return { type: 'state', project, drafts: {}, runs: run ? [run] : [], run, running: false,
    history: { total: run ? 1 : 0, hasMore: false, query: '' }, account: { status: 'unauthenticated' }, authenticationRevision: 0 };
}
function record(status: 'success' | 'failed'): WorkflowRunRecord {
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
    try { validateWorkflowValues(project.entrypoints[0].fields!, {}); } catch (error) { validation = (error as Error).message; }
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
