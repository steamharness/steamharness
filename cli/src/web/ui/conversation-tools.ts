import { t } from '../localization';
import type { Parameters, ToolPolicies, Project } from '../workflow-types';
import type { SystemAiUsage } from '../workflow-auth-client';
import { iconButton, markdownHtml, iconHtml, escapeHtml } from './ui';
import { projectInformation } from './project-information';
import { usageAmount, usagePeriods } from './ai-usage';
import { imagePreview } from './image-preview';
import { toolsAndSkills } from './tools-and-skills';
import type { ProjectDatabases } from './project-databases';
import './project-databases.css';

export class ConversationTools {
  private readonly dialog = document.createElement('dialog');
  private readonly body = document.createElement('div');
  private readonly title = document.createElement('h2');
  private usageOpen = false;
  private usageRequestId?: string;
  private refresh?: HTMLButtonElement;
  private disposeImage?: () => void;
  private disposeProject?: () => void;
  private readonly toolSections = new Map<string, boolean>();
  constructor(private readonly databases?: ProjectDatabases) {
    this.dialog.className = 'conversation-dialog';
    this.title.id = 'conversation-dialog-title'; this.dialog.setAttribute('aria-labelledby', this.title.id);
    const header = document.createElement('header'); header.append(this.title, iconButton('close', t("Close"), () => this.close()));
    this.body.className = 'dialog-body'; this.dialog.append(header, this.body); document.body.append(this.dialog);
    this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) { const rect = this.dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { this.close(); } } });
    this.dialog.addEventListener('cancel', () => this.close());
  }
  get open(): boolean { return this.dialog.open; }
  close(): void { this.dialog.close(); this.disposeImage?.(); this.disposeImage = undefined; this.disposeProject?.(); this.disposeProject = undefined; this.usageOpen = false; this.usageRequestId = undefined; this.refresh?.remove(); this.refresh = undefined; }
  closeUsage(): void { if (this.usageOpen) { this.close(); } }
  private show(title: string): void { this.close(); this.dialog.classList.remove('image-dialog', 'project-information-dialog'); this.title.textContent = title; this.body.replaceChildren(); this.body.setAttribute('aria-busy', 'false'); this.dialog.showModal(); }

  plan(content: string): void {
    this.show(t("Plan")); const article = document.createElement('article'); article.className = 'message-content'; article.innerHTML = markdownHtml(content); this.body.append(article);
  }

  image(src: string, title: string): void {
    this.show(title || t("Image")); this.dialog.classList.add('image-dialog');
    const preview = imagePreview(src, title); this.disposeImage = preview.dispose; this.body.append(preview.element);
    this.body.querySelector<HTMLElement>('.image-preview-viewport')!.focus({ preventScroll: true });
  }

  projectInfo(project: Project, initialTab: 'overview' | 'databases' = 'overview'): void {
    this.show(t("Project information"));
    this.dialog.classList.add('project-information-dialog');
    const heading = document.createElement('h3'); heading.className = 'project-information-name'; heading.textContent = project.aggregateName;
    this.body.append(heading);
    if (project.manifest?.description) {
      const description = document.createElement('p'); description.className = 'project-information-description'; description.textContent = project.manifest.description; this.body.append(description);
    }
    const navigation = document.createElement('div'); navigation.className = 'project-information-tabs'; navigation.setAttribute('role', 'tablist'); navigation.setAttribute('aria-label', t('Project information'));
    const overview = document.createElement('div'), databases = document.createElement('div');
    const tabs: HTMLButtonElement[] = [];
    let mounted = false;
    for (const [id, label, panel] of [['overview', t('Overview'), overview], ['databases', t('Databases'), databases]] as const) {
      if (id === 'databases' && !this.databases) continue;
      const tab = document.createElement('button'); tab.type = 'button'; tab.textContent = label; tab.dataset.tab = id; tab.setAttribute('role', 'tab');
      tab.id = `project-information-${id}-${crypto.randomUUID()}`; panel.id = `${tab.id}-panel`;
      tab.setAttribute('aria-controls', panel.id); panel.setAttribute('aria-labelledby', tab.id); panel.setAttribute('role', 'tabpanel');
      tab.onclick = () => {
        overview.hidden = id !== 'overview'; databases.hidden = id !== 'databases';
        for (const item of tabs) { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1; }
        if (id === 'databases' && !mounted) { mounted = true; this.disposeProject = this.databases!.mount(databases, project); }
      };
      tabs.push(tab); navigation.append(tab);
    }
    navigation.onkeydown = event => {
      const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length : undefined;
      if (index !== undefined) { event.preventDefault(); tabs[index]!.click(); tabs[index]!.focus(); }
    };
    this.body.append(navigation, overview, databases);
    for (const section of projectInformation(project)) {
      const details = document.createElement('details'); details.className = 'project-information-section'; details.open = !!section.expanded;
      const summary = document.createElement('summary'); summary.innerHTML = `${iconHtml('chevron-right')}<span>${escapeHtml(section.title)}</span>`;
      const list = document.createElement('dl');
      for (const row of section.rows) {
        const label = document.createElement('dt'), value = document.createElement('dd'); label.textContent = row.label; value.textContent = row.value;
        if (row.avatarUrl) { const icon = document.createElement('img'); icon.src = row.avatarUrl; icon.alt = ''; icon.className = 'entry-information-icon'; label.prepend(icon); }
        list.append(label, value);
      }
      details.append(summary, list); overview.append(details);
    }
    (tabs.find(tab => tab.dataset.tab === initialTab) ?? tabs[0])!.click();
  }

  permissions(parameters: Parameters, policies: ToolPolicies, changed: (policies: ToolPolicies) => void): void {
    this.show(t("Tools and skills"));
    this.body.append(toolsAndSkills(parameters.tools ?? [], policies, changed, this.toolSections));
  }

  usage(load: (requestId: string) => void): void {
    this.show(t("AI usage")); this.usageOpen = true;
    const refresh = this.refresh = iconButton('refresh', t("Refresh usage"), () => this.loadUsage(load));
    this.dialog.querySelector('header')!.insertBefore(refresh, this.dialog.querySelector('header > button:last-child'));
    this.loadUsage(load);
  }
  private loadUsage(load: (requestId: string) => void): void {
    this.body.innerHTML = `<div class="usage-status" role="status">${iconHtml('loading')}<span>${t("Loading usage...")}</span></div>`;
    this.body.setAttribute('aria-busy', 'true'); if (this.refresh) { this.refresh.disabled = true; }
    this.usageRequestId = crypto.randomUUID(); load(this.usageRequestId);
  }
  usageResult(requestId: string | undefined, data?: SystemAiUsage, error?: string): void {
    if (!this.usageOpen || requestId !== this.usageRequestId) { return; }
    this.body.replaceChildren();
    this.body.setAttribute('aria-busy', 'false'); if (this.refresh) { this.refresh.disabled = false; }
    if (error || !data) {
      const status = document.createElement('p'); status.className = error ? 'error usage-status' : 'usage-status'; status.setAttribute('role', error ? 'alert' : 'status'); status.textContent = error || t("Usage unavailable"); this.body.append(status); return;
    }
    const balance = document.createElement('div'); balance.className = 'usage-balance';
    balance.innerHTML = `<span>${t("Account balance")}</span><strong>${escapeHtml(usageAmount(data.balance))}</strong><small>USD</small>`; this.body.append(balance);
    const plans = data.groups.filter((group) => group.subscriptionType === 'subscription' && group.subscription?.status === 'active');
    if (!plans.length) { const empty = document.createElement('p'); empty.className = 'usage-status'; empty.textContent = t("No active subscriptions"); this.body.append(empty); }
    for (const plan of plans) {
      const section = document.createElement('section'); section.className = 'usage-plan'; const title = document.createElement('h3'); title.textContent = plan.name; section.append(title);
      for (const period of usagePeriods(plan.subscription!)) {
        const row = document.createElement('div'); row.className = 'usage-period'; row.dataset.status = period.status;
        const used = period.used === undefined ? t("Not available") : usageAmount(period.used);
        const limit = period.limit === null ? t("Unlimited") : period.limit === undefined ? t("Not available") : usageAmount(period.limit);
        row.innerHTML = `<div class="usage-period-heading"><span>${period.label}</span><strong>${period.ratio === undefined ? escapeHtml(limit) : `${Math.round(period.ratio * 100)}%`}</strong></div><div class="usage-period-amount"><strong>${escapeHtml(used)}</strong><span>/ ${escapeHtml(limit)}</span></div>`;
        if (period.ratio !== undefined) {
          const progress = document.createElement('progress'); progress.max = 1; progress.value = Math.min(1, period.ratio); progress.ariaLabel = t("{0} usage", period.label); row.append(progress);
        }
        const remaining = document.createElement('span'); remaining.className = 'usage-period-remaining';
        remaining.textContent = period.status === 'exhausted' ? t("Limit reached") : period.remaining === undefined ? t("Used") : t("{0} remaining", usageAmount(period.remaining)); row.append(remaining);
        section.append(row);
      }
      this.body.append(section);
    }
  }
}
