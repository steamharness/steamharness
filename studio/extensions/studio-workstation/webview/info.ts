import { t } from './localization';
import { escapeHtml, iconHtml } from './ui';
import type { InfoItem, InfoState } from '../src/workflow-info';
import { projectVersionHtml } from './project-version';
import './info.css';
import { installContextMenu, type ContextAction } from './context-menu';

interface SavedState { sections?: Record<string, Record<string, boolean>>; projectUri?: string }
declare function acquireVsCodeApi(): { postMessage(message: object): void; getState(): SavedState | undefined; setState(state: SavedState): void };

const host = acquireVsCodeApi();
const app = document.querySelector<HTMLElement>('#info-app')!;
const saved = host.getState() ?? {};
const sections = saved.sections ?? {};
let state: InfoState | undefined, signature = '';
installContextMenu(host, target => {
  if (!state?.project || !target.closest('#info-app')) { return []; }
  const actions: ContextAction[] = [];
  const field = target.closest('[data-field]');
  const copy = field?.querySelector<HTMLButtonElement>('[data-copy]');
  if (copy) { actions.push({ id: 'copy', run: () => copy.click() }); }
  const section = target.closest<HTMLDetailsElement>('details[data-section]');
  if (section) { actions.push({ id: section.open ? 'collapse' : 'expand', run: () => { section.open = !section.open; } }); }
  actions.push({ id: 'openSource', run: () => host.postMessage({ type: 'source', generation: state!.generation, projectUri: state!.project!.uri }) },
    { id: 'refresh', run: () => host.postMessage({ type: 'refresh', generation: state!.generation, projectUri: state!.project!.uri }) });
  return actions;
}, () => JSON.stringify([state?.generation, state?.project?.uri]));

function renderItem(item: InfoItem, nested = false): string {
  const id = escapeHtml(item.id), label = escapeHtml(item.label);
  if (item.children) {
    const empty = item.children.length === 1 && item.children[0].id === `${item.id}:empty`;
    const open = sections[state!.project!.uri]?.[item.id] ?? (item.expanded && !empty);
    const count = ['related', 'entrypoints'].includes(item.id) && !empty ? String(item.children.length) : '';
    return `<details class="info-section${nested ? ' nested' : ''}" data-section="${id}"${open ? ' open' : ''}>
      <summary>${iconHtml('chevron-right')}${item.icon ? iconHtml(item.icon) : ''}<span class="section-label">${label}</span>
        ${empty || count ? `<span class="section-meta">${empty ? escapeHtml(t("Not declared")) : count}</span>` : ''}</summary>
      <div class="section-content">${item.children.map(child => renderItem(child, true)).join('')}</div></details>`;
  }
  if (item.value === undefined) { return `<p class="info-empty" data-field="${id}">${label}</p>`; }
  const wide = ['uuid', 'path', 'description'].includes(item.id) || item.id.endsWith(':uuid');
  const code = ['name', 'uuid', 'path'].includes(item.id) || item.id.endsWith(':uuid');
  const copy = escapeHtml(t("Copy {0}", item.label));
  return `<dl class="info-field${wide ? ' wide' : ''}" data-field="${id}">
    <dt>${label}</dt><dd class="info-value${code ? ' code' : ''}">${escapeHtml(item.value)}</dd>
    <dd class="field-action"><button class="copy-button" type="button" data-copy="${id}" title="${copy}" aria-label="${copy}">${iconHtml('copy')}</button></dd></dl>`;
}

