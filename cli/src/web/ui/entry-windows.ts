import type { ProjectCardMetadata } from '@steamharness/project-card-metadata';
import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';
import { t } from '../localization';
import { projectTypeLabels, type Project, type ProjectKind } from '../workflow-types';
import { iconHtml } from './ui';
import './entry-windows.css';

interface EntryWindow {
  entryId: string; name: string; type: ProjectKind; href: string; status: string;
  projectCard?: ProjectCardMetadata;
}
interface AggregateWindows { projectId: string; name: string; defaultEntry: string; entries: EntryWindow[] }
interface Pane { id: string; entry: EntryWindow; frame: HTMLIFrameElement }
const bridgeMessages = new Set(['workflow-open-entry', 'workflow-trace', 'workflow-account', 'workflow-clipboard',
  'workflow-resource', 'workflow-reconnect', 'workflow-drop-target', 'workflow-path-picker', 'workflow-path-open',
  'workflow-user-settings', 'workflow-file-icons', 'workflow-edit', 'workflow-contextmenu', 'workflow-project-upload']);
const hostProperties = ['theme', 'locale', 'traceVersion', 'clipboardVersion', 'nativePasteVersion', 'resourceVersion',
  'projectSetupVersion', 'recoveryVersion', 'dropVersion', 'pathPickerVersion', 'pathOpenVersion', 'userSettingsVersion',
  'fileIconsVersion', 'entryWindowVersion'] as const;

