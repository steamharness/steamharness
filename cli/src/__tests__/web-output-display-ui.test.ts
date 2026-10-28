import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationOutput } from '../web/ui/conversation-output';
import { ComposerOutput, RingOutput } from '../web/ui/output-display';
import type { OutputItem } from '../web/workflow-types';

vi.mock('../web/resource-cards', () => ({ conversationResourceCards: () => [] }));
vi.mock('../web/ui/ui', () => ({ escapeHtml: (value: string) => value, iconHtml: () => '', iconButton: () => ({}), markdownHtml: () => '', mediaUrl: () => '', updateIcon: () => {} }));

const disposables: { dispose(): void }[] = [];
afterEach(() => { for (const view of disposables.splice(0)) { view.dispose(); } vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture() {
  vi.useFakeTimers();
  const documentState = { activeElement: undefined as Element | undefined, body: undefined as unknown as Element, documentElement: undefined as unknown as Element, createElement: () => new Element() };
  class Element extends EventTarget {
    hidden = false;
    className = '';
    textContent = '';
    tabIndex = -1;
    dataset: Record<string, string | undefined> = {};
    attributes = new Map<string, string>();
    properties = new Map<string, string>();
    style = { setProperty: (name: string, value: string) => this.properties.set(name, value) };
    children: Element[] = [];
    parentElement?: Element;
    offsetWidth = 200;
    offsetHeight = 80;
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    append(...elements: Element[]) { for (const element of elements) { this.insertBefore(element, null); } }
    insertBefore(element: Element, before: Element | null) {
      element.remove();
      const index = before ? this.children.indexOf(before) : this.children.length;
      this.children.splice(index, 0, element); element.parentElement = this;
    }
    remove() {
      if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(element => element !== this); this.parentElement = undefined; }
      if (documentState.activeElement === this) { documentState.activeElement = undefined; }
    }
    replaceWith(element: Element) { const parent = this.parentElement; if (parent) { parent.insertBefore(element, this); this.remove(); } }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { top: 400, bottom: 432, right: 600 }; }
    focus() { documentState.activeElement?.dispatchEvent(new Event('blur')); documentState.activeElement = this; this.dispatchEvent(new Event('focus')); }
  }
  class Details extends Element {}
  documentState.body = new Element(); documentState.documentElement = new Element();
  const windowState = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800 });
  vi.stubGlobal('document', documentState); vi.stubGlobal('window', windowState);
  vi.stubGlobal('HTMLElement', Element); vi.stubGlobal('HTMLDetailsElement', Details);
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const tooltips = () => documentState.body.children.filter(element => element.className === 'output-ring-tooltip' && !element.hidden);
  return { Element, documentState, windowState, tooltips };
}

function ring(value: number, id = 'quota'): OutputItem {
  return { id, title: 'Quota', content: { value, total: 100, unit: 'MB' }, contentType: 'json', display: { type: 'ring' } };
}

describe('Ring output interaction', () => {
  it('shows only the most recent tooltip when focus and hover target different rings', () => {
    const { Element, documentState, windowState, tooltips } = fixture();
    const first = new RingOutput(ring(25)), second = new RingOutput(ring(75, 'other'));
    disposables.push(first, second); documentState.body.append(first.root as unknown as InstanceType<typeof Element>, second.root as unknown as InstanceType<typeof Element>);
    first.root.focus();
    second.root.dispatchEvent(new Event('pointerenter'));
    expect(tooltips()).toHaveLength(1);
    expect(tooltips()[0].children[2].textContent).toContain('75 / 100 MB');
    windowState.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(tooltips()).toHaveLength(0);
  });

  it('keeps an inline ring focused and updates its open tooltip through streaming changes', () => {
    const { Element, documentState, tooltips } = fixture();
    const root = new Element(); documentState.body.append(root);
    const output = new ConversationOutput(root as unknown as HTMLElement, { copy() {}, plan() {}, file() {}, image() {}, resource() {} });
    disposables.push(output);
    output.update({ role: 'assistant', content: '', items: [ring(25)] }, 'project', "main", 'conversation', []);
    const anchor = root.children[0]; anchor.focus();
    output.update({ role: 'assistant', content: '', items: [ring(75)] }, 'project', "main", 'conversation', []);
    expect(root.children[0]).toBe(anchor);
    expect(documentState.activeElement).toBe(anchor);
    expect(tooltips()).toHaveLength(1);
    expect(tooltips()[0].children[2].textContent).toContain('75 / 100 MB');
    output.dispose(); expect(tooltips()).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('dismisses the previous conversation tooltip when changing composer scope', () => {
    const { Element, documentState, tooltips } = fixture();
    const output = new ComposerOutput();
    const pinned = { ...ring(25), display: { type: 'ring', placement: 'composer-right' } } as const;
    output.update([pinned], 'first');
    documentState.body.append(output.root as unknown as InstanceType<typeof Element>);
    (output.root.children[0] as HTMLElement).focus(); expect(tooltips()).toHaveLength(1);
    output.update([pinned], 'second'); expect(tooltips()).toHaveLength(0);
    output.update([], 'second'); expect(output.root.hidden).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
});
