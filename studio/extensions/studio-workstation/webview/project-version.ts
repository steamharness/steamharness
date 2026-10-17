import { t } from './localization';
import { escapeHtml as text, iconHtml } from './ui';
import type { ProjectVersionStatus } from '../src/workflow-server-projects';

export function projectVersionHtml(update: ProjectVersionStatus, busy = false): string {
  const labels: Record<ProjectVersionStatus['status'], string> = {
    checking: t('Checking for Updates...'), 'signed-out': t('Sign in to Check for Updates'), unavailable: t('Could Not Check for Updates'),
    unpublished: t('No Published Server Version'), current: t('Up to Date'), upgrade: t('Update Available'),
    ahead: t('Local Version Is Newer'), different: t('Versions Differ'),
  };
  const icon = update.status === 'upgrade' ? 'arrow-circle-up' : update.status === 'current' ? 'pass' : update.status === 'ahead' ? 'git-commit'
    : update.status === 'unavailable' ? 'warning' : update.status === 'checking' ? 'loading~spin' : 'versions';
  return `<section class="project-version-status" data-status="${update.status}" aria-label="${text(t('Project Versions'))}">
    <div class="project-version-heading">${iconHtml(icon)}<strong>${text(labels[update.status])}</strong>
      ${update.checking && update.status !== 'checking' ? `<span title="${text(t('Checking for Updates...'))}">${iconHtml('loading~spin')}</span>` : ''}</div>
    <div class="project-version-comparison">
      <div><span>${text(t('Local Version'))}</span><b>${text(update.localVersion ?? t('Not declared'))}</b></div>
      <span class="project-version-arrow" aria-hidden="true">${iconHtml('arrow-right')}</span>
      <div><span>${text(update.status === 'unavailable' && update.serverVersion ? t('Last Known Server Version') : t('Server Version'))}</span><b>${text(update.serverVersion ?? '\u2014')}</b></div>
    </div>
    ${update.status === 'upgrade' ? `<button type="button" class="project-upgrade-button" data-action="upgrade"${busy || update.busy || !update.canDownload ? ' disabled' : ''}>${iconHtml('arrow-circle-up')}<span>${text(t('Upgrade...'))}</span></button>
      ${!update.canDownload ? `<p class="project-version-notice">${text(t('Source download is unavailable.'))}</p>` : ''}` : ''}
    ${update.status === 'ahead' ? `<p class="project-version-notice">${text(t('The server version will not replace your newer local version.'))}</p>` : ''}
  </section>`;
}
