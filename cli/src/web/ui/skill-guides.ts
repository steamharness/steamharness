import type { AgentSkillGuide, AgentSkillPreview } from 'steamharness';
import { t } from '../localization';
import { iconButton, iconHtml, markdownHtml } from './ui';
import './tools-and-skills.css';

export interface SkillGuidesLoader { load(requestId: string, skillId?: string): void }

/** A read-only catalog and document viewer. The host resolves catalog IDs, never UI paths. */
export class SkillGuides {
  readonly element = document.createElement('div');
  private readonly catalog = document.createElement('div');
  private readonly detail = document.createElement('div');
  private readonly previewBody = document.createElement('div');
  private readonly list = document.createElement('ul');
  private readonly status = document.createElement('div');
  private readonly search = document.createElement('input');
  private readonly count = document.createElement('span');
  private readonly refresh: HTMLButtonElement;
  private guides: AgentSkillGuide[] = [];
  private requestId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private retry?: () => void;
  private selected?: string;
  private opener?: HTMLButtonElement;
  private scroll = 0;
  private disposed = false;

  constructor(private readonly loader?: SkillGuidesLoader) {
    this.element.className = 'skill-guides'; this.catalog.className = 'skill-catalog'; this.detail.className = 'skill-preview'; this.detail.hidden = true;
    this.previewBody.className = 'skill-preview-body';
    const toolbar = document.createElement('div'); toolbar.className = 'skill-catalog-toolbar';
    const search = document.createElement('label'); search.className = 'skill-search'; search.innerHTML = iconHtml('search');
    this.search.type = 'search'; this.search.placeholder = t('Search skills'); this.search.ariaLabel = t('Search skills');
    this.search.oninput = () => this.renderList(); search.append(this.search);
    this.count.className = 'skill-count'; this.count.role = 'status';
    this.refresh = iconButton('refresh', t('Refresh skills'), () => this.activate());
    this.refresh.disabled = !loader;
    toolbar.append(search, this.count, this.refresh); this.list.className = 'skill-guide-list';
    this.status.className = 'skill-status'; this.status.setAttribute('aria-live', 'polite'); this.status.hidden = true;
    this.catalog.append(toolbar, this.list); this.element.append(this.catalog, this.detail, this.status);
  }

  activate(): void {
    if (!this.loader) { this.showStatus(t('Skill preview is unavailable. Update the project runtime.')); return; }
    this.catalog.hidden = false; this.detail.hidden = true; this.selected = undefined;
    this.request(() => this.activate());
  }

  dispose(): void { this.disposed = true; this.cancel(); }

  result(requestId: string | undefined, value?: AgentSkillGuide[] | AgentSkillPreview, error?: string): void {
    if (this.disposed || !this.requestId || requestId !== this.requestId) return;
    this.cancel();
    if (error || !value) { this.showStatus(error || t('Skill preview is unavailable. Update the project runtime.'), true); return; }
    if (this.selected) {
      if (Array.isArray(value) || value.skill.id !== this.selected) return;
      this.renderPreview(value);
    } else {
      if (!Array.isArray(value)) return;
      this.guides = value; this.renderList();
    }
  }

  private cancel(): void {
    this.requestId = undefined; clearTimeout(this.timer); this.timer = undefined;
    this.element.setAttribute('aria-busy', 'false'); this.refresh.disabled = false;
  }

  private request(retry: () => void, skillId?: string): void {
    this.cancel(); this.retry = retry; this.requestId = crypto.randomUUID(); this.refresh.disabled = true;
    this.element.setAttribute('aria-busy', 'true'); this.showStatus(t('Loading...'));
    const id = this.requestId;
    this.timer = setTimeout(() => this.result(id, undefined, t('The request timed out. Check the current status.')), 40_000);
    try { this.loader!.load(id, skillId); } catch (error) { this.result(id, undefined, String(error)); }
  }

