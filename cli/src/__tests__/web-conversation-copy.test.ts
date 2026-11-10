// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { conversationViewHtml } from '../web/conversation-view';

it('confirms embedded copies through its pinned parent and never uses the sandbox clipboard', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conversation-copy-'));
  await mkdir(path.join(directory, 'codicons'));
  await Promise.all(['workflow-ui.js', 'workflow-ui.css', 'theme.css', 'codicons/codicon.css', 'codicons/codicon.ttf'].map(file => writeFile(path.join(directory, file), '')));
  const html = await conversationViewHtml(directory, 'copy-view', 'conversation', 'zh-CN');
  const container = document.createElement('div'); container.innerHTML = html;
  const listeners = new Map<string, Set<(event: any) => void>>(), posted: any[] = [];
  const parent = { postMessage: (message: any) => posted.push(message) }, holder: any = {};
  const add = (type: string, fn: (event: any) => void) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); };
  const emit = (event: any) => { for (const fn of [...listeners.get(event.type) ?? []]) fn(event); };
  const native = { document, setTimeout, clearTimeout, getSelection: () => window.getSelection(), addEventListener: add,
    removeEventListener: (type: string, fn: (event: any) => void) => listeners.get(type)?.delete(fn) };
  const forbidden = vi.fn(() => { throw new Error('Sandbox clipboard fallback must not run'); });
  const oldExec = document.execCommand; document.execCommand = forbidden;
  document.body.innerHTML = '<div id="app"></div>';
  try {
    new Function('window', 'document', 'globalThis', 'parent', 'addEventListener', 'dispatchEvent', 'MessageEvent', container.querySelector('script')!.textContent!)(
      native, document, holder, parent, add, emit, MessageEvent);
    const api = holder.acquireVsCodeApi();
    const send = (source: any, message: object, viewId = 'copy-view') => emit({ type: 'message', source,
      data: { type: 'steamharness:conversation-message', viewId, message } });
    let done = false;
    const copy = api.postMessage({ type: 'copy', text: '正文\n引用' }).then((ok: boolean) => { done = ok; return ok; });
    const request = posted.at(-1); expect(request.message).toMatchObject({ type: 'copy', text: '正文\n引用', requestId: expect.any(String) });
    send({}, { type: 'conversation-copy-result', requestId: request.message.requestId, ok: true });
    send(parent, { type: 'conversation-copy-result', requestId: request.message.requestId, ok: true }, 'other-view');
    await Promise.resolve(); expect(done).toBe(false);
    send(parent, { type: 'conversation-copy-result', requestId: request.message.requestId, ok: true });
    expect(await copy).toBe(true); expect(forbidden).not.toHaveBeenCalled();
    const text = document.createElement('blockquote'); text.textContent = '引用里的内容'; document.body.append(text);
    const range = document.createRange(); range.selectNodeContents(text); window.getSelection()!.addRange(range);
    send(parent, { type: 'conversation-edit-host', enabled: true });
    send(parent, { type: 'conversation-edit', command: 'copy' });
    await vi.waitFor(() => expect(posted.at(-1).message).toMatchObject({ type: 'copy', text: '引用里的内容' }));
    const pending = api.postMessage({ type: 'copy', text: '关闭前的复制' });
    emit({ type: 'pagehide' }); expect(await pending).toBe(false);
  } finally { emit({ type: 'pagehide' }); document.execCommand = oldExec; document.body.replaceChildren(); window.getSelection()?.removeAllRanges(); await rm(directory, { recursive: true, force: true }); }
});
