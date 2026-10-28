import type { ProjectCardMetadata } from '@steamharness/project-card-metadata';
import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';
import { t } from '../localization';
import { projectTypeLabels, type Project, type ProjectKind } from '../workflow-types';
import { iconButton, iconHtml } from './ui';
import './entry-windows.css';

interface EntryWindow {
  entryId: string; name: string; type: ProjectKind; href: string; status: string;
  projectCard?: ProjectCardMetadata;
}
interface AggregateWindows { projectId: string; name: string; defaultEntry: string; entries: EntryWindow[] }

/** Each entry opens an independent tab on the shared aggregate host. */
export function mountEntryWindows(toolbar: Element) {
  const lifecycle = new AbortController();
  let disposed = false;
  const trigger = iconButton('layout', t('Project windows'), () => {
    if (!dialog.open) { dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); }
  });
  trigger.classList.add('entry-windows-button');
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
  trigger.disabled = true; toolbar.prepend(trigger);
  const dialog = document.createElement('dialog');
  dialog.className = 'conversation-dialog entry-windows-dialog'; dialog.id = `entry-windows-${crypto.randomUUID()}`;
  dialog.setAttribute('aria-label', t('Project windows')); trigger.setAttribute('aria-controls', dialog.id);
  dialog.innerHTML = `<header><span class="entry-windows-heading-icon">${iconHtml('layout')}</span><div class="entry-windows-heading"><h2>${t('Project windows')}</h2><p class="entry-windows-project"></p></div><button type="button" class="icon-button" aria-label="${t('Close')}" title="${t('Close')}">${iconHtml('close')}</button></header><div class="dialog-body"><div class="entry-windows-list"></div></div>`;
  document.body.append(dialog);
  const list = dialog.querySelector<HTMLElement>('.entry-windows-list')!;
  let project: Pick<Project, 'id' | 'entryId'> | undefined, aggregate: AggregateWindows | undefined;
  let hosted = false, signature = '', scheduled = false;
  const closeDialog = () => { if (dialog.open) dialog.close(); };
  dialog.querySelector('header button')!.addEventListener('click', closeDialog);
  dialog.addEventListener('close', () => { trigger.setAttribute('aria-expanded', 'false'); trigger.focus({ preventScroll: true }); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); } });

  const openNew = (entry: EntryWindow) => {
    if (hosted && project) window.parent.postMessage({ type: 'workflow-open-entry', version: 1, projectId: project.id, entryId: entry.entryId }, '*');
    else {
      const url = new URL(entry.href, location.href);
      if (url.origin !== location.origin || url.pathname !== `/entries/${entry.entryId}/`) throw new Error('Invalid entry window URL.');
      const locale = new URLSearchParams(location.search).get('projectLocale');
      if (locale) url.searchParams.set('projectLocale', locale);
      url.searchParams.set('projectView', crypto.randomUUID());
      window.open(url.href, '_blank', 'noopener');
    }
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
        const current = entry.entryId === project.entryId;
        row.classList.toggle('is-current', current);
        const image = document.createElement('img'); image.className = 'entry-window-icon'; image.alt = ''; image.src = projectAvatarDataUrl(entry.projectCard, entry.type);
        const identity = document.createElement('div'); identity.className = 'entry-window-identity';
        const heading = document.createElement('div'); heading.className = 'entry-window-heading';
        const name = document.createElement('strong'); name.textContent = entry.name; heading.append(name);
        if (current) {
          const badge = document.createElement('span'); badge.className = 'entry-window-current'; badge.textContent = t('Current window'); heading.append(badge);
        }
        const detail = document.createElement('div'); detail.className = 'entry-window-details';
        const type = document.createElement('span'); type.textContent = projectTypeLabels[entry.type]; detail.append(type);
        if (entry.entryId === aggregate.defaultEntry) {
          const badge = document.createElement('span'); badge.className = 'entry-window-default'; badge.textContent = t('Default window'); detail.append(badge);
        }
        const status = document.createElement('span'); status.className = 'entry-window-status'; status.setAttribute('role', 'status');
        detail.append(status); identity.append(heading, detail);
        const label = hosted ? t('Open in new Studio tab') : t('Open in new browser tab');
        const fresh = iconButton('link-external', label, () => { openNew(entry); closeDialog(); });
        fresh.classList.add('entry-window-open'); fresh.dataset.action = 'open';
        fresh.setAttribute('aria-label', `${entry.name}: ${label}`);
        row.append(image, identity, fresh); list.append(row);
      }
    }
    for (const entry of aggregate.entries) {
      const row = [...list.children].find(row => (row as HTMLElement).dataset.entryId === entry.entryId) as HTMLElement;
      const status = row.querySelector<HTMLElement>('.entry-window-status')!;
      status.dataset.status = entry.status; status.textContent = t(entry.status);
    }
  };
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true; requestAnimationFrame(() => { scheduled = false; render(); });
  }
  addEventListener('message', event => {
    if (event.source !== null && event.source !== window.parent) return;
    const message = event.data;
    if (message?.type === 'state') {
      if (message.project) project = message.project;
      if (message.aggregate) aggregate = message.aggregate;
      scheduleRender();
    } else if (event.source === window.parent && message?.type === 'workflow-host' && message.entryWindowVersion !== undefined) {
      hosted = message.entryWindowVersion === 1; scheduleRender();
    }
  }, { signal: lifecycle.signal });
  const dispose = () => {
    if (disposed) return;
    disposed = true; lifecycle.abort(); dialog.remove(); trigger.remove();
  };
  addEventListener('pagehide', event => { if (!event.persisted) dispose(); }, { signal: lifecycle.signal });
  return { trigger, dispose };
}
