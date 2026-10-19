import { locale, t } from '../localization';
import type { ConversationMessage, OutputItem } from '../workflow-types';

interface RingContent { value: number; total?: number; unit?: string }

export function ringOutputContent(item: OutputItem): RingContent | undefined {
  if (item.display?.type !== 'ring' || !item.content || typeof item.content !== 'object') { return; }
  const value = item.content as RingContent;
  if (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0
    || value.total !== undefined && (typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total <= 0)
    || value.unit !== undefined && typeof value.unit !== 'string') { return; }
  return value;
}

export function isComposerOutputItem(item: OutputItem): boolean {
  return !!item.id && item.display?.placement === 'composer-right' && ringOutputContent(item) !== undefined;
}

export function composerOutputItems(messages: ConversationMessage[], outputs: OutputItem[] = []): OutputItem[] {
  const latest = new Map<string, OutputItem>();
  for (const message of messages) {
    if (message.role !== 'assistant') { continue; }
    for (const item of message.items ?? message.report?.output?.items ?? []) {
      if (isComposerOutputItem(item)) { latest.set(item.id!, item); }
      else if (item.id) { latest.delete(item.id); }
    }
  }
  for (const item of outputs) {
    if (isComposerOutputItem(item)) latest.set(item.id!, item);
    else if (item.id) latest.delete(item.id);
  }
  return [...latest.values()];
}

export function ringOutputText(item: OutputItem) {
  const content = ringOutputContent(item);
  if (!content) { return; }
  const used = content.value.toLocaleString(locale());
  const percentage = content.total === undefined ? undefined : Math.round(content.value / content.total * 100);
  const fullness = percentage === undefined ? t('Total unavailable') : content.value > 0 && percentage === 0
    ? t('Less than 1% full') : t('{0}% full', percentage);
  const amount = content.total === undefined ? used : `${used} / ${content.total.toLocaleString(locale())}`;
  const value = content.unit ? t('{0} {1} used', amount, content.unit) : t('{0} used', amount);
  const heading = item.title ?? t('Output');
  return { percentage, fullness, value, heading, label: `${heading}: ${fullness}; ${value}` };
}

let tooltipId = 0;

export class RingOutput {
  private static active?: RingOutput;
  readonly root = document.createElement('span');
  private readonly tooltip = document.createElement('div');
  private readonly heading = document.createElement('span');
  private readonly fullness = document.createElement('span');
  private readonly value = document.createElement('span');
  private hovered = false;
  private tooltipHovered = false;
  private signature = '';
  private hideTimer?: ReturnType<typeof setTimeout>;
  private positionFrame?: number;
  private readonly reposition = () => this.schedulePosition();
  private readonly escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { this.hide(); } };

  constructor(item: OutputItem) {
    this.root.className = 'output-ring'; this.root.tabIndex = 0;
    this.root.setAttribute('role', 'img');
    this.tooltip.id = `output-ring-tooltip-${++tooltipId}`;
    this.root.setAttribute('aria-describedby', this.tooltip.id);
    const ring = document.createElement('span'); ring.className = 'output-ring-track'; ring.setAttribute('aria-hidden', 'true');
    this.root.append(ring);
    this.tooltip.className = 'output-ring-tooltip'; this.tooltip.hidden = true; this.tooltip.setAttribute('role', 'tooltip');
    this.heading.className = 'output-ring-heading'; this.fullness.className = 'output-ring-fullness'; this.value.className = 'output-ring-value';
    this.tooltip.append(this.heading, this.fullness, this.value);
    this.root.addEventListener('pointerenter', () => { this.hovered = true; this.show(); });
    this.root.addEventListener('pointerleave', () => { this.hovered = false; this.scheduleHide(); });
    this.root.addEventListener('focus', () => this.show());
    this.root.addEventListener('blur', () => this.scheduleHide());
    this.tooltip.addEventListener('pointerenter', () => { this.tooltipHovered = true; clearTimeout(this.hideTimer); });
    this.tooltip.addEventListener('pointerleave', () => { this.tooltipHovered = false; this.scheduleHide(); });
    this.update(item);
  }

  update(item: OutputItem): void {
    const signature = JSON.stringify([item, locale()]);
    if (signature === this.signature) { return; }
    this.signature = signature;
    const text = ringOutputText(item);
    this.root.hidden = !text;
    if (!text) { this.hide(); return; }
    this.root.dataset.itemId = item.id;
    this.root.style.setProperty('--output-ring-fill', `${Math.min(100, Math.max(0, text.percentage ?? 0))}%`);
    this.root.setAttribute('aria-label', text.label);
    this.heading.textContent = text.heading; this.fullness.textContent = text.fullness; this.value.textContent = text.value;
    this.schedulePosition();
  }

  dispose(): void { this.hide(); this.root.remove(); }

  private show(): void {
    if (this.root.hidden) { return; }
    if (RingOutput.active !== this) { RingOutput.active?.hide(); RingOutput.active = this; }
    clearTimeout(this.hideTimer);
    document.body.append(this.tooltip); this.tooltip.hidden = false; this.position();
    window.addEventListener('resize', this.reposition);
    window.addEventListener('scroll', this.reposition, { capture: true, passive: true });
    window.addEventListener('keydown', this.escape);
  }

  private hide(): void {
    if (RingOutput.active === this) { RingOutput.active = undefined; }
    clearTimeout(this.hideTimer);
    if (this.positionFrame !== undefined) { cancelAnimationFrame(this.positionFrame); this.positionFrame = undefined; }
    this.tooltip.hidden = true; this.tooltip.remove(); this.tooltipHovered = false;
    window.removeEventListener('resize', this.reposition); window.removeEventListener('scroll', this.reposition, true); window.removeEventListener('keydown', this.escape);
  }

  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.hovered && !this.tooltipHovered && document.activeElement !== this.root) { this.hide(); }
    }, 120);
  }

  private position(): void {
    if (this.tooltip.hidden) { return; }
    const rect = this.root.getBoundingClientRect();
    const width = this.tooltip.offsetWidth;
    const above = rect.top - this.tooltip.offsetHeight - 8;
    this.tooltip.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
    this.tooltip.style.top = `${Math.max(12, Math.min(above >= 12 ? above : rect.bottom + 8, window.innerHeight - this.tooltip.offsetHeight - 12))}px`;
  }

  private schedulePosition(): void {
    if (this.tooltip.hidden || this.positionFrame !== undefined) { return; }
    this.positionFrame = requestAnimationFrame(() => { this.positionFrame = undefined; this.position(); });
  }
}

export class ComposerOutput {
  readonly root = document.createElement('span');
  private readonly views = new Map<string, RingOutput>();
  private scope = '';

  constructor() { this.root.className = 'composer-output'; this.root.hidden = true; }

  update(items: OutputItem[], scope: string): void {
    if (scope !== this.scope) { this.clear(); this.scope = scope; }
    const active = new Set<string>();
    for (const item of items) {
      if (!isComposerOutputItem(item)) { continue; }
      active.add(item.id!);
      let view = this.views.get(item.id!);
      if (!view) { view = new RingOutput(item); this.views.set(item.id!, view); this.root.append(view.root); }
      else { view.update(item); }
    }
    for (const [id, view] of this.views) { if (!active.has(id)) { view.dispose(); this.views.delete(id); } }
    this.root.hidden = this.views.size === 0;
  }

  private clear(): void { for (const view of this.views.values()) { view.dispose(); } this.views.clear(); }
}
