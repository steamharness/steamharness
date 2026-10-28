import { t } from '../localization';
import { iconHtml } from './ui';

/**
 * Toolbar buttons the conversation, workflow and kanban pages all carry, so their icons and
 * labels cannot drift apart. They are functions rather than constants because they localize at
 * the moment a page builds its markup.
 */

export function projectInfoButton(): string {
  return `<button id="project-info" class="icon-button" title="${t("Project information")}" aria-label="${t("Project information")}" aria-haspopup="dialog" aria-controls="project-information-dialog">${iconHtml('package')}</button>`;
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
