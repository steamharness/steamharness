import type { Parameters, ToolPolicies } from '../src/workflow-types';
import type { SystemAiUsage } from '../src/workflow-auth-client';
import { iconButton, markdownHtml } from './ui';

export class ConversationTools {
  private readonly dialog = document.createElement('dialog');
  private readonly body = document.createElement('div');
  private readonly title = document.createElement('h2');
  private usageOpen = false;
  private refresh?: HTMLButtonElement;
  constructor() {
    this.dialog.className = 'conversation-dialog';
    const header = document.createElement('header'); header.append(this.title, iconButton('close', '\u5173\u95ed', () => this.close()));
    this.body.className = 'dialog-body'; this.dialog.append(header, this.body); document.body.append(this.dialog);
    this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) { const rect = this.dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { this.close(); } } });
  }
  get open(): boolean { return this.dialog.open; }
  close(): void { this.dialog.close(); this.usageOpen = false; this.refresh?.remove(); this.refresh = undefined; }
  private show(title: string): void { this.close(); this.title.textContent = title; this.body.replaceChildren(); this.dialog.showModal(); }

  plan(content: string): void {
    this.show('\u8ba1\u5212'); const article = document.createElement('article'); article.className = 'message-content'; article.innerHTML = markdownHtml(content); this.body.append(article);
  }

  image(src: string, title: string): void {
    this.show(title || '\u56fe\u7247'); const image = document.createElement('img'); image.src = src; image.alt = title; image.className = 'image-preview'; this.body.append(image);
  }

  permissions(parameters: Parameters, policies: ToolPolicies, changed: (policies: ToolPolicies) => void): void {
    this.show('\u5de5\u5177\u6743\u9650');
    const tools = parameters.tools ?? [];
    const count = document.createElement('p'); count.className = 'tool-count'; count.textContent = `${tools.length} \u4e2a\u5de5\u5177`; this.body.append(count);
    const table = document.createElement('table'); table.className = 'permissions-table';
    table.innerHTML = '<thead><tr><th>\u5de5\u5177</th><th>\u542f\u7528</th><th>\u81ea\u52a8\u6279\u51c6</th></tr></thead>';
    const body = document.createElement('tbody'); const draft: ToolPolicies = {};
    for (const tool of tools) {
      draft[tool.name] = { enabled: policies[tool.name]?.enabled ?? tool.enabled ?? true, autoApprove: policies[tool.name]?.autoApprove ?? tool.autoApprove ?? false };
      const row = document.createElement('tr'); const label = document.createElement('td'); label.textContent = tool.label || tool.name;
      label.title = tool.description || tool.name; row.append(label);
      for (const property of ['enabled', 'autoApprove'] as const) {
        const cell = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = draft[tool.name][property]!;
        checkbox.ariaLabel = `${tool.label || tool.name} ${property === 'enabled' ? '\u542f\u7528' : '\u81ea\u52a8\u6279\u51c6'}`;
        checkbox.addEventListener('change', () => { draft[tool.name][property] = checkbox.checked; changed(draft); });
        cell.append(checkbox); row.append(cell);
      }
      body.append(row);
    }
    table.append(body); this.body.append(table);
    if (!tools.length) { const empty = document.createElement('p'); empty.textContent = '\u9879\u76ee\u672a\u58f0\u660e\u5de5\u5177'; this.body.append(empty); }
  }

  usage(load: () => void): void {
    this.show('\u7cfb\u7edf AI'); this.usageOpen = true;
    const refresh = this.refresh = iconButton('refresh', '\u5237\u65b0\u7528\u91cf', () => { this.body.textContent = '\u52a0\u8f7d\u4e2d...'; load(); });
    this.dialog.querySelector('header')!.insertBefore(refresh, this.dialog.querySelector('header > button:last-child'));
    this.body.textContent = '\u52a0\u8f7d\u4e2d...'; load();
  }
  usageResult(data?: SystemAiUsage, error?: string): void {
    if (!this.usageOpen) { return; }
    this.body.replaceChildren();
    if (error) { this.body.textContent = error; return; }
    if (!data) { return; }
    const balance = document.createElement('p'); balance.textContent = `\u8d26\u6237\u4f59\u989d $${Number(data.balance ?? 0).toFixed(2)}`; this.body.append(balance);
    const labels = { daily: '\u6bcf\u65e5', weekly: '\u6bcf\u5468', monthly: '\u6bcf\u6708' };
    const plans = data.groups.filter((group) => group.subscriptionType === 'subscription' && group.subscription?.status === 'active');
    if (!plans.length) { const empty = document.createElement('p'); empty.textContent = '\u6682\u65e0\u5df2\u8ba2\u9605\u5957\u9910'; this.body.append(empty); }
    for (const plan of plans) {
      const section = document.createElement('section'); section.className = 'usage-plan'; const title = document.createElement('h3'); title.textContent = plan.name; section.append(title);
      for (const period of ['daily', 'weekly', 'monthly'] as const) {
        const limit = plan.subscription![`${period}LimitUsd`]; const used = Number(plan.subscription![`${period}UsageUsd`] ?? 0);
        const row = document.createElement('div'); const label = document.createElement('span'); label.textContent = `${labels[period]} $${used.toFixed(2)} / ${limit === null ? '\u4e0d\u9650' : `$${Number(limit).toFixed(2)}`}`; row.append(label);
        if (limit !== null && limit > 0) { const progress = document.createElement('progress'); progress.max = limit; progress.value = used; row.append(progress); }
        section.append(row);
      }
      this.body.append(section);
    }
  }
}
