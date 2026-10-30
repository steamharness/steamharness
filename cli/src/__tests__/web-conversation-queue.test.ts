import { afterEach, expect, it, vi } from 'vitest';
import { ConversationQueue } from '../web/ui/conversation-queue';
import type { ConversationSession } from '../web/workflow-types';

afterEach(() => vi.unstubAllGlobals());

function session(id = 'first'): ConversationSession {
  return { id, title: id, messages: [], createdAt: 1, updatedAt: 1, queuedInputs: ['one', 'two'].map(id => ({ id, text: id, params: {}, attachments: [], createdAt: 1 })) };
}

function fixture(durable = true) {
  const documentState = { activeElement: undefined as Element | undefined, createElement: () => new Element() };
  class Element extends EventTarget {
    hidden = false; disabled = false; draggable = false; className = ''; textContent = ''; title = ''; ariaLabel = '';
    dataset: Record<string, string> = {}; attributes = new Map<string, string>(); children: Element[] = []; parentElement?: Element;
    get classList() { return { contains: (value: string) => this.className.split(' ').includes(value) }; }
    get childNodes() { return this.children; }
    get firstElementChild() { return this.children[0]; }
    set innerHTML(value: string) {
      const icon = new Element(); icon.className = value.match(/class="([^"]+)"/)?.[1] ?? '';
      this.replaceChildren(icon);
    }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    contains(element?: Element): boolean { return element === this || this.children.some(child => child.contains(element)); }
    append(...elements: Element[]) { for (const element of elements) this.insertBefore(element, null); }
    insertBefore(element: Element, before: Element | null) {
      element.remove();
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, element); element.parentElement = this;
    }
    replaceChildren(...elements: Element[]) { for (const child of [...this.children]) child.remove(); this.append(...elements); }
    remove() {
      if (this.contains(documentState.activeElement)) documentState.activeElement = undefined;
      if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = undefined; }
    }
    focus() { documentState.activeElement = this; }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  }
  vi.stubGlobal('document', documentState);
  const root = new Element();
  const action = vi.fn(), edit = vi.fn(), reorder = vi.fn(), resume = vi.fn();
  const view = new ConversationQueue(root as unknown as HTMLElement, { action, edit, reorder, resume });
  const current = session();
  const state = { projectUri: 'project', session: current, sessions: [current], durable, ready: true, canExecute: true, pendingIds: new Set<string>() };
  const update = (patch: Partial<typeof state> = {}) => { Object.assign(state, patch); view.update(state); };
  const row = (id = 'one') => {
    const rootRow = root.children[1].children.find(row => row.dataset.id === id)!;
    const [label, status, controls, error] = rootRow.children;
    const [edit, up, send, remove] = controls.children;
    return { root: rootRow, label, status, edit, up, send, remove, error, errorText: error.children[0], retry: error.children[1] };
  };
  update();
  return { view, root, state, documentState, action, edit, reorder, resume, update, row };
}

it('keeps send and withdrawal available without a spinner while a queued message is being saved', () => {
  const f = fixture(); f.update({ pendingIds: new Set(['two']) });
  const row = f.row('two'), glyph = row.send.firstElementChild;
  expect(row.send.disabled).toBe(false); expect(row.remove.disabled).toBe(false);
  expect(row.send.hidden).toBe(false); expect(row.remove.hidden).toBe(false);
  expect(row.status.hidden).toBe(true); expect(glyph.className).toContain('codicon-send');
  row.remove.focus();
  for (let index = 0; index < 5; index++) {
    const next = structuredClone(f.state.session); next.updatedAt = (next.updatedAt ?? 0) + 1;
    f.update({ session: next, sessions: [next] });
    expect(f.row('two').root).toBe(row.root); expect(f.row('two').send.firstElementChild).toBe(glyph);
    expect(f.documentState.activeElement).toBe(row.remove);
  }
  f.update({ pendingIds: new Set() });
  expect(row.send.disabled).toBe(false); expect(row.status.hidden).toBe(true);
  expect(row.send.firstElementChild).toBe(glyph); expect(glyph.className).toContain('codicon-send');
});

