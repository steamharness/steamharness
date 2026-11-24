import { t, locale } from '../localization';
import { requestAction } from './action-dialog';
import { requestBotArtifact } from './connection';
import { iconButton, iconHtml } from './ui';
import type { OutputItem } from '../workflow-types';
import './bot-artifacts.css';

export type ArtifactAvailability = 'ready' | 'upgrade';
type Artifact = { id: string; title: string; name: string; size: number; createdAt: string; conversationId?: string; preview?: 'text' | 'image' | null };
const validId = (id: unknown): id is string => typeof id === 'string' && /^ba_[a-f0-9]{32}$/u.test(id);
const fileSize = (size: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(size < 1024 ? size : size < 1048576 ? size / 1024 : size / 1048576)
  + (size < 1024 ? ' B' : size < 1048576 ? ' KiB' : ' MiB');
function detail(value: string, className = ''): HTMLElement {
  const element = document.createElement('span'); element.className = className; element.textContent = value; return element;
}

export class BotArtifactLibrary {
  private availability?: ArtifactAvailability;
  private removalRevision?: number;
  private readonly dialog = document.createElement('dialog');
  private readonly title = document.createElement('h2');
  private readonly identity = document.createElement('p');
  private readonly rows = document.createElement('ul');
  private readonly status = document.createElement('p');
  private readonly preview = document.createElement('div');
  private readonly refresh: HTMLButtonElement;
  private readonly more = document.createElement('button');
  private request?: AbortController;
  private previewRequest?: AbortController;
  private previewUrl?: string;
  private next?: number;
  private opener?: HTMLElement;

  constructor(private readonly options: { navigate(id: string, artifact: string): void }) {
    this.dialog.className = 'conversation-dialog bot-artifact-library';
    this.title.id = 'bot-artifact-title'; this.dialog.setAttribute('aria-labelledby', this.title.id);
    const header = document.createElement('header');
    this.refresh = iconButton('refresh', t('Refresh'), () => { void this.page(); });
    header.append(this.title, this.refresh, iconButton('close', t('Close'), () => this.dialog.close()));
    const body = document.createElement('div'); body.className = 'dialog-body';
    this.identity.className = 'bot-artifact-identity';
    this.rows.className = 'bot-artifact-list';
    this.status.setAttribute('role', 'status'); this.status.className = 'bot-artifact-status';
    this.preview.className = 'bot-artifact-preview'; this.preview.hidden = true;
    this.more.type = 'button'; this.more.className = 'bot-artifact-more'; this.more.addEventListener('click', () => { if (this.next) void this.page(this.next); });
    body.append(this.identity, this.preview, this.rows, this.status, this.more);
    this.dialog.append(header, body);
    this.dialog.addEventListener('close', () => {
      if (this.dialog.open) return;
      this.request?.abort(); this.closePreview();
      this.opener?.focus({ preventScroll: true }); this.opener = undefined;
    });
    window.addEventListener('pagehide', () => { this.request?.abort(); this.closePreview(); });
    document.body.append(this.dialog);
  }

  configure(status: ArtifactAvailability | undefined, identity: string, removalRevision?: number): void {
    this.availability = status;
    this.identity.textContent = identity;
    if (status === 'ready' && this.removalRevision !== removalRevision && removalRevision !== undefined) {
      document.querySelectorAll('[data-bot-artifact]').forEach(card => card.dispatchEvent(new Event('bot-artifact-refresh')));
      if (this.dialog.open) void this.page();
    }
    this.removalRevision = removalRevision;
  }

  open(focusId?: string): void {
    this.title.textContent = t('Bot artifact library');
    this.more.textContent = t('Load more');
    this.closePreview();
    this.rows.replaceChildren(); this.next = undefined;
    this.status.textContent = this.availability === 'ready' ? t('Loading artifacts…') : t('Update the project runtime to open its Bot artifact library.');
    this.refresh.disabled = this.availability !== 'ready'; this.more.hidden = true;
    if (!this.dialog.open) {
      if (document.activeElement instanceof HTMLElement) this.opener = document.activeElement;
      this.dialog.showModal();
    }
    if (this.availability !== 'ready') return;
    void this.page();
    if (validId(focusId)) void this.showPreview(focusId);
  }

  card(item: OutputItem, local = true): HTMLElement {
    const root = document.createElement('div'); root.className = 'bot-artifact-card';
    const value = item.content as Partial<Artifact> | undefined;
    if (!local || this.availability !== 'ready' || !validId(value?.id) || typeof value.name !== 'string') { root.hidden = true; return root; }
    const id = value.id;
    root.dataset.botArtifact = id;
    root.tabIndex = -1;
    const icon = detail('', 'bot-artifact-icon'); icon.innerHTML = iconHtml('file'); icon.setAttribute('aria-hidden', 'true');
    const name = detail(item.title || value.name, 'bot-artifact-filename');
    const controls = detail('', 'bot-artifact-actions');
    const view = iconButton('preview', t('Open artifact'), () => this.open(id));
    const state = detail('', 'bot-artifact-description'); state.setAttribute('aria-live', 'polite');
    controls.append(view, this.download(id, value.name, text => { state.textContent = text; })); controls.hidden = true;
    root.append(icon, name, state, controls);
    let withdrawn = false;
    const removed = () => { withdrawn = true; state.textContent = t('Artifact removed'); controls.hidden = true; };
    root.addEventListener('bot-artifact-removed', removed);
    const validate = () => void requestBotArtifact(`/${id}`).then(response => {
      if (withdrawn) return;
      if (response.status === 404) removed();
      else if (response.ok) { state.textContent = fileSize(Number(value.size) || 0); controls.hidden = false; }
      else state.textContent = t('Artifact unavailable');
    }, () => { state.textContent = t('Artifact unavailable'); });
    root.addEventListener('bot-artifact-refresh', validate);
    validate();
    return root;
  }

  private download(id: string, name: string, error = (text: string) => { this.status.textContent = text; }): HTMLButtonElement {
    const button = iconButton('cloud-download', t('Download'), async () => {
      button.disabled = true;
      try {
        const response = await requestBotArtifact(`/${id}/content`);
        if (response.status === 404) { error(t('Artifact removed')); return; }
        if (!response.ok) throw new Error();
        const urls = URL;
        const url = urls.createObjectURL(await response.blob());
        const link = document.createElement('a'); link.href = url; link.download = name; link.click();
        setTimeout(() => urls.revokeObjectURL(url), 1_000);
      } catch { error(t('Artifact unavailable')); }
      finally { button.disabled = false; }
    });
    return button;
  }

  private async page(before?: number): Promise<void> {
    if (this.availability !== 'ready') return;
    this.request?.abort();
    const request = this.request = new AbortController();
    this.refresh.disabled = this.more.disabled = true;
    this.status.textContent = t('Loading artifacts…');
    try {
      const response = await requestBotArtifact(before ? `?before=${before}` : '', { signal: request.signal });
      if (!response.ok) throw new Error();
      const page = await response.json() as { artifacts: Artifact[]; nextBefore?: number };
      if (request.signal.aborted) return;
      const rows = page.artifacts.filter(item => validId(item.id)).map(item => this.row(item));
      if (before) this.rows.append(...rows); else this.rows.replaceChildren(...rows);
      this.next = page.nextBefore; this.more.hidden = this.next === undefined;
      this.status.textContent = this.rows.children.length ? '' : t('No artifacts delivered yet.');
    } catch {
      if (!request.signal.aborted) this.status.textContent = t('Could not load Bot artifacts.');
    } finally {
      if (this.request === request) { this.refresh.disabled = this.more.disabled = false; }
    }
  }

  private row(item: Artifact): HTMLLIElement {
    const row = document.createElement('li'); row.className = 'bot-artifact-row';
    const label = document.createElement('div'); label.className = 'bot-artifact-label';
    label.append(detail(item.title, 'bot-artifact-filename'));
    const date = new Date(item.createdAt);
    label.append(detail(`${item.title !== item.name ? `${item.name} · ` : ''}${fileSize(item.size)} · ${date.toLocaleString(locale())}`, 'bot-artifact-description'));
    const actions = detail('', 'bot-artifact-actions');
    const source = iconButton('go-to-file', t('Open source conversation'), () => {
      if (!item.conversationId) return;
      this.opener = undefined;
      this.dialog.close();
      this.options.navigate(item.conversationId, item.id);
    });
    if (!item.conversationId) { source.disabled = true; source.title = t('Source conversation unavailable'); }
    actions.append(iconButton('preview', t('Open artifact'), () => { void this.showPreview(item.id); }), this.download(item.id, item.name), source,
      iconButton('trash', t('Remove delivery'), () => { void this.remove(item); }));
    row.append(label, actions); return row;
  }

  private async showPreview(id: string): Promise<void> {
    this.closePreview();
    const request = this.previewRequest = new AbortController();
    this.preview.hidden = false;
    this.preview.replaceChildren(detail(t('Loading artifacts…')));
    try {
      const response = await requestBotArtifact(`/${id}`, { signal: request.signal });
      if (request.signal.aborted) return;
      if (response.status === 404) { this.preview.replaceChildren(detail(t('Artifact removed'))); return; }
      if (!response.ok) throw new Error();
      const item = await response.json() as Artifact;
      if (request.signal.aborted) return;
      const header = document.createElement('header'); header.append(detail(item.title, 'bot-artifact-filename'), this.download(id, item.name),
        iconButton('close', t('Close preview'), () => this.closePreview()));
      const content = document.createElement('div');
      this.preview.replaceChildren(header, content);
      if (item.preview === 'image') {
        const bytes = await requestBotArtifact(`/${id}/content?preview=1`, { signal: request.signal });
        if (!bytes.ok) throw new Error();
        const blob = await bytes.blob(); if (request.signal.aborted) return;
        const image = document.createElement('img'); image.src = this.previewUrl = URL.createObjectURL(blob); image.alt = item.name;
        image.addEventListener('error', () => content.replaceChildren(detail(t('Preview is unavailable. Download the file to open it.'))), { once: true });
        content.append(image);
      } else if (item.preview === 'text') {
        const bytes = await requestBotArtifact(`/${id}/content?preview=1`, { signal: request.signal });
        if (!bytes.ok) throw new Error();
        const text = await bytes.text(); if (request.signal.aborted) return;
        const pre = document.createElement('pre'); pre.textContent = text; content.append(pre);
        if (bytes.headers.get('X-SteamHarness-Preview-Truncated')) content.append(detail(t('Preview truncated. Download the file for the full content.'), 'bot-artifact-description'));
      } else content.append(detail(t('Preview is unavailable. Download the file to open it.')));
    } catch { if (!request.signal.aborted) this.preview.replaceChildren(detail(t('Artifact unavailable'))); }
  }

  private closePreview(): void {
    this.previewRequest?.abort();
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = undefined;
    this.preview.replaceChildren(); this.preview.hidden = true;
  }

  private async remove(item: Artifact): Promise<void> {
    const confirmed = await requestAction({ title: t('Remove delivery'), confirm: t('Remove delivery'),
      description: t('Remove the delivered copy of {0}? The source file will be kept.', item.name), danger: true });
    if (confirmed === undefined || !this.dialog.open) return;
    try {
      const response = await requestBotArtifact(`/${item.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      this.closePreview();
      document.querySelectorAll(`[data-bot-artifact="${item.id}"]`).forEach(card => card.dispatchEvent(new Event('bot-artifact-removed')));
      if (this.dialog.open) await this.page();
    } catch { this.status.textContent = t('Could not remove the delivered copy.'); }
  }
}