/** Entry windows use the aggregate HTTP host. The primary UI is never remounted. */
export function mountEntryWindows(toolbar: Element) {
  const lifecycle = new AbortController();
  let disposed = false;
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'entry-windows-button';
  trigger.innerHTML = `${iconHtml('layout')}<span>${t('Project windows')}</span>`;
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
  trigger.disabled = true; toolbar.prepend(trigger);
  const dialog = document.createElement('dialog');
  dialog.className = 'conversation-dialog entry-windows-dialog'; dialog.id = `entry-windows-${crypto.randomUUID()}`;
  dialog.setAttribute('aria-label', t('Project windows')); trigger.setAttribute('aria-controls', dialog.id);
  dialog.innerHTML = `<header><h2>${t('Project windows')}</h2><button type="button" class="icon-button" aria-label="${t('Close')}">${iconHtml('close')}</button></header><div class="dialog-body"><p class="entry-windows-project"></p><div class="entry-windows-list"></div></div>`;
  document.body.append(dialog);
  const list = dialog.querySelector<HTMLElement>('.entry-windows-list')!;
  const nested = new URLSearchParams(location.search).has('projectPane');
  const panes = new Map<string, Pane>();
  let project: Pick<Project, 'id' | 'entryId'> | undefined, aggregate: AggregateWindows | undefined;
  let hosted = false, hostState: Record<string, any> = {}, signature = '', scheduled = false;
  let workspace: HTMLDivElement | undefined, side: HTMLElement | undefined, separator: HTMLElement | undefined;
  let activePane: Pane | undefined, width = 50;
  const sendParent = (message: Record<string, any>) => window.parent.postMessage(message, '*');
  const focusRoute = (pane?: Pane) => {
    if (hosted) sendParent({ type: 'workflow-entry-focus', version: 1, frameId: pane?.id });
  };
  const route = (pane: Pane, message: Record<string, any>) => {
    if (hosted && project) sendParent({ type: 'workflow-entry-message', version: 1, projectId: project.id,
      entryId: pane.entry.entryId, frameId: pane.id, message });
  };
  const childHost = (message: Record<string, any>) => ({ ...message, type: 'workflow-host', windowChrome: { active: false, height: 0, left: 0, right: 0, revision: 0 } });
  const address = (entry: EntryWindow) => {
    const url = new URL(entry.href, location.href);
    if (url.origin !== location.origin || url.pathname !== `/entries/${entry.entryId}/`) throw new Error('Invalid entry window URL.');
    const locale = new URLSearchParams(location.search).get('projectLocale');
    if (locale) url.searchParams.set('projectLocale', locale);
    return url;
  };
  const closeDialog = () => { if (dialog.open) dialog.close(); };
  trigger.onclick = () => { if (!dialog.open) { dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); } };
  dialog.querySelector('header button')!.addEventListener('click', closeDialog);
  dialog.addEventListener('close', () => { trigger.setAttribute('aria-expanded', 'false'); trigger.focus({ preventScroll: true }); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); } });

  const setWidth = (value: number) => {
    width = Math.min(76, Math.max(24, value));
    workspace?.style.setProperty('--primary-entry-width', `${width}%`);
    separator?.setAttribute('aria-valuenow', String(Math.round(width)));
  };
  const openNew = (entry: EntryWindow) => {
    if (hosted && project) sendParent({ type: 'workflow-open-entry', version: 1, projectId: project.id, entryId: entry.entryId });
    else {
      const url = address(entry); url.searchParams.set('projectView', crypto.randomUUID());
      window.open(url.href, '_blank', 'noopener');
    }
  };
  const closePane = () => {
    if (!activePane) return;
    route(activePane, { type: 'workflow-entry-dispose', version: 1 });
    activePane.frame.remove(); panes.delete(activePane.entry.entryId); activePane = undefined;
    const remaining = [...panes.values()].at(-1);
    if (remaining) { showPane(remaining); return; }
    workspace?.classList.remove('has-entry-pane');
    if (side) side.hidden = true;
    if (separator) separator.hidden = true;
    focusRoute(); trigger.focus({ preventScroll: true }); scheduleRender();
  };
  const showPane = (pane: Pane) => {
    activePane = pane;
    workspace!.classList.add('has-entry-pane'); side!.hidden = false; separator!.hidden = false;
    for (const item of panes.values()) item.frame.hidden = item !== pane;
    const image = side!.querySelector<HTMLImageElement>('.entry-pane-icon')!;
    image.src = projectAvatarDataUrl(pane.entry.projectCard, pane.entry.type);
    side!.querySelector<HTMLElement>('.entry-pane-name')!.textContent = pane.entry.name;
    side!.querySelector<HTMLElement>('.entry-pane-type')!.textContent = projectTypeLabels[pane.entry.type];
    pane.frame.focus({ preventScroll: true }); focusRoute(pane);
    scheduleRender();
  };
  const prepareWorkspace = () => {
    if (workspace) return;
    const app = document.querySelector<HTMLElement>('#app')!;
    workspace = document.createElement('div'); workspace.className = 'entry-workspace';
    app.before(workspace); workspace.append(app);
    separator = document.createElement('div'); separator.className = 'entry-pane-separator'; separator.tabIndex = 0;
    separator.setAttribute('role', 'separator'); separator.setAttribute('aria-orientation', 'vertical');
    separator.setAttribute('aria-label', t('Resize entry windows')); separator.setAttribute('aria-valuemin', '24'); separator.setAttribute('aria-valuemax', '76');
    separator.setAttribute('aria-valuenow', String(width));
    separator.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); setWidth(event.key === 'Home' ? 24 : event.key === 'End' ? 76 : width + (event.key === 'ArrowRight' ? 2 : -2));
    });
    separator.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); separator!.setPointerCapture(event.pointerId); workspace!.classList.add('entry-pane-resizing');
    });
    separator.addEventListener('pointermove', event => {
      if (!separator!.hasPointerCapture(event.pointerId)) return;
      const rect = workspace!.getBoundingClientRect(); setWidth((event.clientX - rect.left) / rect.width * 100);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) separator.addEventListener(type, () => workspace!.classList.remove('entry-pane-resizing'));
    side = document.createElement('section'); side.className = 'entry-pane'; side.setAttribute('aria-label', t('Entry window'));
    side.innerHTML = `<header class="entry-pane-heading"><img class="entry-pane-icon" alt=""><span class="entry-pane-name"></span><span class="entry-pane-type"></span><button type="button" class="icon-button entry-pane-new" aria-label="${t('Open in new tab')}" title="${t('Open in new tab')}">${iconHtml('link-external')}</button><button type="button" class="icon-button entry-pane-close" aria-label="${t('Close split window')}" title="${t('Close split window')}">${iconHtml('close')}</button></header><div class="entry-pane-frames"></div>`;
    side.querySelector('.entry-pane-new')!.addEventListener('click', () => { if (activePane) openNew(activePane.entry); });
    side.querySelector('.entry-pane-close')!.addEventListener('click', closePane);
    workspace.append(separator, side);
  };
  const openSplit = (entry: EntryWindow) => {
    if (nested) { sendParent({ type: 'workflow-pane-open', version: 1, entryId: entry.entryId }); return; }
    if (entry.entryId === project?.entryId) { focusRoute(); document.querySelector<HTMLElement>('#app button')?.focus({ preventScroll: true }); return; }
    prepareWorkspace();
    let pane = panes.get(entry.entryId);
    if (!pane) {
      const id = crypto.randomUUID(), url = address(entry);
      url.searchParams.set('projectPane', id); url.searchParams.set('projectView', id);
      const frame = document.createElement('iframe');
      frame.title = `${aggregate!.name} / ${entry.name}`; frame.className = 'entry-pane-frame';
      frame.setAttribute('allow', 'clipboard-read; clipboard-write');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-modals');
      pane = { id, entry, frame }; panes.set(entry.entryId, pane);
      const target = pane;
      frame.addEventListener('load', () => {
        route(target, { type: 'workflow-frame-ready', version: 1 });
        frame.contentWindow?.postMessage(childHost(hostState), location.origin);
        if (document.activeElement === frame) focusRoute(target);
      });
      side!.querySelector('.entry-pane-frames')!.append(frame); frame.src = url.href;
    }
    showPane(pane);
  };
  const render = () => {
    if (disposed || !aggregate || !project) return;
    trigger.disabled = false;
    dialog.querySelector('.entry-windows-project')!.textContent = aggregate.name;
    const next = JSON.stringify([hosted, aggregate.defaultEntry, project.entryId, aggregate.entries.map(({ status, ...entry }) => entry)]);
    if (next !== signature) {
      signature = next; list.replaceChildren();
      for (const entry of aggregate.entries) {
        const row = document.createElement('section'); row.className = 'entry-window-row'; row.dataset.entryId = entry.entryId;
        const image = document.createElement('img'); image.className = 'entry-window-icon'; image.alt = ''; image.src = projectAvatarDataUrl(entry.projectCard, entry.type);
        const identity = document.createElement('div'); identity.className = 'entry-window-identity';
        const name = document.createElement('strong'); name.textContent = entry.name;
        const detail = document.createElement('span'); detail.textContent = `${projectTypeLabels[entry.type]}${entry.entryId === aggregate.defaultEntry ? ` · ${t('Default window')}` : ''}`;
        const status = document.createElement('span'); status.className = 'entry-window-status'; status.setAttribute('role', 'status');
        identity.append(name, detail, status);
        const actions = document.createElement('div'); actions.className = 'entry-window-actions';
        const fresh = document.createElement('button'); fresh.type = 'button'; fresh.textContent = t('Open in new tab'); fresh.title = hosted ? t('Open in new Studio tab') : t('Open in new browser tab');
        fresh.onclick = () => { openNew(entry); closeDialog(); };
        const split = document.createElement('button'); split.type = 'button'; split.dataset.action = 'split'; split.textContent = t('Open side by side');
        split.onclick = () => { closeDialog(); openSplit(entry); };
        actions.append(fresh, split); row.append(image, identity, actions); list.append(row);
      }
    }
    for (const entry of aggregate.entries) {
      const row = [...list.children].find(row => (row as HTMLElement).dataset.entryId === entry.entryId) as HTMLElement;
      const current = entry.entryId === project.entryId, opened = panes.has(entry.entryId);
      row.querySelector('.entry-window-status')!.textContent = [t(entry.status), current ? t('Current window') : opened ? t('Open in split view') : ''].filter(Boolean).join(' · ');
      const split = row.querySelector<HTMLButtonElement>('[data-action=split]')!;
      split.disabled = current; split.textContent = opened ? t('Show split window') : t('Open side by side');
      const pane = panes.get(entry.entryId);
      if (pane) { pane.entry = entry; if (pane === activePane) {
        side!.querySelector<HTMLImageElement>('.entry-pane-icon')!.src = projectAvatarDataUrl(entry.projectCard, entry.type);
        side!.querySelector('.entry-pane-name')!.textContent = entry.name;
      } }
    }
  };
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true; requestAnimationFrame(() => { scheduled = false; render(); });
  }
  addEventListener('pointerdown', () => focusRoute(), { capture: true, signal: lifecycle.signal });
  addEventListener('focusin', () => focusRoute(), { signal: lifecycle.signal });
  addEventListener('blur', () => { queueMicrotask(() => { if (activePane && document.activeElement === activePane.frame) focusRoute(activePane); }); }, { signal: lifecycle.signal });
  addEventListener('message', event => {
    const pane = [...panes.values()].find(pane => event.source === pane.frame.contentWindow);
    if (pane) {
      if (event.origin !== location.origin || !event.data || event.data.version !== 1) return;
      const message = event.data;
      if (message.type === 'workflow-pane-open') {
        const entry = aggregate?.entries.find(entry => entry.entryId === message.entryId); if (entry) openSplit(entry);
      } else if (bridgeMessages.has(message.type)) {
        if (message.type === 'workflow-contextmenu') {
          const rect = pane.frame.getBoundingClientRect();
          route(pane, { ...message, x: rect.left + message.x, y: rect.top + message.y });
        } else route(pane, message);
      }
      return;
    }
    if (event.source !== null && event.source !== window.parent) return;
    const message = event.data;
    if (message?.type === 'state') {
      if (message.project) project = message.project;
      if (message.aggregate) aggregate = message.aggregate;
      scheduleRender();
    } else if (event.source === window.parent && message?.type === 'workflow-entry-host' && message.version === 1) {
      [...panes.values()].find(pane => pane.id === message.frameId)?.frame.contentWindow?.postMessage(message.message, location.origin);
    } else if (event.source === window.parent && message?.type === 'workflow-host') {
      let changed = false;
      for (const key of hostProperties) if (message[key] !== undefined) { hostState[key] = message[key]; changed = true; }
      if (message.entryWindowVersion !== undefined) { hosted = message.entryWindowVersion === 1; scheduleRender(); }
      if (changed || message.recovery && !message.recovery.requestId) for (const pane of panes.values()) pane.frame.contentWindow?.postMessage(childHost({ ...hostState, ...(message.recovery ? { recovery: message.recovery } : {}) }), location.origin);
    }
  }, { signal: lifecycle.signal });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const pane of panes.values()) route(pane, { type: 'workflow-entry-dispose', version: 1 });
    lifecycle.abort(); panes.clear(); activePane = undefined;
    if (workspace) { const app = workspace.querySelector('#app'); if (app) workspace.before(app); workspace.remove(); }
    dialog.remove(); trigger.remove();
  };
  addEventListener('pagehide', event => { if (!event.persisted) dispose(); }, { signal: lifecycle.signal });
  return { trigger, dispose };
}
