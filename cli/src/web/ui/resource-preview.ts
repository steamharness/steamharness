import { t } from '../localization';
import './style.css';
import './resource-preview.css';
import { acquireProjectHost } from './host';
import { iconButton, markdownHtml, updateIcon } from './ui';
import type { ResourcePreviewData } from '../resource-preview';
import type { ResourceCardReference } from '../resource-cards';
import { createKanbanMethodSession, KANBAN_PREVIEW_READY_MESSAGE, KANBAN_BRIDGE_REQUEST_MESSAGE, KANBAN_BRIDGE_RESPONSE_MESSAGE,
  KANBAN_BRIDGE_MAX_PENDING_REQUESTS, parseKanbanBridgeCall, createKanbanBridgeError } from '@steamharness/kanban-project';

type Message = Record<string, any>;
const app = document.querySelector<HTMLElement>('#app')!;
app.className = 'resource-preview-app';
app.innerHTML = '<header class="resource-preview-toolbar"><div><h1></h1><span></span></div></header><main><div class="resource-preview-status" role="status"></div><div class="resource-preview-content"></div></main><aside id="project-menu" hidden></aside>';
const host = acquireProjectHost({ live: false }), status = app.querySelector<HTMLElement>('.resource-preview-status')!, content = app.querySelector<HTMLElement>('.resource-preview-content')!;
let id = location.pathname.split('/').at(-1)!, connected = false, data: ResourcePreviewData | undefined, frame: HTMLIFrameElement | undefined;
let reference: ResourceCardReference | undefined, selection: Message | undefined;
try { reference = JSON.parse(new URL(location.href).searchParams.get('resourceRef') ?? 'null') ?? undefined; } catch { /* Older preview URLs have no saved-card reference. */ }
let readyTimer: ReturnType<typeof setTimeout> | undefined, pendingBridge = 0, epoch = 0, authRevision: number | undefined, resourceRevision: number | undefined;
const pending = new Map<string, { resolve(message: Message): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let methodSession: ReturnType<typeof createKanbanMethodSession> | undefined, methodTimer: ReturnType<typeof setTimeout> | undefined;
const methodCalls = new Map<string, AbortController>();
function closeMethods(): void {
  if (methodSession && data?.kanban && connected) host.postMessage({ type: 'resource-method-close', id, nonce: data.kanban.nonce });
  clearTimeout(methodTimer); methodSession?.close(); methodSession = undefined;
  for (const call of methodCalls.values()) call.abort();
  methodCalls.clear();
}
async function pollMethods(session: NonNullable<typeof methodSession>): Promise<void> {
  if (session !== methodSession || !data?.kanban) return;
  if (!connected) { methodTimer = setTimeout(() => void pollMethods(session), 1_000); return; }
  const previewId = id, nonce = data.kanban.nonce;
  try {
    const reply = await request({ type: 'resource-method-state', nonce, instanceId: session.instanceId, ...session.getState() });
    if (session !== methodSession) return;
    for (const message of reply.messages ?? []) {
      if (message.type === 'kanban-method-cancel') { methodCalls.get(message.requestId)?.abort(); continue; }
      if (message.type !== 'kanban-method-invoke' || message.instanceId !== session.instanceId) continue;
      const abort = new AbortController(); methodCalls.set(message.requestId, abort);
      void session.invoke({ instanceId: message.instanceId, configurationId: message.configurationId, method: message.method, args: message.args }, abort.signal)
        .then(value => { if (session === methodSession) host.postMessage({ type: 'resource-method-reply', id: previewId, nonce, requestId: message.requestId, instanceId: message.instanceId, ok: true, value }); })
        .catch(error => { if (session === methodSession) host.postMessage({ type: 'resource-method-reply', id: previewId, nonce, requestId: message.requestId, instanceId: message.instanceId, ok: false, error: error.message }); })
        .finally(() => methodCalls.delete(message.requestId));
    }
  } catch { /* Connection and resource revisions own recovery; do not replace the preview. */ }
  finally { if (session === methodSession) methodTimer = setTimeout(() => void pollMethods(session), 1_000); }
}
function request(message: Message): Promise<Message> {
  if (!connected) { return Promise.reject(new Error(t('Connection interrupted.'))); }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(t('The request timed out. Check the current status.'))); },
      message.type === 'resource-bridge' && message.call?.operation?.startsWith('files.') ? 125_000 : 30_000);
    pending.set(requestId, { resolve, reject, timer }); host.postMessage({ ...message, id, requestId });
  });
}
function fail(error: unknown): void { status.hidden = false; status.textContent = error instanceof Error ? error.message : String(error); status.setAttribute('role', 'alert'); }
function inject(): void {
  if (!frame || !data?.kanban) { return; }
  const nonce = data.kanban.nonce;
  frame.contentWindow?.postMessage({ type: 'steamharness:kanban-theme', nonce, theme: document.documentElement.dataset.theme }, '*');
  frame.contentWindow?.postMessage({ type: 'steamharness:kanban-configuration', nonce, configuration: data.kanban.configuration }, '*');
  frame.contentWindow?.postMessage({ type: 'steamharness:kanban-presentation', nonce, presentation: { mode: new URL(location.href).searchParams.get('resourcePresentation') === 'card' ? 'card' : 'fullscreen' } }, '*');
  frame.contentWindow?.postMessage({ type: 'steamharness:kanban-keyboard-host', nonce, version: 1, enabled: host.keyboard?.enabled === true }, '*');
}
addEventListener('workflow-keyboard-host-change', inject);
function render(next: ResourcePreviewData): void {
  data = next; frame = undefined; clearTimeout(readyTimer); content.replaceChildren(); status.hidden = true;
  selection = ['kv', 'knowledge'].includes(next.card.kind) ? next.card.target : undefined;
  app.querySelector('header a')?.remove();
  app.dataset.format = next.format;
  app.querySelector('h1')!.textContent = next.card.title;
  app.querySelector('.resource-preview-toolbar span')!.textContent = [next.card.target.source === 'server' ? t('Server') : t('Local'), next.project?.name].filter(Boolean).join(' / ');
  if (next.format === 'image') {
    const image = document.createElement('img'); image.alt = next.card.title;
    status.hidden = false; status.textContent = t('Loading...');
    image.onload = () => { if (image.isConnected) { status.hidden = true; } };
    image.onerror = () => { if (image.isConnected) { fail(new Error(t('Unable to load this preview. Retry or open it separately.'))); } };
    image.src = String(next.content); content.append(image); return;
  }
  if (next.format === 'kanban' || next.format === 'browser') {
    frame = document.createElement('iframe'); frame.title = next.card.title; frame.sandbox.add('allow-scripts');
    frame.src = next.kanban?.url ?? String(next.content); content.append(frame);
    if (next.format === 'kanban') {
      methodSession = createKanbanMethodSession({ nonce: next.kanban!.nonce, getConfiguration: () => next.kanban!.configuration,
        getPresentation: () => ({ mode: new URL(location.href).searchParams.get('resourcePresentation') === 'card' ? 'card' : 'fullscreen' }),
        postMessage: message => frame?.contentWindow?.postMessage(message, '*') });
      methodTimer = setTimeout(() => { if (methodSession) void pollMethods(methodSession); }, 0);
      status.hidden = false; status.textContent = t('Loading Kanban');
      readyTimer = setTimeout(() => fail(new Error(t('Unable to load this preview. Retry or open it separately.'))), 20_000);
    } else {
      const link = document.createElement('a'); link.href = String(next.content); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = t('Open in browser'); app.querySelector('header')!.append(link);
    }
    return;
  }
  const value = next.content as any;
  const items = Array.isArray(value) ? value : value?.items ?? value?.documents;
  if (Array.isArray(items) && ['kv', 'knowledge'].includes(next.card.kind)) {
    const list = document.createElement('div'); list.className = 'resource-preview-list';
    for (const item of items) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = item.title ?? item.key ?? item.id; button.onclick = () => void load({ documentId: item.documentId ?? item.id, key: item.key, scope: item.scope, conversationId: item.conversationId }); list.append(button);
    }
    if (!items.length) { list.textContent = t('No resources'); } content.append(list);
  } else if (next.format === 'markdown') { const article = document.createElement('article'); article.className = 'markdown'; article.innerHTML = markdownHtml(typeof value === 'string' ? value : value.markdown); content.append(article); }
  else { const pre = document.createElement('pre'); pre.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); content.append(pre); }
}
async function load(nextSelection?: Message): Promise<void> {
  if (nextSelection) { selection = nextSelection; }
  const generation = ++epoch; status.hidden = false; status.textContent = t('Loading...'); status.setAttribute('role', 'status');
  closeMethods(); clearTimeout(readyTimer); frame = undefined; content.replaceChildren(); refresh.disabled = true; updateIcon(refresh.querySelector('.codicon')!, 'loading');
  try { const reply = await request({ type: nextSelection ? 'resource-select' : data ? 'resource-refresh' : 'resource-data', reference, selection }); if (generation === epoch) { id = reply.id ?? id; render(reply.data); } }
  catch (error) { if (generation === epoch) { content.replaceChildren(); fail(error); } }
  finally { if (generation === epoch) { refresh.disabled = false; updateIcon(refresh.querySelector('.codicon')!, 'refresh'); } }
}
const refresh = iconButton('refresh', t('Refresh'), () => void load());
app.querySelector('header')!.append(refresh);
addEventListener('message', event => {
  const message: Message = event.data;
  if (event.source === frame?.contentWindow) {
    if (data?.format !== 'kanban' || !data.kanban || message?.nonce !== data.kanban.nonce) { return; }
    methodSession?.receive(message);
    if (message.type === 'steamharness:kanban-keyboard' && message.version === 1) {
      if (document.activeElement === frame) host.keyboard?.forward(message.event);
      return;
    }
    if (message.type === KANBAN_PREVIEW_READY_MESSAGE) { clearTimeout(readyTimer); status.hidden = true; inject(); return; }
    if (message.type !== KANBAN_BRIDGE_REQUEST_MESSAGE) { return; }
    const target = frame.contentWindow, nonce = data.kanban.nonce, current = frame;
    const respond = (reply: Message) => { if (frame === current) { target?.postMessage({ type: KANBAN_BRIDGE_RESPONSE_MESSAGE, requestId: message.requestId, nonce, ...reply }, '*'); } };
    if (pendingBridge >= KANBAN_BRIDGE_MAX_PENDING_REQUESTS) { respond({ ok: false, error: { code: 'KANBAN_BRIDGE_BUSY', message: t('A data operation is in progress.') } }); return; }
    let call;
    try { call = parseKanbanBridgeCall({ requestId: message.requestId, operation: message.operation, input: message.input }); }
    catch (error) { respond({ ok: false, error: createKanbanBridgeError(error) }); return; }
    pendingBridge++;
    void request({ type: 'resource-bridge', call }).then(reply => respond({ ok: true, value: reply.value }))
      .catch(error => respond({ ok: false, error: createKanbanBridgeError(error) })).finally(() => pendingBridge--); return;
  }
  if (event.source !== null || !message) { return; }
  const waiting = pending.get(message.requestId);
  if (waiting) { pending.delete(message.requestId); clearTimeout(waiting.timer); message.type === 'error' ? waiting.reject(new Error(message.message)) : waiting.resolve(message); }
  if (message.type === 'connection') { connected = message.status === 'connected'; if (connected && !data) { void load(); } }
  if (message.type === 'state') {
    if (authRevision !== undefined && authRevision !== message.authenticationRevision
      || resourceRevision !== undefined && resourceRevision !== message.resourceRevision) {
      closeMethods(); clearTimeout(readyTimer); data = undefined; frame = undefined; content.replaceChildren(); void load();
    }
    authRevision = message.authenticationRevision;
    resourceRevision = message.resourceRevision;
  }
});
new MutationObserver(inject).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
addEventListener('pagehide', () => { epoch++; closeMethods(); clearTimeout(readyTimer); for (const waiting of pending.values()) { clearTimeout(waiting.timer); } pending.clear(); });
