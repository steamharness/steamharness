import { t } from './localization';
import { escapeHtml, iconHtml } from './ui';
import type { WorkflowVersionsState } from '../src/workflow-server-projects';
import { projectVersionHtml } from './project-version';
import './versions.css';

declare function acquireVsCodeApi(): { postMessage(message: object): void };
const host = acquireVsCodeApi();
const app = document.querySelector<HTMLElement>('#versions-app')!;
let state: WorkflowVersionsState | undefined, signature = '';
const text = escapeHtml;
const iconButton = (action: string, icon: string, label: string, disabled = false, version = ''): string =>
  `<button type="button" class="icon-button" data-action="${action}" data-version="${text(version)}" title="${text(label)}" aria-label="${text(label)}"${disabled ? ' disabled' : ''}>${iconHtml(icon)}</button>`;
function date(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) { return ''; }
  return new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function render(next: WorkflowVersionsState): void {
  if (state && next.generation < state.generation) { return; }
  const changed = state?.project?.uri !== next.project?.uri;
  state = next;
  const key = JSON.stringify(next);
  if (key === signature) { return; }
  signature = key;
  const scroll = changed ? 0 : window.scrollY;
  const focused = document.activeElement as HTMLElement | null;
  const focus = { action: focused?.dataset.action, version: focused?.dataset.version };
  const expanded = changed ? [] : [...app.querySelectorAll<HTMLDetailsElement>('article.version details[open]')].map(details => details.closest<HTMLElement>('article')!.dataset.version);
  app.setAttribute('aria-busy', String(next.loading || next.busy));
  if (!next.project) {
    app.innerHTML = `<p class="empty">${text(t('Open a project to view its versions.'))}</p>`;
  } else if (!next.signedIn) {
    app.innerHTML = `<div class="empty"><p>${text(t('Sign in to SteamHarness Server first.'))}</p><button type="button" data-action="sign-in">${text(t('Sign In'))}</button></div>`;
  } else {
    app.innerHTML = `<div class="current-project"><strong>${text(next.project.name)}</strong></div>
      ${next.update ? projectVersionHtml(next.update, next.busy) : ''}
      ${next.error ? `<div class="error" role="alert">${text(next.error)}</div>` : ''}
      ${next.loading && !next.versions.length ? `<p class="empty" role="status">${text(t('Loading...'))}</p>` : ''}
      ${!next.loading && !next.versions.length ? `<p class="empty">${text(t('No published versions.'))}</p>` : ''}
      ${next.versions.length && !next.canDownload ? `<p class="notice">${text(next.transfersAvailable ? t('Project source download is not granted.') : t('Project transfers are unavailable in this extension host.'))}</p>` : ''}
      ${next.versions.length ? `<h2 class="history-heading">${text(t('Version History'))}</h2>` : ''}
      <div class="versions">${next.versions.map(version => `<article class="version" data-version="${text(version.version)}">
        <header><strong>${text(version.version)}</strong><span class="badges">${version.latest ? `<span>${text(t('Latest'))}</span>` : ''}${version.version === next.localVersion ? `<span>${text(t('Local'))}</span>` : ''}</span>
          ${iconButton('download', 'cloud-download', t('Download Version {0}', version.version), !next.canDownload || next.busy || next.loading, version.version)}</header>
        <div class="metadata">${text([date(version.createdAt), version.createdByProfile?.displayName || version.createdByProfile?.email].filter(Boolean).join(' \u00b7 '))}</div>
        ${version.releaseLog ? `<p class="release-log">${text(version.releaseLog)}</p>` : ''}
        ${version.sourceHash || version.dependencies?.length ? `<details><summary>${text(t('Version Details'))}</summary><dl>
          ${version.sourceHash ? `<dt>${text(t('Source Hash'))}</dt><dd class="hash">${text(version.sourceHash)}</dd>` : ''}
          ${version.dependencies?.length ? `<dt>${text(t('Related Projects'))}</dt><dd>${version.dependencies.map(dependency => `<div>${text(dependency.alias)} \u00b7 ${text(dependency.version ?? t('External'))}</div>`).join('')}</dd>` : ''}
        </dl></details>` : ''}</article>`).join('')}</div>`;
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    button.onclick = () => host.postMessage({ type: button.dataset.action, generation: state!.generation, projectId: state!.project?.id, version: button.dataset.version });
    if (!changed && focus.action === button.dataset.action && focus.version === button.dataset.version) { button.focus({ preventScroll: true }); }
  }
  for (const details of app.querySelectorAll<HTMLDetailsElement>('article.version details')) {
    if (expanded.includes(details.closest<HTMLElement>('article')!.dataset.version)) { details.open = true; }
  }
  window.scrollTo(0, scroll);
}
addEventListener('message', event => { if (event.data?.type === 'versions-state') { render(event.data); } });
host.postMessage({ type: 'ready' });
