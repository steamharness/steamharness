import { t } from '../localization';
import './style.css';
import './kanban-style.css';
import { acquireProjectHost } from './host';
import { mountProjectConfigurations, projectConfigurationsButton } from './project-configurations';
import { requestAction } from './action-dialog';
import { ConversationTools } from './conversation-tools';
import { updateProjectAvatar } from './avatar';
import { iconHtml, iconButton } from './ui';
import { aiUsageButton, narrowMenuDismiss, projectInfoButton } from './toolbar';
import {
  createKanbanMethodSession, parseKanbanBridgeCall, createKanbanBridgeError,
  KANBAN_BRIDGE_MAX_PENDING_REQUESTS, KANBAN_PREVIEW_READY_MESSAGE, KANBAN_BRIDGE_REQUEST_MESSAGE, KANBAN_BRIDGE_RESPONSE_MESSAGE,
  type KanbanInjectedConfiguration, type KanbanPresentationMode,
} from '@steamharness/kanban-project';
import { projectParamValue, type Project, type ParamValues } from '../workflow-types';
import type { ProjectServerIssue } from '../project-server-state';
import { ProjectServerGuidance } from './project-server-guidance';

type Message = Record<string, any>;
interface KanbanState { revision: number; configurations: {id:string;name:string}[]; activeConfigurationId?: string; configuration: KanbanInjectedConfiguration; params: Project['fields']; preview: { url: string; nonce: string }; relatedProjectRevisions: { alias: string; revision: string }[]; missingRelatedProjectAliases: string[]; relatedProjectWarning: string; serverDataIssue?: ProjectServerIssue }
const app = document.querySelector<HTMLElement>('#app')!, host = acquireProjectHost();
app.classList.add('kanban-app');
app.innerHTML = `
<header class="toolbar"><div class="project-title"><h1 id="kanban-title">Kanban</h1></div><div class="toolbar-actions"><div id="preview-modes" class="kanban-modes" role="group" aria-label="${t("Preview size")}"></div><button id="dimensions" class="icon-button" title="${t("Resize preview")}" aria-label="${t("Resize preview")}" hidden>${iconHtml('settings')}</button><button id="refresh" class="icon-button" title="${t("Refresh Kanban")}" aria-label="${t("Refresh Kanban")}">${iconHtml('refresh')}</button>${projectConfigurationsButton()}${aiUsageButton()}<button id="methods" class="icon-button" title="${t("Page methods")}" aria-label="${t("Page methods")}">${iconHtml('wrench')}</button>${projectInfoButton()}</div></header>
<main><div id="error" class="error" hidden role="alert"></div><div id="related-warning" class="kanban-warning" hidden role="status"></div><section id="server-guidance" class="project-server-guidance" aria-labelledby="server-guidance-title" role="region" aria-live="polite" hidden></section><div id="preview-stage"><div id="preview-viewport"><iframe id="kanban-preview" title="Kanban" sandbox="allow-scripts"></iframe><button id="resize-preview" class="kanban-resize" title="${t("Resize preview")}" aria-label="${t("Resize preview")}" hidden>${iconHtml('arrow-both')}</button></div><div id="preview-status" class="kanban-status" role="status" data-error="false">${iconHtml('loading')}<span>${t("Loading Kanban")}</span><button id="retry-preview" class="icon-button" title="${t("Retry")}" aria-label="${t("Retry")}" hidden>${iconHtml('refresh')}</button></div><div id="preview-offline" hidden></div></div></main>
<dialog id="dimensions-dialog" class="conversation-dialog"><header><h2>${t("Preview size")}</h2><button id="close-dimensions" class="icon-button" title="${t("Close")}" aria-label="${t("Close")}">${iconHtml('close')}</button></header><form class="dialog-body"><label>${t("Width")}<input id="preview-width" type="number" min="160" max="4096" required></label><label>${t("Height")}<input id="preview-height" type="number" min="96" max="4096" required></label><div class="dimension-actions"><button id="reset-dimensions" type="button">${iconHtml('discard')}${t("Reset")}</button><button type="submit">${iconHtml('check')}${t("Apply")}</button></div></form></dialog>
<dialog id="methods-dialog" class="conversation-dialog"><header><h2>${t("Page methods")}</h2><button id="close-methods" class="icon-button" title="${t("Close")}" aria-label="${t("Close")}">${iconHtml('close')}</button></header><div class="dialog-body"><select id="method-name" aria-label="${t("Page methods")}"></select><p id="method-description"></p><pre id="method-schema"></pre><label class="method-input">${t("Parameters JSON")}<textarea id="method-args" rows="5">{}</textarea></label><button id="invoke-method" type="button">${iconHtml('play')}${t("Execute")}</button><pre id="method-result" role="status"></pre></div></dialog>`;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const frame = element<HTMLIFrameElement>('kanban-preview'), dialogs = new ConversationTools();
const pending = new Map<string, { resolve(value: Message): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
const narrow = matchMedia('(max-width: 820px)');
const saved = host.getState() as { menuOpen?: boolean; mode?: KanbanPresentationMode; sizes?: Record<string, { width: number; height: number }> } | undefined;
const defaults = { phone: { width: 390, height: 844 }, tablet: { width: 768, height: 1024 }, card: { width: 360, height: 200 } };
let sizes = { ...defaults, ...saved?.sizes }, mode: KanbanPresentationMode = saved?.mode ?? 'fullscreen';
if (!['fullscreen', 'phone', 'tablet', 'card'].includes(mode)) { mode = 'fullscreen'; }
let menuOpen = false, state: KanbanState | undefined, project: Project | undefined;
let connected = false, working = false, methodWorking = false, transitioning = false, dirty = false, editing = 0, signature = '', previewKey = '', authRevision = -1;
let values: ParamValues = {}, saveTimer: ReturnType<typeof setTimeout> | undefined, readyTimer: ReturnType<typeof setTimeout> | undefined, pendingBridge = 0;
let methodSession: ReturnType<typeof createKanbanMethodSession> | undefined;
const methodCalls = new Map<string, AbortController>();
const serverGuidance = new ProjectServerGuidance(element('server-guidance'), {
  create: () => { void host.postMessage({ type: 'open-project-create' }); },
  retry: () => { void refreshPreview(); },
});
mountProjectConfigurations(host);
function persist(): void { host.setState({ mode, sizes }); }
function menu(_open: boolean): void { app.classList.remove('menu-open'); layoutPreview(); }
function request(message: Message): Promise<Message> {
  if (!connected) { return Promise.reject(new Error(t("Connection interrupted."))); }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(t("The request timed out. Check the current status."))); }, message.call?.operation?.startsWith('files.') ? 120_000 : 20_000);
    pending.set(requestId, { resolve, reject, timer }); host.postMessage({ projectUri: project?.uri, ...message, requestId });
  });
}
function showError(error: unknown): void { element('error').textContent = (error as Error).message ?? String(error); element('error').hidden = false; }
function controls(): void {
  serverGuidance.update(state?.serverDataIssue, project?.id ?? '', { connected, working });
  for (const id of ['refresh']) { (element(id) as HTMLButtonElement).disabled = !connected || working; }
  element<HTMLButtonElement>('methods').disabled = !connected || !methodSession?.getState().ready;
  element<HTMLButtonElement>('invoke-method').disabled = !connected || methodWorking || !methodSession?.getState().methods.length;
  element('preview-offline').hidden = connected;
  app.dataset.connection = connected ? 'connected' : 'disconnected'; app.dataset.saving = String(working || dirty);
}
function update(next: KanbanState): void {
  if (state && next.revision < state.revision) { return; }
  const wasBlocked = !!state?.serverDataIssue;
  state = next;
  element('preview-stage').hidden = !!next.serverDataIssue;
  element('related-warning').textContent = next.relatedProjectWarning || (next.missingRelatedProjectAliases.length ? t("Related projects are unavailable: {0}", next.missingRelatedProjectAliases.join(', ')) : '');
  element('related-warning').hidden = !!next.serverDataIssue || !element('related-warning').textContent;
  if (next.serverDataIssue) { clearTimeout(readyTimer); element('preview-status').hidden = true; }
  else {
    if (wasBlocked) { previewKey = ''; }
    if (previewKey !== next.preview.url) { mountPreview(); } else { inject(); }
  }
  controls();
}
function inject(): void {
  if (!state) { return; }
  frame.style.colorScheme = document.documentElement.dataset.theme ?? 'normal';
  for (const message of [
    { type: 'steamharness:kanban-configuration', configuration: state.configuration },
    { type: 'steamharness:kanban-theme', theme: document.documentElement.dataset.theme },
    { type: 'steamharness:kanban-presentation', presentation: { mode } },
    ...state.relatedProjectRevisions.map(item => ({ type: 'steamharness:kanban-related-project-revision', ...item })),
  ]) { frame.contentWindow?.postMessage({ ...message, nonce: state.preview.nonce }, '*'); }
}
function publishMethods(): void { if (connected && state && methodSession) { host.postMessage({ type: 'kanban-method-state', nonce: state.preview.nonce, instanceId: methodSession.instanceId, ...methodSession.getState() }); } }
function mountPreview(): void {
  if (!state) { return; }
  clearTimeout(readyTimer); methodSession?.close(); pendingBridge = 0; previewKey = state.preview.url;
  methodSession = createKanbanMethodSession({ nonce: state.preview.nonce, getConfiguration: () => state?.configuration, getPresentation: () => ({ mode }), postMessage: message => frame.contentWindow?.postMessage(message, '*') });
  element('preview-status').hidden = false; element('preview-status').dataset.error = 'false'; element('preview-status').querySelector('span:nth-child(2)')!.textContent = t("Loading Kanban"); element('retry-preview').hidden = true;
  readyTimer = setTimeout(() => { element('preview-status').dataset.error = 'true'; element('preview-status').querySelector('span:nth-child(2)')!.textContent = t("Failed to load Kanban"); element('retry-preview').hidden = false; }, 10_000);
  frame.sandbox.add('allow-forms', 'allow-downloads'); frame.src = state.preview.url; frame.title = project?.name ?? 'Kanban'; layoutPreview();
}
frame.addEventListener('load', inject);
function layoutPreview(): void {
  const stage = element('preview-stage'), viewport = element('preview-viewport'); app.dataset.previewMode = mode;
  element('dimensions').hidden = mode === 'fullscreen'; element('resize-preview').hidden = mode === 'fullscreen';
  for (const button of Array.from(element('preview-modes').children)) { button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.mode === mode)); }
  if (mode === 'fullscreen') { viewport.style.cssText = ''; frame.style.width = '100%'; frame.style.height = '100%'; frame.style.transform = ''; }
  else {
    const size = sizes[mode], scale = Math.min(1, Math.max(0.1, (stage.clientWidth - 24) / size.width), Math.max(0.1, (stage.clientHeight - 24) / size.height));
    viewport.style.width = `${size.width * scale}px`; viewport.style.height = `${size.height * scale}px`;
    frame.style.width = `${size.width}px`; frame.style.height = `${size.height}px`; frame.style.transform = `scale(${scale})`;
  }
}
for (const [value, label, icon] of [['fullscreen', t("Full screen"), 'screen-full'], ['phone', t("Phone"), 'device-mobile'], ['tablet', t("Tablet"), 'device-desktop'], ['card', t("Card"), 'preview']]) {
  const button = iconButton(icon, label, () => { mode = value as KanbanPresentationMode; layoutPreview(); inject(); persist(); }); button.dataset.mode = value; element('preview-modes').append(button);
}
async function refreshPreview(): Promise<void> {
  if (!connected || working) return;
  working = true; controls();
  try { const result = await request({ type: 'kanban-refresh' }); element('error').hidden = true; update(result.kanban); }
  catch (error) { showError(error); }
  finally { working = false; controls(); }
}
element('refresh').onclick = element('retry-preview').onclick = () => { void refreshPreview(); };
element('dimensions').onclick = () => { if (mode === 'fullscreen') { return; } element<HTMLInputElement>('preview-width').value = String(sizes[mode].width); element<HTMLInputElement>('preview-height').value = String(sizes[mode].height); element<HTMLDialogElement>('dimensions-dialog').showModal(); };
element('close-dimensions').onclick = () => element<HTMLDialogElement>('dimensions-dialog').close();
element('dimensions-dialog').querySelector('form')!.onsubmit = event => { event.preventDefault(); if (mode === 'fullscreen') { return; } sizes[mode] = { width: Number(element<HTMLInputElement>('preview-width').value), height: Number(element<HTMLInputElement>('preview-height').value) }; layoutPreview(); persist(); element<HTMLDialogElement>('dimensions-dialog').close(); };
element('reset-dimensions').onclick = () => { if (mode !== 'fullscreen') { sizes[mode] = { ...defaults[mode] }; element<HTMLInputElement>('preview-width').value = String(sizes[mode].width); element<HTMLInputElement>('preview-height').value = String(sizes[mode].height); } };
element('resize-preview').onpointerdown = event => { if (mode === 'fullscreen') { return; } const selected = mode, initial = { ...sizes[selected] }, x = event.clientX, y = event.clientY, button = element('resize-preview'); button.setPointerCapture(event.pointerId);
  button.onpointermove = move => { sizes[selected] = { width: Math.max(160, Math.min(4096, initial.width + move.clientX - x)), height: Math.max(96, Math.min(4096, initial.height + move.clientY - y)) }; layoutPreview(); };
  button.onpointerup = () => { button.onpointermove = null; persist(); };
};
function methodDescription(): void { const selected = methodSession?.getState().methods.find(item => item.name === element<HTMLSelectElement>('method-name').value); element('method-description').textContent = selected?.description ?? t("No page methods registered"); element('method-schema').textContent = selected ? JSON.stringify(selected.inputSchema, null, 2) : ''; element<HTMLButtonElement>('invoke-method').disabled = !selected || !connected; }
element('methods').onclick = () => { element<HTMLSelectElement>('method-name').replaceChildren(...(methodSession?.getState().methods ?? []).map(item => new Option(item.name, item.name))); methodDescription(); element('method-result').textContent = ''; element<HTMLDialogElement>('methods-dialog').showModal(); };
element<HTMLSelectElement>('method-name').onchange = methodDescription;
element('close-methods').onclick = () => element<HTMLDialogElement>('methods-dialog').close();
element('invoke-method').onclick = async () => { if (!connected || methodWorking) { return; } methodWorking = true; controls();
  try { const result = await methodSession!.invoke({ instanceId: methodSession!.instanceId, configurationId: state!.configuration.id, method: element<HTMLSelectElement>('method-name').value, args: JSON.parse(element<HTMLTextAreaElement>('method-args').value) }); element('method-result').textContent = JSON.stringify(result, null, 2); }
  catch (error) { element('method-result').textContent = (error as Error).message; } finally { methodWorking = false; controls(); }
};
element('usage').onclick = () => dialogs.usage(requestId => host.postMessage({ type: 'usage', requestId }));
element('project-info').onclick = () => { if (project) { dialogs.projectInfo(project); } };
window.addEventListener('message', event => {
  const message: Message = event.data;
  if (event.source === frame.contentWindow) {
    if (!state || message?.nonce !== state.preview.nonce) { return; }
    methodSession?.receive(message); controls();
    if (message.type === KANBAN_PREVIEW_READY_MESSAGE || message.type === 'steamharness:kanban-method-catalog') { publishMethods(); }
    if (message.type === KANBAN_PREVIEW_READY_MESSAGE) { clearTimeout(readyTimer); element('preview-status').hidden = true;
      frame.contentWindow?.postMessage({ type: 'steamharness:kanban-theme', nonce: state.preview.nonce, theme: document.documentElement.dataset.theme }, '*');
      frame.contentWindow?.postMessage({ type: 'steamharness:kanban-presentation', nonce: state.preview.nonce, presentation: { mode } }, '*'); return;
    }
    if (message.type !== KANBAN_BRIDGE_REQUEST_MESSAGE) { return; }
    const nonce = state.preview.nonce, target = frame.contentWindow, generation = methodSession;
    const respond = (reply: Message) => { if (generation === methodSession && nonce === state?.preview.nonce) { target?.postMessage({ type: KANBAN_BRIDGE_RESPONSE_MESSAGE, nonce, requestId: message.requestId, ...reply }, '*'); } };
    if (!connected || pendingBridge >= KANBAN_BRIDGE_MAX_PENDING_REQUESTS) { respond({ ok: false, error: { code: connected ? 'KANBAN_BRIDGE_BUSY' : 'KANBAN_BRIDGE_UNAVAILABLE', message: t("The Kanban connection is unavailable.") } }); return; }
    let call;
    try { if (Object.keys(message).some(key => !['type', 'nonce', 'requestId', 'operation', 'input'].includes(key))) { throw new Error('Invalid request.'); } call = parseKanbanBridgeCall({ requestId: message.requestId, operation: message.operation, input: message.input }); }
    catch (error) { respond({ ok: false, error: createKanbanBridgeError(error) }); return; }
    pendingBridge++;
    void request({ type: 'kanban-bridge', nonce, call }).then(reply => respond({ ok: reply.ok, value: reply.value, error: reply.error })).catch(error => respond({ ok: false, error: createKanbanBridgeError(error) })).finally(() => { pendingBridge = Math.max(0, pendingBridge - 1); }); return;
  }
  if (event.source !== null) { return; }
  if (!message || typeof message.type !== 'string') { return; }
  if (message.type === 'kanban-method-invoke' && message.instanceId === methodSession?.instanceId) {
    const abort = new AbortController(); methodCalls.set(message.requestId, abort);
    void methodSession!.invoke({ instanceId: message.instanceId, configurationId: message.configurationId, method: message.method, args: message.args }, abort.signal)
      .then(value => host.postMessage({ type: 'kanban-method-reply', requestId: message.requestId, instanceId: message.instanceId, ok: true, value }))
      .catch(error => host.postMessage({ type: 'kanban-method-reply', requestId: message.requestId, instanceId: message.instanceId, ok: false, error: error.message }))
      .finally(() => methodCalls.delete(message.requestId)); return;
  }
  if (message.type === 'kanban-method-cancel') { methodCalls.get(message.requestId)?.abort(); return; }
  if (message.requestId && pending.has(message.requestId)) { const waiting = pending.get(message.requestId)!; clearTimeout(waiting.timer); pending.delete(message.requestId); message.type === 'error' ? waiting.reject(new Error(message.message)) : waiting.resolve(message); }
  if (message.type === 'connection') { connected = message.status === 'connected'; controls(); if (connected) { publishMethods();  } else { dialogs.closeUsage(); for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(t("Connection interrupted."))); } pending.clear(); for (const call of methodCalls.values()) { call.abort(); } } }
  if (message.type === 'state') { project = message.project; element('kanban-title').textContent = project!.name;
    updateProjectAvatar(element('project-info'), project!);
    if (authRevision !== message.authenticationRevision) { authRevision = message.authenticationRevision; previewKey = ''; dialogs.closeUsage(); }
    element('usage').hidden = message.account.status !== 'authenticated' || !message.account.aiConfigured; update(message.kanban);
  }
  if (message.type === 'usage') { dialogs.usageResult(message.requestId, message.usage); }
  if (message.type === 'error' && message.requestType === 'usage') { dialogs.usageResult(message.requestId, undefined, message.message); return; }
  if (message.type === 'error' && !message.silent && !message.requestId) { showError(message.message); }
});
new ResizeObserver(layoutPreview).observe(element('preview-stage'));
new MutationObserver(inject).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
let methodHeartbeat = setInterval(publishMethods, 5_000);
narrow.addEventListener('change', layoutPreview); menu(menuOpen); controls();
addEventListener('pagehide', () => { methodSession?.close(); clearTimeout(saveTimer); clearTimeout(readyTimer); clearInterval(methodHeartbeat); });
addEventListener('pageshow', event => {
  if (!event.persisted) { return; }
  mountPreview(); clearInterval(methodHeartbeat); methodHeartbeat = setInterval(publishMethods, 5_000);
});
