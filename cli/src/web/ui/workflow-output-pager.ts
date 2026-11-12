import { t } from '../localization';
import type { OutputItem, Attachment } from '../workflow-types';

export interface WorkflowOutputPage {
  runId: string; page: number; pageSize: number; total: number; revision: number;
  items: OutputItem[]; files: Attachment[]; requestId?: number; error?: string;
}
export class WorkflowOutputPager {
  private runId = '';
  private total = 0;
  private revision = 0;
  private page?: number;
  private viewedTotal = 0;
  private sequence = 0;
  private pending?: number;
  private fetched = '';
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private error = '';
  private readonly previous = document.createElement('button');
  private readonly next = document.createElement('button');
  private readonly latest = document.createElement('button');
  private readonly retry = document.createElement('button');
  private readonly label = document.createElement('span');
  private readonly status = document.createElement('span');
  constructor(private readonly root: HTMLElement, private readonly options: {
    request(input: { runId: string; page?: number; pageSize: number; requestId: number }): void;
    render(page: WorkflowOutputPage): void;
    followChanged?(following: boolean): void;
  }) {
    root.classList.add('workflow-output-pagination');
    root.setAttribute('aria-label', t('Output pages'));
    this.previous.textContent = t('Previous'); this.next.textContent = t('Next');
    this.retry.textContent = t('Retry');
    this.status.setAttribute('role', 'status');
    for (const button of [this.previous, this.next, this.latest, this.retry]) button.type = 'button';
    this.previous.onclick = () => this.select(Math.max(1, (this.page ?? Math.max(1, Math.ceil(this.total / 100))) - 1));
    this.next.onclick = () => this.select((this.page ?? Math.max(1, Math.ceil(this.total / 100))) + 1);
    this.latest.onclick = () => { this.page = undefined; this.viewedTotal = this.total; this.options.followChanged?.(true); this.invalidate(); };
    this.retry.onclick = () => this.invalidate();
    root.append(this.previous, this.label, this.next, this.latest, this.status, this.retry);
  }
  update(runId: string, total: number, revision: number): void {
    if (runId !== this.runId) {
      this.runId = runId; this.page = undefined; this.viewedTotal = total;
      this.fetched = ''; this.pending = undefined; ++this.sequence; this.error = '';
      clearTimeout(this.timer); clearTimeout(this.deadline); this.timer = undefined;
    }
    this.total = total; this.revision = revision;
    this.controls(); this.schedule();
  }
  get followingLatest(): boolean { return this.page === undefined; }
  private select(page: number): void { this.options.followChanged?.(false); this.page = Math.min(page, Math.max(1, Math.ceil(this.total / 100))); this.viewedTotal = this.total; this.invalidate(); }
  private invalidate(): void { ++this.sequence; this.pending = undefined; this.fetched = ''; this.error = ''; clearTimeout(this.timer); clearTimeout(this.deadline); this.timer = undefined; this.controls(); this.schedule(); }
  private signature(): string { return `${this.runId}:${this.page ?? 'latest'}:${this.revision}`; }
  private schedule(): void {
    if (!this.runId || this.error || this.pending !== undefined || this.timer || this.fetched === this.signature()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined; this.pending = ++this.sequence; this.fetched = this.signature(); this.controls();
      const requestId = this.pending;
      this.deadline = setTimeout(() => this.fail(requestId, t('Output page request timed out. Retry.')), 15000);
      try { this.options.request({ runId: this.runId, page: this.page, pageSize: 100, requestId }); }
      catch (error) { this.fail(requestId, error instanceof Error ? error.message : String(error)); }
    }, 100);
  }
  receive(page: WorkflowOutputPage): void {
    if (page.runId !== this.runId || page.requestId !== this.pending) return;
    this.pending = undefined; clearTimeout(this.deadline);
    if (page.error) this.error = page.error;
    else {
      if (this.page === undefined) this.viewedTotal = page.total;
      this.options.render(page);
    }
    this.controls(); this.schedule();
  }
  fail(requestId: number | undefined, error: string): void {
    if (requestId === undefined || requestId !== this.pending) return;
    clearTimeout(this.deadline); this.pending = undefined; this.error = error; this.controls();
  }
  private controls(): void {
    const pages = Math.max(1, Math.ceil(this.total / 100));
    const selected = this.page ?? pages;
    this.root.hidden = !this.runId || this.total <= 100 && !this.error;
    this.label.textContent = t('Page {0} of {1} · {2} outputs', selected, pages, this.total);
    this.previous.disabled = selected <= 1; this.next.disabled = selected >= pages;
    const added = Math.max(0, this.total - this.viewedTotal);
    this.latest.hidden = this.page === undefined;
    this.latest.textContent = added ? t('{0} new · Latest', added) : t('Latest');
    this.status.textContent = this.error || (this.pending !== undefined ? t('Loading output…') : '');
    this.retry.hidden = !this.error;
  }
  dispose(): void { clearTimeout(this.timer); clearTimeout(this.deadline); ++this.sequence; this.pending = undefined; this.runId = ''; }
}
