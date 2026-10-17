import { t } from '../localization';
import { AccountPanel } from './account';
import { BrowserConnection, ConnectionError } from './connection';
import { requestAction } from './action-dialog';
import { TraceBridge } from './trace-bridge';
import { ClipboardBridge } from './clipboard-bridge';
import { editText, pasteHostClipboard, selectedText, textEditShortcut, type TextEditCommand } from './edit-commands';

type Message = Record<string, any>;
interface Host { postMessage(message: Message): void | Promise<void | boolean>; getState(): unknown; setState(state: unknown): void }
interface EditTarget { element: HTMLElement; selection?: { start: number; end: number; direction: 'forward' | 'backward' | 'none'; value: string } }

export function acquireWorkflowHost(options: { live?: boolean; connectionBanner?: boolean } = {}): Host {
  let contextInput: EditTarget | undefined, lastInput: EditTarget | undefined;
  let contextText: string | undefined;
  addEventListener('keydown', event => {
    const command = textEditShortcut(event);
    if (command && editText(command, event.target instanceof Element ? event.target : document.activeElement)) {
      contextInput = undefined; contextText = undefined;
      event.preventDefault(); event.stopPropagation();
    }
  }, { capture: true });
  const embedded = (globalThis as unknown as { acquireVsCodeApi?: () => Host }).acquireVsCodeApi;
  if (embedded) { return embedded(); }
  if (document.documentElement.dataset.theme === 'auto') {
    const dark = matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => { document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light'; };
    applyTheme(); dark.addEventListener('change', applyTheme);
  }
  const storageKey = `workflow-web:${document.querySelector<HTMLMetaElement>('meta[name=workflow-project]')?.content ?? location.pathname}`;
  const emit = (message: Message) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  const trace = new TraceBridge(message => { if (window.parent !== window) { window.parent.postMessage(message, '*'); } });
  let resourceHost = false, editHost = false, nativePasteHost = false;
  const captureInput = (input: HTMLElement): EditTarget => {
    const field = input as HTMLInputElement | HTMLTextAreaElement;
    return { element: input, selection: typeof field.selectionStart === 'number' && typeof field.selectionEnd === 'number'
      ? { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection ?? 'none', value: field.value } : undefined };
  };
  const rememberInput = (event?: Event) => {
    const input = event?.target instanceof HTMLElement && event.target.matches('textarea, input, [contenteditable=true]') ? event.target : document.activeElement;
    if (input instanceof HTMLElement && input.matches('textarea, input, [contenteditable=true]')) { lastInput = captureInput(input); }
  };
  const clipboard = new ClipboardBridge(message => window.parent.postMessage(message, '*'),
    text => navigator.clipboard.writeText(text), window.parent !== window && document.body.dataset.accountHost === 'true');
  const copyText = async (text: string): Promise<boolean> => {
    try { await clipboard.writeText(text); return true; }
    catch (error) { emit({ type: 'error', message: (error as Error).message }); return false; }
  };
  const copySelection = () => {
    let text = contextText ?? selectedText();
    const context = contextInput ?? (!text && document.activeElement === document.body ? lastInput : undefined);
    contextText = undefined; contextInput = undefined;
    if (context?.selection) {
      const input = context.element as HTMLInputElement | HTMLTextAreaElement;
      if (!input.isConnected || input.value !== context.selection.value || input.matches('input[type=password]')) { return; }
      text = input.value.slice(context.selection.start, context.selection.end);
    }
    if (text) { void copyText(text); }
  };
  const cutSelection = async () => {
    const input = document.activeElement;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || input.disabled || input.readOnly) { return; }
    const text = selectedText(input);
    if (!text) { return; }
    const value = input.value, start = input.selectionStart, end = input.selectionEnd;
    if (await copyText(text) && input.isConnected && document.activeElement === input && input.value === value
      && input.selectionStart === start && input.selectionEnd === end) { document.execCommand('delete'); }
  };
  addEventListener('pagehide', () => clipboard.dispose());
  addEventListener('keydown', event => {
    if (!editHost || event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) { return; }
    if (event.key.toLowerCase() === 'c') {
      const text = selectedText(event.target instanceof Element ? event.target : document.activeElement);
      if (text) { event.preventDefault(); event.stopPropagation(); contextText = undefined; contextInput = undefined; void copyText(text); }
      return;
    }
    if (event.key.toLowerCase() === 'x' && document.activeElement?.matches('textarea:not([readonly]), input:not([readonly])') && selectedText()) {
      event.preventDefault(); event.stopPropagation(); contextText = undefined; contextInput = undefined; void cutSelection(); return;
    }
    if (!nativePasteHost || event.key.toLowerCase() !== 'v'
      || !(event.target instanceof Element) || !event.target.closest('textarea, input, [contenteditable=true]')) { return; }
    event.preventDefault(); event.stopPropagation();
    contextInput = undefined; contextText = undefined;
    rememberInput(event);
    window.parent.postMessage({ type: 'workflow-edit', version: 1, command: 'paste' }, '*');
  }, { capture: true });
  addEventListener('contextmenu', event => {
    if (!editHost || event.defaultPrevented || !(event.target instanceof Element)) { return; }
    const input = event.target.closest<HTMLElement>('textarea, input, [contenteditable=true]');
    event.preventDefault();
    if (input) { input.focus({ preventScroll: true }); contextInput = lastInput = captureInput(input); }
    else { contextInput = lastInput = undefined; }
    contextText = selectedText(input ?? event.target);
    window.parent.postMessage({ type: 'workflow-contextmenu', version: 1, x: event.clientX, y: event.clientY }, '*');
  });
  addEventListener('copy', event => {
    if (!editHost || event.defaultPrevented || !selectedText()) { return; }
    event.preventDefault(); copySelection();
  });
  addEventListener('cut', event => {
    if (!editHost || event.defaultPrevented || !document.activeElement?.matches('textarea:not([readonly]), input:not([readonly])') || !selectedText()) { return; }
    event.preventDefault(); contextText = undefined; contextInput = undefined; void cutSelection();
  });
  addEventListener('focusin', event => {
    if (event.target instanceof Element && event.target !== contextInput?.element && event.target.matches('textarea, input, [contenteditable=true]')) { contextInput = undefined; contextText = undefined; }
    rememberInput(event);
  });
  addEventListener('input', rememberInput);
  addEventListener('selectionchange', rememberInput, true);
  addEventListener('pointerdown', event => {
    if (event.button !== 2) { contextInput = undefined; contextText = undefined; }
    if (event.target instanceof Element && !event.target.closest('textarea, input, [contenteditable=true]')) { lastInput = undefined; }
  });
  const connection = new BrowserConnection(message => {
    if (message.type === 'state' && message.account) { accountPanel.update(message.account); }
    trace.receive(message);
    emit(message);
  }, options.live, options.connectionBanner);
  const request = async (message: Message) => {
    for (const entry of await connection.request(message)) { handleReply(entry); }
  };
  addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent || event.data?.type !== 'workflow-host') { return; }
    if (event.data.theme === 'dark' || event.data.theme === 'light') { document.documentElement.dataset.theme = event.data.theme; }
    if (event.data.traceVersion !== undefined) { trace.enable(event.data.traceVersion); }
    if (event.data.clipboardVersion !== undefined) {
      clipboard.enable(event.data.clipboardVersion);
      editHost = event.data.clipboardVersion === 1;
      if (editHost) { window.parent.postMessage({ type: 'workflow-edit', version: 1 }, '*'); }
    }
    if (event.data.resourceVersion === 1) { resourceHost = true; }
    if (event.data.nativePasteVersion !== undefined) { nativePasteHost = event.data.nativePasteVersion === 1; }
    if (event.data.resourceError) { emit(event.data.resourceError); }
    if ((event.data.restoreFocus === true || document.activeElement === document.body)
      && ['paste', 'cut', 'selectAll', 'undo', 'redo'].includes(event.data.editCommand)) {
      const context = contextInput ?? lastInput; contextInput = undefined;
      if (context) {
        const input = context.element as HTMLInputElement | HTMLTextAreaElement;
        if (!input.isConnected || context.selection && input.value !== context.selection.value) { return; }
        input.focus({ preventScroll: true });
        if (context.selection) { input.setSelectionRange(context.selection.start, context.selection.end, context.selection.direction); }
      }
    }
    if (event.data.editCommand === 'copy') { copySelection(); }
    else if (event.data.editCommand === 'cut') {
      contextText = undefined; contextInput = undefined;
      if (document.activeElement?.matches('textarea, input')) { void cutSelection(); }
      else { document.execCommand('cut'); }
    }
    else if (event.data.editCommand === 'paste' && event.data.clipboardData) { pasteHostClipboard(event.data.clipboardData); }
    else if (['selectAll', 'undo', 'redo'].includes(event.data.editCommand)) {
      contextText = undefined; contextInput = undefined; editText(event.data.editCommand as TextEditCommand);
    }
    else if (event.data.editCommand === 'paste') { document.execCommand('paste'); }
    clipboard.receive(event.data.clipboard);
    const traceCommand = trace.command(event.data.traceCommand);
    if (traceCommand?.type === 'trace-navigate') { emit(traceCommand); trace.result(event.data.traceCommand.requestId); }
    else if (traceCommand) {
      const requestId = event.data.traceCommand.requestId;
      void request(traceCommand).then(() => { if (requestId) trace.result(requestId); }).catch(error => {
        if (requestId) trace.result(requestId, error.message);
        else trace.receive({ type: 'trace-run', runId: traceCommand.id, error: error.message });
      });
    }
    if (event.data.command === 'new' || event.data.command === 'history') { emit({ type: 'assistant-command', command: event.data.command }); }
  });
  const handleReply = (reply: Message) => {
    trace.receive(reply);
    if (reply.type === 'trace-run') {
      if (!trace.active) { handleReply({ type: 'preview', title: t("Trace"), content: reply.run }); }
      return;
    }
    if (reply.type === 'resource-preview') {
      reply.url = connection.fileUrl(reply.url);
      if (reply.action === 'inline') { emit(reply); }
      else { window.open(reply.url, '_blank', 'noopener'); }
    } else if (reply.type === 'download') {
      const url = URL.createObjectURL(new Blob([reply.content], { type: reply.mimeType ?? 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = reply.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } else if (reply.type === 'preview') {
      const dialog = document.createElement('dialog'); dialog.className = 'conversation-dialog';
      const header = document.createElement('header'); const title = document.createElement('h2'); title.textContent = reply.title;
      const close = document.createElement('button'); close.className = 'icon-button'; close.title = t("Close"); close.setAttribute('aria-label', close.title); close.innerHTML = '<span class="codicon codicon-close"></span>'; close.onclick = () => dialog.close(); header.append(title, close);
      const body = document.createElement('pre'); body.className = 'dialog-body web-preview'; body.textContent = typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content, null, 2);
      dialog.append(header, body); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal();
    } else { emit(reply); }
  };
  const chooseFiles = (message: Message) => {
    const picker = document.createElement('input'); picker.type = 'file'; picker.multiple = true;
    if (Array.isArray(message.accept)) { picker.accept = message.accept.join(','); }
    picker.addEventListener('change', async () => {
      try {
        const files = await Promise.all(Array.from(picker.files ?? []).map(file => new Promise<Message>((resolve, reject) => {
          if (file.size > 50 * 1024 * 1024) { reject(new Error('Attachment exceeds 50 MiB.')); return; }
          const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, mimeType: file.type, data: String(reader.result).split(',')[1] }); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
        })));
        await request({ ...message, type: 'upload', files });
      } catch (error) { emit({ type: 'error', requestType: 'attach', sessionId: message.sessionId, message: String((error as Error).message) }); }
    });
    picker.addEventListener('cancel', () => emit({ type: 'attachment-cancelled', sessionId: message.sessionId }));
    picker.click();
  };
  let accountPanel: AccountPanel;
  queueMicrotask(() => {
    const openHostAccount = document.body.dataset.accountHost === 'true'
      ? () => window.parent.postMessage({ type: 'workflow-account', version: 1 }, '*') : undefined;
    accountPanel = new AccountPanel(document.querySelector('#project-menu')!, request, openHostAccount);
  });
  return {
    postMessage: async (message) => {
      if (message.type === 'ready') { return; }
      if (message.type === 'trace-active') { trace.select(message.sessionId); return; }
      if (message.type === 'reconnect') { await connection.reconnect(); return; }
      if (message.type === 'resource' && message.action !== 'inline' && resourceHost) {
        window.parent.postMessage({ type: 'workflow-resource', version: 1, request: message }, '*'); return;
      }
      if (message.type === 'resource' && message.action !== 'inline') {
        const popup = window.open('', '_blank');
        try {
          const reply = (await connection.request(message)).find(reply => reply.type === 'resource-preview');
          if (reply && popup) { popup.opener = null; popup.location.href = connection.fileUrl(reply.url); }
          else { popup?.close(); if (reply) { emit({ type: 'error', message: t('Allow popups to open this resource in a new window.') }); } }
        } catch (error) { popup?.close(); emit({ type: 'error', requestId: message.requestId, message: (error as Error).message }); }
        return;
      }
      if (message.type === 'trace') {
        if (trace.open(message)) { return; }
        if (message.runId && !message.messageId) { message = { type: 'workflow-trace', id: message.runId }; }
      }
      if (message.type === 'copy') {
        return copyText(message.text);
      }
      if (message.type === 'attach') { chooseFiles(message); return; }
      if (message.type === 'session-action' && message.action === 'rename') {
        const title = await requestAction({ title: t("Rename conversation"), label: t("Conversation name"), value: message.currentTitle, confirm: t("Save") });
        if (title === undefined) { return; } message = { ...message, title };
      }
      if (message.type === 'session-action' && message.action === 'delete'
        && await requestAction({ title: t("Delete this conversation?"), confirm: t("Delete"), danger: true }) === undefined) { return; }
      if (message.type === 'open-file') { window.open(connection.fileUrl(`/api/file/${encodeURIComponent(message.id)}`), '_blank', 'noopener'); return; }
      if (message.type === 'login') { accountPanel.open(); return; }
      void request(message).catch(error => emit({ type: 'error', silent: error instanceof ConnectionError, connectionError: error instanceof ConnectionError, requestType: message.type, sessionId: message.sessionId, messageId: message.messageId, requestId: message.requestId, errorScope: message.errorScope, message: error.message }));
    },
    getState: () => { try { return JSON.parse(localStorage.getItem(storageKey) ?? 'null'); } catch { return undefined; } },
    setState: (state) => { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {} },
  };
}
