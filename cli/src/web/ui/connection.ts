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
  private epoch = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private status: ConnectionState = 'connecting';
  private attempts = 0;
  private closed = false;
  private manual = false;
  private token = new URLSearchParams(location.hash.slice(1)).get('session') ?? new URLSearchParams(location.search).get('session') ?? sessionStorage.getItem('steamharness-web-session');

  constructor(private readonly emit: (message: Message) => void, private readonly live = true, showBanner = true) {
    if (this.token) { const query = new URLSearchParams(location.search); query.delete('session'); sessionStorage.setItem('steamharness-web-session', this.token); history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}`); }
    queueMicrotask(() => {
      if (showBanner) {
        this.banner = document.createElement('div');
        this.banner.id = 'connection-status'; this.banner.className = 'connection-banner'; this.banner.setAttribute('role', 'status'); this.banner.setAttribute('aria-live', 'polite');
        this.banner.innerHTML = `<span class="connection-icon" aria-hidden="true"></span><div class="connection-copy"><strong></strong><span></span></div><button type="button" class="connection-retry">${iconHtml('refresh')}<span>${t("Reconnect")}</span></button>`;
        this.banner.querySelector('button')!.addEventListener('click', () => { void this.reconnect(); });
        document.querySelector('main')!.prepend(this.banner);
      }
      void this.connect();
    });
    addEventListener('offline', () => { this.disconnect(); this.update('offline'); });
    addEventListener('online', () => { void this.connect(); });
    addEventListener('pagehide', () => { this.closed = true; this.disconnect(); });
    addEventListener('pageshow', event => { if (event.persisted) { this.closed = false; void this.connect(); } });
  }

  private update(status: ConnectionState): void {
    this.status = status;
    this.emit({ type: 'connection', status, manual: this.manual });
    if (!this.banner) { return; }
    this.banner.hidden = status === 'connected';
    this.banner.dataset.status = status;
    const retrying = status === 'connecting' || status === 'reconnecting';
    this.banner.querySelector('.connection-icon')!.innerHTML = iconHtml(retrying ? 'loading' : status === 'expired' ? 'warning' : 'debug-disconnect');
    this.banner.querySelector('strong')!.textContent = status === 'connecting' ? t("Connecting to project") : status === 'expired' ? t("Project connection expired") : t("Connection interrupted");
    this.banner.querySelector('.connection-copy > span')!.textContent = status === 'reconnecting' ? t("Reconnecting...") : status === 'offline' ? t("Reconnection will start when the network is available.") : status === 'expired' ? t("Reopen using the project's run URL.") : '';
    (this.banner.querySelector('button') as HTMLButtonElement).disabled = status === 'offline' || this.manual;
  }

  private disconnect(): void {
    this.epoch++;
    this.handshake?.abort(); this.handshake = undefined; this.connecting = undefined;
    this.source?.close(); this.source = undefined;
    clearTimeout(this.retry);
    clearTimeout(this.snapshotTimer);
    this.manual = false;
  }

  private interrupted(): void {
    this.disconnect();
    this.update(navigator.onLine ? 'reconnecting' : 'offline');
    if (!this.closed && navigator.onLine) { this.retry = setTimeout(() => { void this.connect(); }, Math.min(2_000 * 2 ** this.attempts++, 30_000)); }
  }

  reconnect(): Promise<void> {
    this.disconnect();
    this.attempts = 0;
    return this.connect(true);
  }

  private connect(manual = false): Promise<void> {
    if (this.connecting) { return this.connecting; }
    clearTimeout(this.retry);
    if (this.closed) { return Promise.resolve(); }
    if (!navigator.onLine) { this.update('offline'); return Promise.resolve(); }
    this.disconnect();
    this.manual = manual;
    const epoch = this.epoch, handshake = this.handshake = new AbortController();
    const active = () => epoch === this.epoch && !this.closed && navigator.onLine;
    const signal = AbortSignal.any([handshake.signal, AbortSignal.timeout(10_000)]);
    this.update(manual || this.attempts ? 'reconnecting' : 'connecting');
    this.connecting = (async () => {
      try {
        if (this.token) {
          const session = await fetch('/api/session', { method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, signal });
          if (!active()) { return; }
          if (session.status === 401) { this.update('expired'); return; }
          if (!session.ok) { throw new Error('Cannot connect to the project.'); }
        }
        const session = await fetch('/api/session', { headers: this.headers(), signal });
        if (!active()) { return; }
        if (session.status === 401) { this.update('expired'); return; }
        if (!session.ok) { throw new Error('Cannot connect to the project.'); }
        // Embedded card snapshots must not each reserve a browser HTTP connection.
        if (!this.live) { await this.snapshot(epoch); return; }
        const eventsUrl = new URL(this.fileUrl('/api/events'), location.href);
        eventsUrl.searchParams.set('clientId', this.clientId);
        await new Promise<void>(resolve => {
          const source = this.source = new EventSource(eventsUrl.href);
          const finish = () => { signal.removeEventListener('abort', aborted); resolve(); };
          const aborted = () => { if (active()) { this.interrupted(); } finish(); };
          signal.addEventListener('abort', aborted, { once: true });
          source.onopen = () => { if (active()) { this.attempts = 0; this.manual = false; this.update('connected'); } finish(); };
          source.onmessage = event => { if (active()) { this.emit(this.publicFiles(JSON.parse(event.data))); } };
          source.onerror = () => { if (active()) { this.interrupted(); } finish(); };
          if (signal.aborted) { aborted(); }
        });
      } catch { if (active()) { this.interrupted(); } }
    })().finally(() => {
      if (epoch !== this.epoch) { return; }
      this.connecting = undefined; this.handshake = undefined;
      if (this.manual) { this.manual = false; this.update(this.status); }
    });
    return this.connecting;
  }

  private async snapshot(epoch: number): Promise<void> {
    if (epoch !== this.epoch || this.closed) { return; }
    const response = await fetch('/api/resource-state', { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    if (epoch !== this.epoch || this.closed) { return; }
    if (response.status === 401) { this.disconnect(); this.update('expired'); return; }
    if (!response.ok) { throw new Error('Cannot connect to the project.'); }
    const state = await response.json();
    if (epoch !== this.epoch || this.closed) { return; }
    if (this.status !== 'connected') { this.attempts = 0; this.manual = false; this.update('connected'); }
    this.emit(state);
    this.snapshotTimer = setTimeout(() => {
      void this.snapshot(epoch).catch(() => { if (epoch === this.epoch && !this.closed) { this.interrupted(); } });
    }, 5_000);
  }

  async request(message: Message): Promise<Message[]> {
    if (this.closed || !navigator.onLine) { throw new ConnectionError(t("Connection interrupted.")); }
    if (this.status === 'expired') { throw new ConnectionError(t("Project connection expired.")); }
    const epoch = this.epoch;
    let response: Response;
    try {
      const body = { ...message, clientId: this.clientId };
      // Navigation is independent of the event stream and must not wait on its handshake.
      const signal = ['ready', 'navigate'].includes(message.type) ? AbortSignal.timeout(10_000) : undefined;
      response = await fetch('/api/message', { method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch { if (epoch === this.epoch && !this.closed) { this.interrupted(); } throw new ConnectionError(t("Connection interrupted.")); }
    if (this.closed) { throw new ConnectionError(t("Connection changed.")); }
    if (response.status === 401) { if (epoch === this.epoch) { this.disconnect(); this.update('expired'); } throw new ConnectionError(t("Project connection expired.")); }
    let reply: Message;
    try { reply = await response.json(); }
    catch { if (epoch === this.epoch && !this.closed) { this.interrupted(); } throw new ConnectionError(t("Connection interrupted.")); }
    if (this.closed) { throw new ConnectionError(t("Connection changed.")); }
    if (!response.ok) { throw new Error(reply.message || 'Request failed.'); }
    return (reply.messages ?? []).map((message: Message) => this.publicFiles(message));
  }

  private headers(): Record<string, string> { return this.token ? { Authorization: `Bearer ${this.token}` } : {}; }
  fileUrl(path: string): string {
    if (!this.token) { return path; }
    const url = new URL(path, location.href); url.searchParams.set('session', this.token); return `${url.pathname}${url.search}${url.hash}`;
  }
  private publicFiles(value: any): any {
    if (Array.isArray(value)) { return value.map(entry => this.publicFiles(entry)); }
    if (!value || typeof value !== 'object') { return value; }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      key === 'previewUrl' && typeof entry === 'string' && entry.startsWith('/api/file/') ? this.fileUrl(entry) : this.publicFiles(entry)]));
  }
}
