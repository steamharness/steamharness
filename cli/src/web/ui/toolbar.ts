import { t } from '../localization';
import type { Host } from './host';
import { iconHtml } from './ui';

/**
 * Toolbar buttons the conversation, workflow and kanban pages all carry, so their icons and
 * labels cannot drift apart. They are functions rather than constants because they localize at
 * the moment a page builds its markup.
 */

export function projectInfoButton(): string {
  return `<button id="project-info" class="icon-button" title="${t("Project information")}" aria-label="${t("Project information")}" aria-haspopup="dialog" aria-controls="project-information-dialog">${iconHtml('package')}</button>`;
}

export function projectToolbarButtons(refresh = true): string {
  if (!refresh) return projectInfoButton();
  const label = t('Reload project');
  return `<div class="project-toolbar-buttons"><button id="project-reload" type="button" class="icon-button" title="${label}" aria-label="${label}">${iconHtml('refresh')}</button>${projectInfoButton()}</div>`;
}

export function bindProjectReload(host: Host, showError: (message: string) => void, saveDraft?: () => Record<string, unknown> | void): void {
  const button = document.getElementById('project-reload') as HTMLButtonElement | null;
  if (!button) return;
  if (!host.reloadProject) { button.disabled = true; return; }
  const update = (busy: boolean) => {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    button.title = t(busy ? 'Reloading project...' : 'Reload project');
    button.setAttribute('aria-label', button.title);
  };
  button.onclick = async () => {
    if (button.disabled || !host.reloadProject) return;
    update(true);
    try { await host.reloadProject(saveDraft?.() ?? undefined); }
    catch (error) { showError(error instanceof Error ? error.message : String(error)); }
    finally { update(false); }
  };
}

/**
 * Narrow layouts stack the project menu above the body, so the menu reads as a popup that the
 * body or a selection dismisses. Wide layouts keep the menu as a persistent sidebar, so the
 * returned callback leaves it alone. Returns the callback so a page can both bind it to a
 * click on the body and call it directly after picking a session or pressing Escape.
 */
export function narrowMenuDismiss(narrow: MediaQueryList, isOpen: () => boolean, close: () => void): () => void {
  return () => { if (isOpen() && narrow.matches) { close(); } };
}