it.each([false, true].flatMap(durable => ['queue-promote', 'queue-remove'].map(type => ({ durable, type }))))(
  'gives immediate per-message feedback and suppresses duplicate $type actions (durable=$durable)', ({ durable, type }) => {
    const f = fixture(durable), row = f.row();
    const button = type === 'queue-promote' ? row.send : row.remove;
    button.click();
    expect(f.action).toHaveBeenCalledOnce();
    const request = f.action.mock.calls[0][0];
    expect(request).toMatchObject({ type, id: 'one', projectUri: 'project', sessionId: 'first' });
    expect(f.root.children[1].children.map(row => row.dataset.id)).toEqual(['two']);
    expect(button.firstElementChild.className).not.toContain('codicon-loading');
    expect(f.row('two').send.disabled).toBe(false); expect(f.row('two').remove.disabled).toBe(false);
    button.dispatchEvent(new Event('click')); f.update(); expect(f.action).toHaveBeenCalledOnce();
    const receipt = { ...request, type: 'queue-updated' };
    expect(f.view.receive({ ...receipt, sessionId: 'other' })).toBe(false);
    expect(f.view.receive({ ...receipt, projectUri: 'other' })).toBe(false);
    expect(f.view.receive({ ...receipt, id: 'two' })).toBe(false);
    expect(f.view.receive(receipt)).toBe(true);
    f.update(); expect(f.root.children[1].children.map(row => row.dataset.id)).toEqual(['two']);
    f.state.session.queuedInputs = f.state.session.queuedInputs!.filter(input => input.id !== 'one');
    f.update(); expect(f.root.children[1].children.map(row => row.dataset.id)).toEqual(['two']);
  },
);

it('remembers withdrawal of an unconfirmed submission and dispatches it once to its original conversation after navigation', () => {
  const f = fixture(); f.update({ pendingIds: new Set(['one']) });
  f.row().remove.click();
  expect(f.root.children[1].children.map(row => row.dataset.id)).toEqual(['two']); expect(f.action).not.toHaveBeenCalled();
  const second = session('second');
  f.update({ session: second, sessions: [f.state.session, second], ready: false });
  f.update({ pendingIds: new Set() }); expect(f.action).not.toHaveBeenCalled();
  f.update({ ready: true });
  expect(f.action).toHaveBeenCalledOnce(); expect(f.action.mock.calls[0][0]).toMatchObject({ type: 'queue-remove', sessionId: 'first', id: 'one' });
  f.view.receive({ ...f.action.mock.calls[0][0], type: 'queue-updated' });
  expect(f.row().remove.disabled).toBe(false); expect(f.row().status.hidden).toBe(true);
  f.update(); expect(f.action).toHaveBeenCalledOnce();
});

it('keeps a promoted row hidden while stale queued snapshots arrive before consumption', () => {
  const f = fixture(), row = f.row(); row.send.click();
  const request = f.action.mock.calls[0][0];
  f.view.receive({ ...request, type: 'queue-updated' });
  for (let index = 0; index < 3; index++) {
    f.update({ session: structuredClone(f.state.session) });
    expect(f.root.children[1].children.map(row => row.dataset.id)).toEqual(['two']);
  }
  expect(f.action).toHaveBeenCalledOnce();
});

it.each(['queue-promote', 'queue-remove'])('retains a failed %s with its error and retries the same request only when connected', type => {
  const f = fixture(), original = f.row();
  (type === 'queue-promote' ? original.send : original.remove).click();
  const request = f.action.mock.calls[0][0];
  expect(f.view.receive({ ...request, type: 'error', requestType: 'send', message: 'Wrong operation' })).toBe(false);
  f.state.session.queuedInputs!.shift(); f.update();
  f.view.receive({ ...request, type: 'error', requestType: type, message: '<failure> Keep this input' });
  const row = f.row();
  expect(row.label.textContent).toBe('one');
  expect(row.error.hidden).toBe(false); expect(row.errorText.textContent).toBe('<failure> Keep this input');
  expect(row.root.attributes.get('aria-busy')).toBe('false'); expect(row.status.hidden).toBe(true);
  f.update({ ready: false }); row.retry.click(); expect(f.action).toHaveBeenCalledOnce(); expect(row.retry.disabled).toBe(true);
  f.update({ ready: true }); row.retry.click();
  expect(f.action).toHaveBeenCalledTimes(2); expect(f.action.mock.calls[1][0]).toEqual(request);
  expect(f.root.children[1].children.map(row => row.dataset.id)).toEqual(['two']);
});

