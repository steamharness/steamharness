// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { updateRunningCount } from '../web/ui/history-status';
import type { ConversationSession, Project } from '../web/workflow-types';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
const listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];

function renderPage(name: string): HTMLElement {
  const source = ts.createSourceFile(name, readFileSync(path.join(import.meta.dirname, '../web/ui', `${name}.ts`), 'utf8'), ts.ScriptTarget.Latest, true);
  let template: ts.TemplateExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) && node.left.expression.getText(source) === 'app'
      && node.left.name.text === 'innerHTML' && ts.isTemplateExpression(node.right)) { template = node.right; }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!template) { throw new Error(`Missing ${name} page template`); }
  // Interpolations contain labels and icons; the literal fragments define the layout.
  document.body.innerHTML = `<div id="app">${template.head.text}${template.templateSpans.map(span => span.literal.text).join('')}</div>`;
  const style = document.createElement('style');
  style.textContent = readFileSync(path.join(import.meta.dirname, '../web/ui/style.css'), 'utf8'); document.head.append(style);
  return document.querySelector<HTMLElement>('#app')!;
}

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { target, type, listener, options } of listeners.splice(0)) target.removeEventListener(type, listener, options);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  document.body.replaceChildren(); document.head.replaceChildren();
});

it('keeps the composer disabled until its first conversation state can preserve a draft', () => {
  const app = renderPage('main');
  expect(app.querySelector<HTMLTextAreaElement>('#message')!.disabled).toBe(true);
  expect(app.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(true);
});

it.each(['main', 'workflow-main'])('keeps the %s running count in the page header when the sidebar is hidden', name => {
  const app = renderPage(name), counter = app.querySelector<HTMLElement>('#running-count')!;
  const toolbar = app.querySelector<HTMLElement>('header.toolbar')!, sidebar = app.querySelector<HTMLElement>('#project-menu')!;
  expect(app.querySelectorAll('#running-count')).toHaveLength(1);
  expect(counter.parentElement).toBe(toolbar.querySelector(name === 'main' ? '.project-context' : '.toolbar-actions'));
  expect(sidebar.contains(counter)).toBe(false);
  updateRunningCount(counter, 2, 'Running: 2');
  const glyph = counter.firstElementChild;
  for (const open of [true, false, true]) {
    app.classList.toggle('menu-open', open);
    sidebar.hidden = !open;
    expect(counter.closest('[hidden]')).toBeNull();
    expect(getComputedStyle(counter).display).toBe('inline-flex');
    expect(getComputedStyle(counter).flexShrink).toBe('0');
    expect(getComputedStyle(counter).height).toBe(name === 'main' ? '16px' : '28px');
    expect(counter.textContent).toBe('2'); expect(counter.firstElementChild).toBe(glyph);
  }
  updateRunningCount(counter, 0, 'Running: 0'); expect(counter.hidden).toBe(true);
});

async function renderConversation() {
  vi.resetModules(); vi.useFakeTimers(); host.getState.mockReturnValue(undefined);
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) listeners.push({ target, type, listener, options }); add(type, listener, options);
    });
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) { return selector === ':popover-open' ? false : matches.call(this, selector); });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  document.body.innerHTML = '<div id="app"></div>'; await import('../web/ui/main');
  const project: Project = { id: 'header', uri: 'studio-assistant:workspace', folderPath: '/assistant', name: 'Project Assistant', projectType: 'bot', fields: [], entrypoints: [],
    entryId: 'main', aggregateName: 'Test', defaultEntry: 'main', entryRoot: '/assistant', databases: [], entries: [],
    assistant: { workdir: '/workspace', roots: [{ uri: 'file:///workspace', folderPath: '/workspace', name: 'steamharness-lol' }] } };
  const sessions: ConversationSession[] = [
    { id: 'active', title: 'Find game information', activeRunId: 'run-one', messages: [{ id: 'input', role: 'user', content: 'Find information' }] },
    { id: 'other', title: 'Other conversation', activeRunId: 'run-two', messages: [] },
  ];
  const emit = () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', project, sessions, activeId: 'active', running: !!sessions[0].activeRunId } }));
    for (const frame of frames.splice(0)) frame(0);
  };
  emit();
  return { project, sessions, emit };
}

it('groups the assistant name and running count beside the workspace while preserving the conversation title', async () => {
  const { project, sessions, emit } = await renderConversation();
  const identity = document.querySelector<HTMLElement>('#project-identity')!, counter = document.querySelector<HTMLElement>('#running-count')!;
  expect(identity.textContent).toBe('steamharness-lol(Project Assistant)');
  expect(identity.title).toBe(identity.textContent); expect(identity.hidden).toBe(false);
  expect(identity.nextElementSibling).toBe(counter); expect(counter.textContent).toBe('2');
  expect(document.querySelector('#conversation-title')!.textContent).toBe('Find game information');
  expect(document.querySelector('.toolbar-actions')!.contains(counter)).toBe(false);
  const glyph = counter.firstElementChild;
  project.assistant!.roots[0].name = 'Another workspace'; sessions[1].activeRunId = undefined; emit();
  expect(identity.textContent).toBe('Another workspace(Project Assistant)');
  expect(counter.textContent).toBe('1'); expect(counter.firstElementChild).toBe(glyph);
  sessions[0].activeRunId = undefined; emit(); expect(counter.hidden).toBe(true);
  sessions[0].messages = []; emit();
  expect(identity.hidden).toBe(false); expect(identity.textContent).toBe('Another workspace(Project Assistant)');
  project.assistant = undefined; project.name = 'Regular Bot'; emit();
  expect(identity.hidden).toBe(true); expect(document.querySelector('#conversation-title')!.textContent).toBe('Regular Bot');
  sessions[0].messages = [{ id: 'new', role: 'user', content: 'New message' }]; emit();
  expect(identity.hidden).toBe(false); expect(identity.textContent).toBe('Regular Bot');
  expect(document.querySelector<HTMLElement>('#assistant-folder')!.hidden).toBe(true);
});

it('orders conversation toolbar actions as new conversation, project windows, then remaining controls', async () => {
  await renderConversation();
  const actions = document.querySelector('.toolbar-actions')!;
  expect([...actions.children].map(element => element.id || element.className)).toEqual(['new', 'aggregate-navigation', 'server-stop', 'project-info']);
  expect(actions.querySelector('.aggregate-navigation > .entry-windows-button')).not.toBeNull();
});
