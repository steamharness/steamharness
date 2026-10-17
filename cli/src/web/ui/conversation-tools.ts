import { t } from '../localization';
import type { WorkflowParameters, WorkflowToolPolicies, WorkflowProject } from '../workflow-types';
import type { WorkflowSystemAiUsage } from '../workflow-auth-client';
import { iconButton, markdownHtml, iconHtml, escapeHtml } from './ui';
import { projectInformation } from './project-information';
import { usageAmount, usagePeriods } from './ai-usage';
import { imagePreview } from './image-preview';

export class ConversationTools {
  private readonly dialog = document.createElement('dialog');
  private readonly body = document.createElement('div');
  private readonly title = document.createElement('h2');
  private usageOpen = false;
  private usageRequestId?: string;
  private refresh?: HTMLButtonElement;
  private disposeImage?: () => void;
  constructor() {
    this.dialog.className = 'conversation-dialog';
    this.title.id = 'conversation-dialog-title'; this.dialog.setAttribute('aria-labelledby', this.title.id);
    const header = document.createElement('header'); header.append(this.title, iconButton('close', t("Close"), () => this.close()));
    this.body.className = 'dialog-body'; this.dialog.append(header, this.body); document.body.append(this.dialog);
    this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) { const rect = this.dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { this.close(); } } });
    this.dialog.addEventListener('cancel', () => this.close());
  }
  get open(): boolean { return this.dialog.open; }
  close(): void { this.dialog.close(); this.disposeImage?.(); this.disposeImage = undefined; this.usageOpen = false; this.usageRequestId = undefined; this.refresh?.remove(); this.refresh = undefined; }
  closeUsage(): void { if (this.usageOpen) { this.close(); } }
  private show(title: string): void { this.close(); this.dialog.classList.remove('image-dialog'); this.title.textContent = title; this.body.replaceChildren(); this.body.setAttribute('aria-busy', 'false'); this.dialog.showModal(); }

  plan(content: string): void {
    this.show(t("Plan")); const article = document.createElement('article'); article.className = 'message-content'; article.innerHTML = markdownHtml(content); this.body.append(article);
  }

  image(src: string, title: string): void {
    this.show(title || t("Image")); this.dialog.classList.add('image-dialog');
    const preview = imagePreview(src, title); this.disposeImage = preview.dispose; this.body.append(preview.element);
    this.body.querySelector<HTMLElement>('.image-preview-viewport')!.focus({ preventScroll: true });
  }

  projectInfo(project: WorkflowProject): void {
    this.show(t("Project information"));
    const heading = document.createElement('h3'); heading.className = 'project-information-name'; heading.textContent = project.name;
    this.body.append(heading);
    if (project.manifest?.description) {
      const description = document.createElement('p'); description.className = 'project-information-description'; description.textContent = project.manifest.description; this.body.append(description);
    }
    for (const section of projectInformation(project)) {
      const details = document.createElement('details'); details.className = 'project-information-section'; details.open = !!section.expanded;
      const summary = document.createElement('summary'); summary.innerHTML = `${iconHtml('chevron-right')}<span>${escapeHtml(section.title)}</span>`;
      const list = document.createElement('dl');
      for (const row of section.rows) {
        const label = document.createElement('dt'), value = document.createElement('dd'); label.textContent = row.label; value.textContent = row.value; list.append(label, value);
      }
      details.append(summary, list); this.body.append(details);
    }
  }

  permissions(parameters: WorkflowParameters, policies: WorkflowToolPolicies, changed: (policies: WorkflowToolPolicies) => void): void {
    this.show(t("Tool permissions"));
    const tools = parameters.tools ?? [];
    const count = document.createElement('p'); count.className = 'tool-count'; count.textContent = t("{0} tools", tools.length); this.body.append(count);
    const table = document.createElement('table'); table.className = 'permissions-table';
    table.innerHTML = `<thead><tr><th>${t("Tool")}</th><th>${t("Enable")}</th><th>${t("Auto-approve")}</th></tr></thead>`;
    const body = document.createElement('tbody'); const draft: WorkflowToolPolicies = {};
    for (const tool of tools) {
      draft[tool.name] = { enabled: policies[tool.name]?.enabled ?? tool.enabled ?? true, autoApprove: policies[tool.name]?.autoApprove ?? tool.autoApprove ?? false };
      const row = document.createElement('tr'); const label = document.createElement('td'); label.textContent = tool.label || tool.name;
      label.title = tool.description || tool.name; row.append(label);
      for (const property of ['enabled', 'autoApprove'] as const) {
        const cell = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = draft[tool.name][property]!;
        checkbox.ariaLabel = `${tool.label || tool.name} ${property === 'enabled' ? t("Enable") : t("Auto-approve")}`;
        checkbox.addEventListener('change', () => { draft[tool.name][property] = checkbox.checked; changed(draft); });
        cell.append(checkbox); row.append(cell);
      }
      body.append(row);
    }
    table.append(body); this.body.append(table);
    if (!tools.length) { const empty = document.createElement('p'); empty.textContent = t("No tools declared by this project"); this.body.append(empty); }
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
  usageResult(requestId: string | undefined, data?: WorkflowSystemAiUsage, error?: string): void {
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
