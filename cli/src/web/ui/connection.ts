const entryBase = () => document.querySelector<HTMLMetaElement>('meta[name=steamharness-base]')?.content ?? '';
import { t } from '../localization';
import { iconHtml } from './ui';
import './connection.css';

type Message = Record<string, any>;
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'expired';

export class ConnectionError extends Error {}

export class BrowserConnection {
  private readonly clientId = crypto.randomUUID();
  private source?: EventSource;
  private banner?: HTMLElement;
  private connecting?: Promise<void>;
  private handshake?: AbortController;
  private readonly requests = new Map<AbortController, boolean>();
  private epoch = 0;
  private applicationId?: string;
  private retry?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private bannerShowTimer?: ReturnType<typeof setTimeout>;
  private bannerHideTimer?: ReturnType<typeof setTimeout>;
  private status: ConnectionState = 'connecting';
  private attempts = 0;
  private closed = false;
  private manual = false;
  private retryFailed = false;
  private token = new URLSearchParams(location.hash.slice(1)).get('session') ?? new URLSearchParams(location.search).get('session') ?? sessionStorage.getItem('steamharness-web-session');

  constructor(private readonly emit: (message: Message) => void, private readonly live = true, showBanner = true,
    private readonly recoverHost?: () => Promise<string | undefined>) {
    if (this.token) { const query = new URLSearchParams(location.search); query.delete('session'); sessionStorage.setItem('steamharness-web-session', this.token); history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}`); }
    queueMicrotask(() => {
      if (showBanner) {
        this.banner = document.createElement('div');
        this.banner.hidden = true;
        this.banner.id = 'connection-status'; this.banner.className = 'connection-banner'; this.banner.setAttribute('role', 'status'); this.banner.setAttribute('aria-live', 'polite');
        this.banner.innerHTML = `<span class="connection-icon" aria-hidden="true"></span><div class="connection-copy"><strong></strong><span></span></div><button type="button" class="connection-retry">${iconHtml('refresh')}<span>${t("Reconnect")}</span></button>`;
        this.banner.querySelector('button')!.addEventListener('click', () => { void this.reconnect(); });
        const container = document.querySelector('main')!;
        container.classList.add('connection-container');
        container.prepend(this.banner);
      }
      void this.connect();
    });
    addEventListener('offline', () => { this.abortRequests(true); this.disconnect(); this.update('offline'); });
    addEventListener('online', () => { void this.connect(); });
    addEventListener('pagehide', () => { this.closed = true; this.abortRequests(true); this.disconnect(); clearTimeout(this.bannerShowTimer); clearTimeout(this.bannerHideTimer); this.bannerShowTimer = this.bannerHideTimer = undefined; if (this.banner) this.banner.hidden = true; });
    addEventListener('pageshow', event => { if (event.persisted) { this.closed = false; void this.connect(); } });
  }

  private update(status: ConnectionState): void {
    this.status = status;
    this.emit({ type: 'connection', status, manual: this.manual, retryFailed: this.retryFailed });
    if (!this.banner) { return; }
    if (status === 'connected') {
      clearTimeout(this.bannerShowTimer); this.bannerShowTimer = undefined;
      if (!this.banner.hidden && !this.bannerHideTimer) {
        this.banner.querySelector('button')!.disabled = true;
        // Keep one notification through brief recoveries instead of flashing on every retry.
        this.bannerHideTimer = setTimeout(() => { this.bannerHideTimer = undefined; if (this.status === 'connected') this.banner!.hidden = true; }, 1_000);
      }
      return;
    }
    clearTimeout(this.bannerHideTimer); this.bannerHideTimer = undefined;
    if (status === 'offline' || status === 'expired' || this.manual) {
      clearTimeout(this.bannerShowTimer); this.bannerShowTimer = undefined; this.banner.hidden = false;
    } else if (this.banner.hidden && !this.bannerShowTimer) {
      this.bannerShowTimer = setTimeout(() => { this.bannerShowTimer = undefined; if (!this.closed && this.status !== 'connected') this.banner!.hidden = false; }, 750);
    }
    this.banner.dataset.status = status;
    const retrying = status === 'connecting' || status === 'reconnecting';
    this.banner.querySelector('.connection-icon')!.innerHTML = iconHtml(retrying ? 'loading' : status === 'expired' ? 'warning' : 'debug-disconnect');
    this.banner.querySelector('strong')!.textContent = status === 'connecting' ? t("Connecting to project") : status === 'expired' ? t("Project connection expired") : t("Connection interrupted");
    this.banner.querySelector('.connection-copy > span')!.textContent = status === 'offline' ? t("Reconnection will start when the network is available.") : status === 'expired' ? t("Reopen using the project's run URL.")
      : this.retryFailed ? t("Reconnection failed. Retrying automatically; you can retry now.") : status === 'reconnecting' ? t("Reconnecting...") : '';
    const retry = this.banner.querySelector('button')!;
    retry.disabled = status === 'offline' || status === 'expired' || this.manual;
    retry.setAttribute('aria-busy', String(this.manual));
    retry.querySelector('span:last-child')!.textContent = this.manual ? t("Reconnecting...") : t("Reconnect");
  }

  private disconnect(): void {
    this.epoch++;
    this.handshake?.abort(); this.handshake = undefined; this.connecting = undefined;
    this.source?.close(); this.source = undefined;
    clearTimeout(this.retry);
    clearTimeout(this.connectTimer);
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.snapshotTimer);
    this.manual = false;
  }

  private interrupted(): void {
    if (this.manual) { this.retryFailed = true; }
    this.abortRequests();
    this.disconnect();
    this.update(navigator.onLine ? 'reconnecting' : 'offline');
    if (!this.closed && navigator.onLine) { this.retry = setTimeout(() => { void this.connect(); }, Math.min(2_000 * 2 ** this.attempts++, 30_000)); }
  }

  async reconnect(): Promise<void> {
    this.abortRequests();
    this.disconnect();
    this.attempts = 0;
    const epoch = this.epoch;
    this.manual = true; this.retryFailed = false; this.update('reconnecting');
    try { await this.recoverHostSession(); }
    catch {
      if (epoch === this.epoch && !this.closed) this.interrupted();
      return;
    }
    if (epoch !== this.epoch || this.closed) return;
    return this.connect(true);
  }

  private async recoverHostSession(): Promise<boolean> {
    const token = await this.recoverHost?.();
    if (!token || this.closed) return false;
    const changed = token !== this.token;
    this.token = token;
    sessionStorage.setItem('steamharness-web-session', token);
    return changed;
  }

  private connect(manual = false): Promise<void> {
    if (this.connecting) { return this.connecting; }
    clearTimeout(this.retry);
    if (this.closed) { return Promise.resolve(); }
    if (!navigator.onLine) { this.update('offline'); return Promise.resolve(); }
    this.disconnect();
    this.manual = manual;
    if (manual) { this.retryFailed = false; }
    const epoch = this.epoch, handshake = this.handshake = new AbortController();
    const active = () => epoch === this.epoch && !this.closed && navigator.onLine;
    const signal = handshake.signal;
    // Advance recovery even if an obsolete network request has not settled its abort.
    this.connectTimer = setTimeout(() => { if (active()) { this.interrupted(); } }, 10_000);
    this.update(manual || this.attempts ? 'reconnecting' : 'connecting');
    this.connecting = (async () => {
      try {
        if (this.attempts && this.recoverHost) {
          // The host startup has its own bounded deadline. Do not let the
          // shorter HTTP handshake timer cancel a process still being restored.
          clearTimeout(this.connectTimer);
          await this.recoverHostSession();
          if (!active()) return;
          this.connectTimer = setTimeout(() => { if (active()) this.interrupted(); }, 10_000);
        }
        if (this.token) {
          const session = await fetch(entryBase() + '/api/session', { method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, signal });
          if (!active()) { return; }
          if (session.status === 401) { this.update('expired'); return; }
          if (!session.ok) { throw new Error('Cannot connect to the project.'); }
        }
        const session = await fetch(entryBase() + '/api/session', { headers: this.headers(), signal });
        if (!active()) { return; }
        if (session.status === 401) { this.update('expired'); return; }
        if (!session.ok) { throw new Error('Cannot connect to the project.'); }
        // Embedded card snapshots must not each reserve a browser HTTP connection.
        if (!this.live) { await this.snapshot(epoch, signal); return; }
        const eventsUrl = new URL(this.fileUrl(entryBase() + '/api/events'), location.href);
        eventsUrl.searchParams.set('clientId', this.clientId);
        await new Promise<void>(resolve => {
          const source = this.source = new EventSource(eventsUrl.href);
          const finish = () => { signal.removeEventListener('abort', aborted); resolve(); };
          const aborted = () => finish();
          const alive = () => {
            if (!active()) { return; }
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = setTimeout(() => { if (active()) { this.interrupted(); } }, 45_000);
          };
          signal.addEventListener('abort', aborted, { once: true });
          source.onopen = alive;
          source.addEventListener('heartbeat', alive);
          source.onmessage = event => {
            if (!active()) { return; }
            let message: Message;
            try { message = this.publicFiles(JSON.parse(event.data)); }
            catch { this.interrupted(); finish(); return; }
            alive();
            if (message.type === 'state' && typeof message.project?.id === 'string') this.applicationId ??= `${message.project.id}:${message.project.entryId}`;
            this.emit(message);
            if (active() && message?.type === 'state' && this.status !== 'connected') {
              clearTimeout(this.connectTimer);
              this.attempts = 0; this.manual = false; this.retryFailed = false; this.update('connected'); finish();
            }
          };
          source.onerror = () => { if (active()) { this.interrupted(); } finish(); };
          if (signal.aborted) { aborted(); }
        });
      } catch { if (active()) { this.interrupted(); } }
    })().finally(() => {
      if (epoch !== this.epoch) { return; }
      clearTimeout(this.connectTimer);
      this.connecting = undefined; this.handshake = undefined;
      if (this.manual) { this.manual = false; this.update(this.status); }
    });
    return this.connecting;
  }

  private async snapshot(epoch: number, signal = AbortSignal.timeout(10_000)): Promise<void> {
    if (epoch !== this.epoch || this.closed) { return; }
    const response = await fetch(entryBase() + '/api/resource-state', { headers: this.headers(), signal });
    if (epoch !== this.epoch || this.closed) { return; }
    if (response.status === 401) { this.disconnect(); this.update('expired'); return; }
    if (!response.ok) { throw new Error('Cannot connect to the project.'); }
    const state = await response.json();
    if (epoch !== this.epoch || this.closed) { return; }
    if (this.status !== 'connected') { this.attempts = 0; this.manual = false; this.retryFailed = false; this.update('connected'); }
    if (state.type === 'state' && typeof state.project?.id === 'string') this.applicationId ??= `${state.project.id}:${state.project.entryId}`;
    this.emit(state);
    this.snapshotTimer = setTimeout(() => {
      void this.snapshot(epoch).catch(() => { if (epoch === this.epoch && !this.closed) { this.interrupted(); } });
    }, 5_000);
  }

  async request(message: Message): Promise<Message[]> {
    if (this.closed || !navigator.onLine) { throw new ConnectionError(t("Connection interrupted.")); }
    const epoch = this.epoch;
    const controller = new AbortController();
    const control = message.type === 'stop' || message.type === 'workflow-stop' || message.type === 'agent-command' && message.command?.type === 'cancel';
    const signal = control && this.recoverHost ? AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]) : controller.signal;
    this.requests.set(controller, control);
    try {
      // Only explicit cancellation can cross process recovery. A failed send or
      // tool action is never replayed by this transport.
      if (control && this.recoverHost && await this.recoverHostSession()) { this.disconnect(); void this.connect(); }
      if (this.status === 'expired') { throw new ConnectionError(t("Project connection expired.")); }
      if (this.closed || signal.aborted) throw new ConnectionError(t('Connection changed.'));
      const body = { ...message, ...(this.applicationId ? { applicationId: this.applicationId } : {}), clientId: this.clientId };
      // Navigation is independent of the event stream and must not wait on its handshake.
      const timeout = ['ready', 'navigate'].includes(message.type) ? 10_000
        : message.type === 'project-server-check' ? 180_000
        : control || ['queue-promote', 'queue-remove'].includes(message.type) ? 35_000 : 60_000;
      for (let attempt = 0; ; attempt++) {
        let response: Response, reply: Message;
        try {
          response = await fetch(entryBase() + '/api/message', { method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
          if (this.closed || signal.aborted) { throw new ConnectionError(t("Connection changed.")); }
          if (response.status === 401) {
            if (epoch === this.epoch) { this.abortRequests(true); this.disconnect(); this.update('expired'); }
            throw new ConnectionError(t("Project connection expired."));
          }
          reply = await response.json();
        } catch (error) {
          if (error instanceof ConnectionError) { throw error; }
          if (control && !attempt && !signal.aborted && await this.recoverHostSession()) {
            if (this.closed || signal.aborted) throw new ConnectionError(t('Connection changed.'));
            this.disconnect(); void this.connect(); continue;
          }
          if (epoch === this.epoch && !this.closed && !controller.signal.aborted) { this.interrupted(); }
          throw new ConnectionError(t("Connection interrupted."));
        }
        if (this.closed || signal.aborted) { throw new ConnectionError(t("Connection changed.")); }
        if (!response.ok) { throw new Error(reply.message || 'Request failed.'); }
        return (reply.messages ?? []).map((message: Message) => this.publicFiles(message));
      }
    } finally { this.requests.delete(controller); }
  }

  private abortRequests(includeControls = false): void {
    for (const [controller, control] of this.requests) {
      // Stopping remains independent of event-stream recovery.
      if (includeControls || !control) { controller.abort(); this.requests.delete(controller); }
    }
  }

  private headers(): Record<string, string> { return this.token ? { Authorization: `Bearer ${this.token}` } : {}; }
  fileUrl(path: string): string {
    if (path.startsWith('/') && !path.startsWith('/entries/')) path = entryBase() + path;
    if (!this.token) { return path; }
    const url = new URL(path, location.href); url.searchParams.set('session', this.token); return `${url.pathname}${url.search}${url.hash}`;
  }
  private publicFiles(value: any): any {
    if (Array.isArray(value)) { return value.map(entry => this.publicFiles(entry)); }
    if (!value || typeof value !== 'object') { return value; }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      key === 'previewUrl' && typeof entry === 'string' && entry.includes('/api/file/') ? this.fileUrl(entry) : this.publicFiles(entry)]));
  }
}
