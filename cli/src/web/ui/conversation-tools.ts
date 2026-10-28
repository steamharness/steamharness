import { t } from '../localization';
import type { Parameters, ToolPolicies, Project } from '../workflow-types';
import type { SystemAiUsage } from '../workflow-auth-client';
import { iconButton, markdownHtml, iconHtml, escapeHtml } from './ui';
import { projectInformation } from './project-information';
import { usageAmount, usagePeriods } from './ai-usage';
import { imagePreview } from './image-preview';
import { toolsAndSkills } from './tools-and-skills';
import type { ProjectDatabases } from './project-databases';
import type { ProjectConfigurationsPanel } from './project-configurations';
import './project-databases.css';
import './project-settings.css';

export type ProjectSettingsSection = 'overview' | 'configurations' | 'tools' | 'skills' | 'usage' | 'databases';
export interface ProjectSettingsOptions {
  configurations?: ProjectConfigurationsPanel;
  tools?(): { parameters: Parameters; policies: ToolPolicies; changed(policies: ToolPolicies): void; readOnly?: boolean };
  usage?: { available(): boolean; load(requestId: string): void };
}

export class ConversationTools {
  private readonly dialog = document.createElement('dialog');
  private readonly body = document.createElement('div');
  private readonly title = document.createElement('h2');
  private usageOpen = false;
  private usageRequestId?: string;
  private usageTimer?: ReturnType<typeof setTimeout>;
  private refresh?: HTMLButtonElement;
  private disposeImage?: () => void;
  private disposeProject?: () => void;
  private disposeNavigation?: () => void;
  private refreshTools?: (tools: ReturnType<NonNullable<ProjectSettingsOptions['tools']>>) => void;
  private settingsProject?: string;
  private selectSection?: (section: ProjectSettingsSection) => void;
  private section?: ProjectSettingsSection;
  private usageBody?: HTMLElement;
  private opener?: HTMLElement;
  private readonly toolSections = new Map<string, boolean>();
  constructor(private readonly databases?: ProjectDatabases, private readonly settings: ProjectSettingsOptions = {}) {
    this.dialog.id = 'project-information-dialog'; this.dialog.className = 'conversation-dialog';
    this.title.id = 'conversation-dialog-title'; this.dialog.setAttribute('aria-labelledby', this.title.id);
    const header = document.createElement('header'); header.append(this.title, iconButton('close', t("Close"), () => this.close()));
    this.body.className = 'dialog-body'; this.dialog.append(header, this.body); document.body.append(this.dialog);
    this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) { const rect = this.dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { this.close(); } } });
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.cleanup(); });
  }
  get open(): boolean { return this.dialog.open; }
  get activeSection(): ProjectSettingsSection | undefined { return this.open ? this.section : undefined; }
  private cleanup(): void {
    this.disposeImage?.(); this.disposeImage = undefined; this.disposeProject?.(); this.disposeProject = undefined;
    this.disposeNavigation?.(); this.disposeNavigation = undefined; this.refreshTools = undefined;
    this.settings.configurations?.deactivate(); this.usageOpen = false; this.usageRequestId = undefined; this.usageBody = undefined;
    clearTimeout(this.usageTimer); this.usageTimer = undefined;
    this.refresh = undefined; this.selectSection = undefined; this.section = undefined; this.settingsProject = undefined;
    const opener = this.opener; this.opener = undefined; if (opener?.isConnected) opener.focus({ preventScroll: true });
  }
  close(): void { if (this.dialog.open) this.dialog.close(); this.cleanup(); }
  closeUsage(): void { if (this.usageBody) this.close(); }
  updatePermissions(): void {
    if (!this.open || !this.settings.tools) return;
    this.refreshTools?.(this.settings.tools());
  }
  private show(title: string): void {
    const opener = this.open ? this.opener : document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.close(); this.opener = opener; this.dialog.classList.remove('image-dialog', 'project-information-dialog');
    this.title.textContent = title; this.body.replaceChildren(); this.body.setAttribute('aria-busy', 'false'); this.dialog.showModal();
  }

  plan(content: string): void {
    this.show(t("Plan")); const article = document.createElement('article'); article.className = 'message-content'; article.innerHTML = markdownHtml(content); this.body.append(article);
  }

  image(src: string, title: string): void {
    this.show(title || t("Image")); this.dialog.classList.add('image-dialog');
    const preview = imagePreview(src, title); this.disposeImage = preview.dispose; this.body.append(preview.element);
    this.body.querySelector<HTMLElement>('.image-preview-viewport')!.focus({ preventScroll: true });
  }

  projectInfo(project: Project, initialTab: ProjectSettingsSection = 'overview'): void {
    const key = `${project.uri}:${project.entryId}`;
    if (this.open && this.settingsProject === key && this.selectSection) { this.selectSection(initialTab); return; }
    this.showSettings(project, initialTab, this.settings.tools?.()); this.settingsProject = key;
  }

  private overview(project: Project): HTMLElement {
    const overview = document.createElement('div'); overview.className = 'project-settings-overview';
    const identity = document.createElement('div'); identity.className = 'project-settings-identity';
    identity.innerHTML = iconHtml('package');
    const text = document.createElement('div');
    const heading = document.createElement('h3'); heading.className = 'project-information-name'; heading.textContent = project.aggregateName;
    text.append(heading);
    if (project.manifest?.description) {
      const description = document.createElement('p'); description.className = 'project-information-description'; description.textContent = project.manifest.description; text.append(description);
    }
    identity.append(text); overview.append(identity);
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
    return overview;
  }

  permissions(parameters: Parameters, policies: ToolPolicies, changed: (policies: ToolPolicies) => void): void {
    const tools = parameters.tools ?? [];
    this.showSettings(undefined, tools.length && tools.every(tool => tool.name === 'skill') ? 'skills' : 'tools', { parameters, policies, changed });
  }

  private showSettings(project: Project | undefined, initialTab: ProjectSettingsSection, tools?: ReturnType<NonNullable<ProjectSettingsOptions['tools']>>): void {
    this.show(t('Project information')); this.dialog.classList.add('project-information-dialog');
    this.title.prepend(document.createRange().createContextualFragment(iconHtml('package')));
    const navigation = document.createElement('nav'); navigation.className = 'project-information-tabs';
    navigation.setAttribute('role', 'tablist'); navigation.ariaLabel = t('Project information');
    const narrow = window.matchMedia?.('(max-width: 680px)');
    const orientation = () => navigation.setAttribute('aria-orientation', narrow?.matches ? 'horizontal' : 'vertical');
    orientation(); narrow?.addEventListener?.('change', orientation);
    this.disposeNavigation = () => narrow?.removeEventListener?.('change', orientation);
    const content = document.createElement('div'); content.className = 'project-settings-content';
    const tabs: { id: ProjectSettingsSection; tab: HTMLButtonElement; panel: HTMLElement; activate?: () => void; mounted: boolean }[] = [];
    const add = (id: ProjectSettingsSection, label: string, icon: string, description: string, child?: HTMLElement, activate?: () => void) => {
      const tab = document.createElement('button'); tab.type = 'button'; tab.dataset.tab = id; tab.title = label; tab.setAttribute('role', 'tab');
      tab.innerHTML = iconHtml(icon); const name = document.createElement('span'); name.textContent = label; tab.append(name);
      tab.id = `project-information-${id}-${crypto.randomUUID()}`;
      const panel = document.createElement('section'); panel.className = 'project-settings-panel'; panel.dataset.section = id; panel.id = `${tab.id}-panel`;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0; tab.setAttribute('aria-controls', panel.id);
      const heading = document.createElement('div'); heading.className = 'project-settings-heading';
      const title = document.createElement('h3'); title.textContent = label;
      const hint = document.createElement('p'); hint.textContent = description; heading.append(title, hint); panel.append(heading);
      if (child) panel.append(child);
      tabs.push({ id, tab, panel, activate, mounted: false }); navigation.append(tab); content.append(panel);
      tab.onclick = () => this.selectSection?.(id);
    };
    if (project) add('overview', t('Overview'), 'info', t('Project details, declarations and entry windows.'), this.overview(project));
    if (project && this.settings.configurations) {
      const configurations = this.settings.configurations;
      add('configurations', t('Project configurations'), 'settings-gear', t('Manage configuration profiles, values and publication permissions.'), configurations.element, () => configurations.activate());
    }
    if (tools) {
      const changed = (policies: ToolPolicies) => {
        const current = this.settings.tools?.() ?? tools;
        if (!current.readOnly) current.changed(policies);
      };
      let catalog = JSON.stringify(tools.parameters.tools ?? []);
      let panels = toolsAndSkills(tools.parameters.tools ?? [], tools.policies, changed, this.toolSections);
      panels.update(tools.policies, !!tools.readOnly);
      add('tools', t('Tools'), 'wrench', t('Control which tools can run and which actions need approval.'), panels.tools);
      add('skills', t('Skills'), 'book', t('Read the guides available to this entry. Skills have no permission switches.'), panels.skills);
      this.refreshTools = current => {
        const nextCatalog = JSON.stringify(current.parameters.tools ?? []);
        if (catalog !== nextCatalog) {
          const search = panels.tools.querySelector<HTMLInputElement>('[type=search]');
          const focused = panels.tools.contains(document.activeElement), label = document.activeElement?.getAttribute('aria-label');
          const scroll = panels.tools.parentElement!.scrollTop;
          if (!search?.value.trim()) for (const section of panels.tools.querySelectorAll<HTMLDetailsElement>('details[data-group]')) this.toolSections.set(section.dataset.group!, section.open);
          const next = toolsAndSkills(current.parameters.tools ?? [], current.policies, changed, this.toolSections);
          next.update(current.policies, !!current.readOnly);
          if (search) {
            const input = next.tools.querySelector<HTMLInputElement>('[type=search]');
            if (input) { input.value = search.value; input.dispatchEvent(new Event('input')); }
          }
          panels.tools.replaceWith(next.tools); panels.skills.replaceWith(next.skills); panels = next; catalog = nextCatalog;
          if (focused) ([...panels.tools.querySelectorAll<HTMLElement>('[aria-label]:not(:disabled)')].find(control => control.getAttribute('aria-label') === label) ?? panels.tools.closest<HTMLElement>('[role=tabpanel]'))?.focus({ preventScroll: true });
          panels.tools.parentElement!.scrollTop = scroll;
        }
        panels.update(current.policies, !!current.readOnly);
      };
    }
    const usage = this.settings.usage;
    if (project && usage?.available()) {
      const container = document.createElement('div'); container.className = 'project-settings-usage';
      const toolbar = document.createElement('div'); toolbar.className = 'project-settings-actions';
      const refresh = this.refresh = iconButton('refresh', t('Refresh usage'), () => this.loadUsage(usage.load));
      toolbar.append(refresh); this.usageBody = document.createElement('div'); container.append(toolbar, this.usageBody);
      add('usage', t('AI usage'), 'graph', t('Account balance and current subscription usage.'), container, () => { this.usageOpen = true; this.loadUsage(usage.load); });
    }
    if (project && this.databases) {
      const container = document.createElement('div');
      add('databases', t('Databases'), 'database', t('Linked databases and the entries that use them.'), container, () => { this.disposeProject = this.databases!.mount(container, project); });
    }
    this.selectSection = id => {
      const selected = tabs.find(item => item.id === id) ?? tabs[0]; if (!selected) return;
      if (this.section === 'configurations' && selected.id !== this.section) this.settings.configurations?.deactivate();
      this.section = selected.id;
      for (const item of tabs) {
        const active = item === selected; item.tab.setAttribute('aria-selected', String(active)); item.tab.tabIndex = active ? 0 : -1; item.panel.hidden = !active;
      }
      if (!selected.mounted) { selected.mounted = true; selected.activate?.(); }
      if (narrow?.matches) selected.tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
    navigation.onkeydown = event => {
      const current = tabs.findIndex(item => item.tab === document.activeElement);
      const forward = narrow?.matches ? 'ArrowRight' : 'ArrowDown', backward = narrow?.matches ? 'ArrowLeft' : 'ArrowUp';
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : event.key === forward ? (current + 1) % tabs.length
        : event.key === backward ? (current - 1 + tabs.length) % tabs.length : undefined;
      if (index !== undefined) { event.preventDefault(); tabs[index]?.tab.click(); tabs[index]?.tab.focus(); }
    };
    this.body.append(navigation, content); this.selectSection(initialTab);
    tabs.find(item => item.id === this.section)?.tab.focus({ preventScroll: true });
  }
  private loadUsage(load: (requestId: string) => void): void {
    if (!this.usageBody) return;
    this.usageBody.innerHTML = `<div class="usage-status" role="status">${iconHtml('loading')}<span>${t("Loading usage...")}</span></div>`;
    this.usageBody.setAttribute('aria-busy', 'true'); if (this.refresh) this.refresh.disabled = true;
    this.usageRequestId = crypto.randomUUID();
    clearTimeout(this.usageTimer);
    this.usageTimer = setTimeout(() => this.usageResult(this.usageRequestId, undefined, t('The request timed out. Check the current status.')), 20_000);
    try { load(this.usageRequestId); } catch (error) { this.usageResult(this.usageRequestId, undefined, String(error)); }
  }
  usageResult(requestId: string | undefined, data?: SystemAiUsage, error?: string): void {
    if (!this.usageOpen || !this.usageBody || requestId !== this.usageRequestId) { return; }
    clearTimeout(this.usageTimer); this.usageTimer = undefined;
    const body = this.usageBody; body.replaceChildren();
    body.setAttribute('aria-busy', 'false'); if (this.refresh) { this.refresh.disabled = false; }
    if (error || !data) {
      const status = document.createElement('p'); status.className = error ? 'error usage-status' : 'usage-status'; status.setAttribute('role', error ? 'alert' : 'status'); status.textContent = error || t("Usage unavailable"); body.append(status); return;
    }
    const balance = document.createElement('div'); balance.className = 'usage-balance';
    balance.innerHTML = `<span>${t("Account balance")}</span><strong>${escapeHtml(usageAmount(data.balance))}</strong><small>USD</small>`; body.append(balance);
    const plans = data.groups.filter((group) => group.subscriptionType === 'subscription' && group.subscription?.status === 'active');
    if (!plans.length) { const empty = document.createElement('p'); empty.className = 'usage-status'; empty.textContent = t("No active subscriptions"); body.append(empty); }
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
      body.append(section);
    }
  }
}