function render(next: InfoState): void {
  const previousUri = state?.project?.uri;
  state = next;
  if (next.project) { host.setState({ sections, projectUri: next.project.uri }); }
  const nextSignature = JSON.stringify([next.project, next.items, next.update]);
  if (signature === nextSignature) { return; }
  signature = nextSignature;
  const scroll = previousUri === next.project?.uri ? window.scrollY : 0;
  const focused = document.activeElement as HTMLElement | null;
  const versionAction = focused?.dataset.action;
  const copyId = focused?.dataset.copy, sectionId = focused?.closest<HTMLDetailsElement>('details')?.dataset.section;
  const status = next.items.find(item => item.id === 'loading' || item.id === 'error');
  app.setAttribute('aria-busy', String(status?.id === 'loading'));
  if (status || !next.project) {
    app.innerHTML = `<div class="info-status" role="${status?.id === 'error' ? 'alert' : 'status'}">
      ${iconHtml(status?.id === 'error' ? 'warning' : status ? 'loading' : 'info')}
      <div><p>${escapeHtml(status?.label ?? t("No project selected"))}</p>${status?.value ? `<p class="status-detail">${escapeHtml(status.value)}</p>` : ''}</div></div>`;
  } else {
    const avatar = next.project.avatarUrl?.startsWith('data:image/svg+xml,') ? escapeHtml(next.project.avatarUrl) : undefined;
    const name = escapeHtml(next.project.name), previewLabel = escapeHtml(t("Project avatar"));
    app.innerHTML = `<div class="info-project-heading">${avatar ? `<button type="button" class="info-avatar" data-action="avatar" title="${previewLabel}" aria-label="${previewLabel}" aria-haspopup="dialog"><img src="${avatar}" alt=""></button>` : ''}<strong>${name}</strong></div>`
      + (avatar ? `<dialog class="avatar-dialog" aria-label="${name}"><button type="button" class="copy-button" data-close-avatar title="${escapeHtml(t("Close"))}" aria-label="${escapeHtml(t("Close"))}">${iconHtml('close')}</button><img src="${avatar}" alt="${name}"></dialog>` : '')
      + (next.update ? projectVersionHtml(next.update) : '') + next.items.map(item => renderItem(item)).join('');
    const avatarButton = app.querySelector<HTMLButtonElement>('[data-action="avatar"]');
    if (avatarButton) {
      const preview = app.querySelector<HTMLDialogElement>('.avatar-dialog')!;
      avatarButton.onclick = () => preview.showModal();
      preview.querySelector<HTMLButtonElement>('[data-close-avatar]')!.onclick = () => preview.close();
      preview.addEventListener('click', event => { if (event.target === preview) { const rect = preview.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { preview.close(); } } });
      if (versionAction === 'avatar' && previousUri === next.project?.uri) { avatarButton.focus({ preventScroll: true }); }
    }
    const upgrade = app.querySelector<HTMLButtonElement>('[data-action="upgrade"]');
    if (upgrade) {
      upgrade.onclick = () => host.postMessage({ type: 'upgrade', generation: state!.generation, projectUri: state!.project!.uri });
      if (versionAction === 'upgrade' && previousUri === next.project?.uri) { upgrade.focus({ preventScroll: true }); }
    }
    app.querySelectorAll<HTMLDetailsElement>('[data-section]').forEach(details => {
      details.addEventListener('toggle', () => {
        const uri = next.project!.uri;
        sections[uri] = { ...sections[uri], [details.dataset.section!]: details.open };
        host.setState({ sections, projectUri: uri });
      });
    });
    app.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => {
      button.onclick = () => host.postMessage({ type: 'copy', generation: state!.generation,
        projectUri: state!.project!.uri, itemId: button.dataset.copy });
      if (copyId === button.dataset.copy && previousUri === next.project?.uri) { button.focus({ preventScroll: true }); }
    });
    if (!copyId && sectionId && previousUri === next.project?.uri) {
      Array.from(app.querySelectorAll<HTMLDetailsElement>('[data-section]')).find(details => details.dataset.section === sectionId)
        ?.querySelector('summary')?.focus({ preventScroll: true });
    }
  }
  window.scrollTo(0, scroll);
}

addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'info-state') { render(message); }
  if (message?.type === 'info-copied' && message.generation === state?.generation) {
    const button = Array.from(app.querySelectorAll<HTMLButtonElement>('[data-copy]')).find(button => button.dataset.copy === message.itemId);
    if (!button) { return; }
    button.innerHTML = iconHtml('check');
    button.classList.add('copied');
    document.querySelector('#info-announcement')!.textContent = t("Copied");
    setTimeout(() => { if (button.isConnected) { button.innerHTML = iconHtml('copy'); button.classList.remove('copied'); } }, 1500);
  }
});
host.postMessage({ type: 'ready' });