it('retains editing, reordering, dragging and queue resume for ordinary conversations', () => {
  const f = fixture(false), first = f.row(), second = f.row('two');
  expect(first.edit.hidden).toBe(false); expect(first.up.disabled).toBe(true); expect(second.up.disabled).toBe(false);
  first.edit.click(); expect(f.edit).toHaveBeenCalledWith('one');
  second.up.click(); expect(f.reorder).toHaveBeenLastCalledWith(['two', 'one']);
  const transfer = { types: ['application/x-studio-queue'], getData: () => 'two', setData: vi.fn() };
  second.root.dispatchEvent(Object.assign(new Event('dragstart'), { dataTransfer: transfer }));
  expect(transfer.setData).toHaveBeenCalledWith('application/x-studio-queue', 'two');
  first.root.dispatchEvent(Object.assign(new Event('drop', { cancelable: true }), { dataTransfer: transfer }));
  expect(f.reorder).toHaveBeenLastCalledWith(['two', 'one']);
  const resume = f.root.children[0].children[1]; resume.click(); expect(f.resume).toHaveBeenCalledOnce();
  f.state.session.activeRunId = 'active'; f.update(); expect(resume.hidden).toBe(true);
  f.update({ durable: true }); expect(first.edit.hidden).toBe(true); expect(first.up.hidden).toBe(true); expect(first.root.draggable).toBe(false);
});

it('blocks queue execution during Server setup while retaining edits and withdrawal', () => {
  const f = fixture(false), first = f.row(), second = f.row('two');
  first.send.click(); const request = f.action.mock.calls[0][0];
  f.view.receive({ ...request, type: 'error', requestType: 'queue-promote', message: 'Complete Server setup' });
  const restored = f.row();
  f.update({ canExecute: false });
  const resume = f.root.children[0].children[1];
  expect(restored.send.disabled).toBe(true); expect(restored.retry.disabled).toBe(true); expect(resume.disabled).toBe(true);
  restored.send.click(); restored.retry.click(); resume.click();
  expect(f.action).toHaveBeenCalledOnce(); expect(f.resume).not.toHaveBeenCalled();
  restored.edit.click(); second.up.click(); second.remove.click();
  expect(f.edit).toHaveBeenCalledWith('one'); expect(f.reorder).toHaveBeenCalledWith(['two', 'one']);
  expect(f.action).toHaveBeenCalledTimes(2); expect(f.action.mock.calls[1][0].type).toBe('queue-remove');
  f.update({ canExecute: true });
  expect(restored.retry.disabled).toBe(false); expect(resume.disabled).toBe(false); expect(f.action).toHaveBeenCalledTimes(2);
  restored.retry.click(); expect(f.action).toHaveBeenCalledTimes(3); expect(f.action.mock.calls[2][0]).toEqual(request);
});

it.each(['queue-promote', 'queue-remove'] as const)('resolves an unconfirmed edited input by request identity for %s', type => {
  const f = fixture(); f.update({ pendingIds: new Set(['one']) });
  (type === 'queue-promote' ? f.row().send : f.row().remove).click();
  expect(f.action).not.toHaveBeenCalled();
  const edited = { ...f.state.session.queuedInputs![0], id: 'old-row', requestId: 'one' };
  f.state.session.queuedInputs![0] = edited;
  f.update({ pendingIds: new Set() });
  expect(f.action).toHaveBeenCalledOnce();
  expect(f.root.children[1].children.map(row => row.dataset.id)).toEqual(['two']);
  const request = f.action.mock.calls[0][0];
  f.view.receive({ ...request, type: 'error', requestType: type, message: 'Try again' });
  expect(f.row('old-row').errorText.textContent).toBe('Try again');
  f.row('old-row').retry.click();
  expect(f.action).toHaveBeenCalledTimes(2); expect(f.action.mock.calls[1][0]).toEqual(request);
  expect(f.root.children[1].children.map(row => row.dataset.id)).toEqual(['two']);
});
