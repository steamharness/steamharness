import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSessionSnapshot } from 'steamharness/agent';
import type { ConversationSession } from '../web/workflow-types';
import { conversationHistoryStatus, updateConversationRunningCount, updateHistoryStatus, workflowHistoryStatus } from '../web/ui/history-status';

class Element {
  hidden = false; className = ''; textContent = ''; title = ''; ariaLabel = '';
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Element[] = [];
  get classList() { return { contains: (value: string) => this.className.split(' ').includes(value) }; }
  get childNodes() { return this.children; }
  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children.at(-1)!; }
  set innerHTML(value: string) {
    const glyph = new Element(); glyph.className = value.match(/class="([^"]+)"/)![1]; this.replaceChildren(glyph);
  }
  append(...elements: Element[]) { this.children.push(...elements); }
  replaceChildren(...elements: Element[]) { this.children = elements; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}

afterEach(() => vi.unstubAllGlobals());
const element = () => new Element() as unknown as HTMLElement;
const session = (id: string, patch: Partial<ConversationSession> = {}): ConversationSession => ({ id, title: id, messages: [], ...patch });
function agent(): AgentSessionSnapshot {
  return { version: 1, ownerId: 'owner', revision: 1, conversationId: 1, foreground: false, backgroundCount: 0, epoch: 0,
    configuration: { version: 0, provider: 'fixture', model: 'fixture', effort: 'off' }, prompt: { hash: 'digest', version: 1 }, plan: { version: 0, items: [] },
    tasks: [], history: [], receipts: [], records: [], usage: [], conversations: [], contexts: [], turns: [] };
}

it('shows conversation status as a labeled icon and keeps its spinning glyph through streamed changes', () => {
  const root = element(), current = session('running', { activeRunId: 'run' });
  updateHistoryStatus(root, conversationHistoryStatus(current));
  const glyph = root.firstElementChild!;
  expect(root.textContent).toBe(''); expect(root.title).toBe('Running'); expect(root.ariaLabel).toBe('Running');
  expect(glyph.className).toContain('codicon-loading');
  for (let index = 0; index < 4; index++) {
    updateHistoryStatus(root, conversationHistoryStatus({ ...current, title: `Title ${index}`, updatedAt: index }));
    expect(root.firstElementChild).toBe(glyph);
  }
  current.messages.push({ role: 'assistant', content: '', pendingInput: { requestId: 'approval', nodeName: 'approval', title: 'Review', params: [] } });
  updateHistoryStatus(root, conversationHistoryStatus(current));
  expect(root.firstElementChild).toBe(glyph); expect(glyph.className).toContain('codicon-question');
  expect(root.ariaLabel).toBe('Pending approval');
  updateHistoryStatus(root, conversationHistoryStatus(session('idle'))); expect(root.hidden).toBe(true);
  const css = readFileSync(new URL('../web/ui/style.css', import.meta.url), 'utf8');
  const glyphRule = css.match(/\.running-count > \.codicon, \.history-status > \.codicon\s*\{([^}]+)\}/)![1];
  expect(glyphRule).toContain('width: 16px'); expect(glyphRule).toContain('height: 16px');
  expect(css).toMatch(/\.history-status > \.codicon-loading\s*\{ animation: spin 1\.2s linear infinite;/);
});

it.each(['running', 'waiting_for_input', 'success', 'failed', 'aborted', 'timed_out', 'interrupted'])(
  'keeps %s workflow status accessible without visible status text', status => {
    const root = element(); updateHistoryStatus(root, workflowHistoryStatus(status));
    expect(root.hidden).toBe(false); expect(root.textContent).toBe(''); expect(root.ariaLabel).toBeTruthy();
    expect(root.title).toBe(root.ariaLabel); expect(root.firstElementChild!.className).toContain('codicon-');
    expect(root.dataset.status).toBe(status);
  });

it('counts all running conversations while excluding idle durable owners and respecting child contexts', () => {
  vi.stubGlobal('document', { createElement: () => new Element() });
  const root = element(), snapshot = agent();
  snapshot.foreground = true;
  snapshot.contexts = [1, 2].map(conversationId => ({ conversationId, foreground: conversationId === 2, backgroundCount: 0, epoch: 0,
    configuration: snapshot.configuration, prompt: snapshot.prompt, plan: snapshot.plan }));
  const sessions = [session('regular', { activeRunId: 'regular-run' }), session('owner', { activeRunId: 'worker', agent: snapshot }),
    session('child', { agent: snapshot, agentConversationId: 2 }), ...Array.from({ length: 40 }, (_, index) => session(`idle-${index}`))];
  updateConversationRunningCount(root, sessions);
  const glyph = root.firstElementChild;
  expect(root.hidden).toBe(false); expect(root.lastElementChild!.textContent).toBe('2'); expect(root.ariaLabel).toBe('Running conversations: 2');
  expect(conversationHistoryStatus(sessions[1])).toBeUndefined();
  updateConversationRunningCount(root, sessions.slice(1));
  expect(root.lastElementChild!.textContent).toBe('1'); expect(root.firstElementChild).toBe(glyph);
  updateConversationRunningCount(root, [session('owner', { activeRunId: 'worker', agent: agent() })]);
  expect(root.hidden).toBe(true); expect(root.firstElementChild).toBe(glyph);
});

it('preserves approval, background-task and failure details in conversation icon tooltips', () => {
  const snapshot = agent(); snapshot.backgroundCount = 2;
  expect(conversationHistoryStatus(session('background', { agent: snapshot }))).toMatchObject({ icon: 'server-process', label: 'Background tasks: 2' });
  expect(conversationHistoryStatus(session('failed', { messages: [{ role: 'assistant', content: '', status: 'failed' }] }))).toMatchObject({ icon: 'error', label: 'Failed' });
});