  private showStatus(text: string, error = false): void {
    (this.selected ? this.previewBody : this.element).append(this.status);
    this.status.hidden = false; this.status.replaceChildren(); this.status.setAttribute('role', error ? 'alert' : 'status');
    const message = document.createElement('p'); message.textContent = text; this.status.append(message);
    if (error && this.retry) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = t('Retry'); retry.onclick = this.retry; this.status.append(retry);
    }
  }

  private renderList(): void {
    if (this.requestId) return;
    this.status.hidden = true; this.list.replaceChildren();
    const query = this.search.value.trim().toLocaleLowerCase();
    const guides = this.guides.filter(guide => `${guide.name} ${guide.description} ${this.source(guide)}`.toLocaleLowerCase().includes(query));
    this.count.textContent = query ? t('{0} of {1} skills', guides.length, this.guides.length) : t('{0} skills', this.guides.length);
    if (!guides.length) this.showStatus(t(this.guides.length ? 'No matching skills' : 'No skills available to this entry'));
    for (const guide of guides) {
      const item = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'skill-guide'; button.setAttribute('aria-label', t('Preview {0}', guide.name));
      const icon = document.createElement('span'); icon.className = 'skill-guide-icon'; icon.innerHTML = iconHtml('book');
      const text = document.createElement('span'); text.className = 'skill-guide-text';
      const heading = document.createElement('span'); heading.className = 'skill-guide-heading';
      const title = document.createElement('strong'); title.textContent = guide.name;
      const badge = document.createElement('span'); badge.className = 'skill-guide-badge'; badge.textContent = this.source(guide);
      heading.append(title, badge); text.append(heading);
      if (guide.description) { const description = document.createElement('span'); description.className = 'skill-guide-description'; description.textContent = guide.description; text.append(description); }
      const action = document.createElement('span'); action.className = 'skill-guide-open'; action.innerHTML = iconHtml('chevron-right'); action.setAttribute('aria-hidden', 'true');
      button.append(icon, text, action); button.onclick = () => { this.opener = button; this.open(guide); }; item.append(button); this.list.append(item);
    }
  }

  private source(guide: AgentSkillGuide): string { return t(guide.source === 'builtin' ? 'Core built-in' : 'Project skill'); }

  private open(guide: AgentSkillGuide): void {
    if (!this.selected) this.scroll = this.element.closest('.project-settings-panel')?.scrollTop ?? 0;
    this.selected = guide.id; this.catalog.hidden = true; this.detail.hidden = false;
    this.previewBody.replaceChildren(); this.previewBody.scrollTop = 0;
    this.detail.replaceChildren(this.previewHeader(guide), this.previewBody);
    this.detail.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const panel = this.element.closest('.project-settings-panel'); if (panel) panel.scrollTop = 0;
    this.request(() => this.open(guide), guide.id);
  }

  private previewHeader(guide: AgentSkillGuide): HTMLElement {
    const header = document.createElement('div'); header.className = 'skill-preview-toolbar';
    const back = iconButton('arrow-left', t('Back to skills'), () => {
      this.cancel(); this.selected = undefined; this.detail.hidden = true; this.catalog.hidden = false; this.status.hidden = true;
      const panel = this.element.closest('.project-settings-panel'); if (panel) panel.scrollTop = this.scroll;
      if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    });
    const name = document.createElement('strong'); name.textContent = guide.name;
    const badge = document.createElement('span'); badge.className = 'skill-guide-badge'; badge.textContent = t('Read-only');
    header.append(back, name, badge); return header;
  }

  private renderPreview(preview: AgentSkillPreview): void {
    this.status.hidden = true;
    const meta = document.createElement('p'); meta.className = 'skill-preview-meta'; meta.textContent = `${this.source(preview.skill)} · SKILL.md`;
    const description = document.createElement('p'); description.className = 'skill-preview-description'; description.textContent = preview.skill.description;
    const article = document.createElement('article'); article.className = 'message-content skill-preview-document'; article.tabIndex = 0; article.ariaLabel = t('Skill document');
    article.innerHTML = markdownHtml(preview.content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/u, ''));
    for (const link of article.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = link.getAttribute('href')!;
      if (!/^https?:\/\//i.test(href)) { link.removeAttribute('href'); continue; }
      link.target = '_blank'; link.rel = 'noopener noreferrer';
    }
    // A relative image must never turn into an authenticated request to this project's host.
    for (const img of article.querySelectorAll<HTMLImageElement>('img[src]')) if (!/^https?:\/\//i.test(img.getAttribute('src')!)) img.removeAttribute('src');
    const source = document.createElement('pre'); source.className = 'skill-preview-source'; source.tabIndex = 0; source.textContent = preview.content; source.hidden = true;
    const tabs = document.createElement('div'); tabs.className = 'skill-preview-modes'; tabs.setAttribute('role', 'group'); tabs.ariaLabel = t('Skill document');
    for (const [label, raw] of [['Preview', false], ['Markdown source', true]] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = t(label); button.setAttribute('aria-pressed', String(!raw));
      button.onclick = () => { article.hidden = raw; source.hidden = !raw; for (const sibling of tabs.children) sibling.setAttribute('aria-pressed', String(sibling === button)); };
      tabs.append(button);
    }
    this.previewBody.append(meta, description, tabs, article, source);
  }
}
