import type { RemoteAccessAction, RemoteAccessState } from '../src/remote-access-types';
import { t } from './localization';

type Action = RemoteAccessAction | { action: 'copy'; value: string };
type Result = RemoteAccessState | { error: string } | { copied: true };

export class SettingsRemoteAccess {
  private readonly notice: HTMLElement;
  private readonly content: HTMLElement;
  private readonly pair: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly devices: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly generate: HTMLButtonElement;
  private request?: { id: string; action: Action['action'] };
  private state?: RemoteAccessState;
  private active = false;
  private nextRefresh = 0;
  private sequence = 0;

  constructor(private readonly root: HTMLElement, private readonly post: (input: unknown) => void) {
    root.innerHTML = `<p class="muted" data-status></p>
      <div class="remote-actions"><button type="button" data-toggle hidden></button><button type="button" data-retry hidden>${t('Retry')}</button></div>
      <div data-contents hidden>
        <p class="remote-urls" data-urls></p>
        <section class="settings-group" data-pairing><h2>${t('Pair another device')}</h2>
          <p class="muted">${t('Paired devices have full access, including project files and the terminal. Pair only devices you trust.')}</p>
          <div class="remote-actions"><select aria-label="${t('Remote address')}" hidden></select><button type="button" data-generate>${t('Generate pairing code')}</button></div>
          <div class="settings-card remote-pair" data-pair hidden></div>
        </section>
        <section class="settings-group"><h2>${t('Paired devices')}</h2><div class="settings-card" data-devices></div></section>
      </div><p class="muted" aria-live="polite" data-notice></p>`;
    this.notice = root.querySelector('[data-notice]')!;
    this.content = root.querySelector('[data-contents]')!;
    this.pair = root.querySelector('[data-pair]')!;
    this.devices = root.querySelector('[data-devices]')!;
    this.select = root.querySelector('select')!;
    this.toggle = root.querySelector('[data-toggle]')!;
    this.generate = root.querySelector('[data-generate]')!;
    root.querySelector('button[data-retry]')!.addEventListener('click', () => this.run({ action: 'status' }));
    this.toggle.addEventListener('click', () => this.run({ action: this.state?.mode === 'remote' ? 'logout' : this.state?.running ? 'stop' : 'start' }));
    this.select.addEventListener('change', () => this.clearPair());
    this.generate.addEventListener('click', () => this.run({ action: 'generate', origin: this.select.value }));
    setInterval(() => {
      if (!this.active || document.hidden) return;
      this.timeLeft();
      if (!this.request && this.state?.mode !== 'remote' && Date.now() >= this.nextRefresh) this.run({ action: 'status' });
    }, 1000);
  }

  setActive(value: boolean): void {
    if (value && !this.active) this.run({ action: 'status' });
    this.active = value;
  }

  private run(input: Action): void {
    if (this.request) return;
    const id = String(++this.sequence);
    this.request = { id, action: input.action };
    this.nextRefresh = Date.now() + 5000;
    if (input.action === 'start' || input.action === 'stop') this.notice.textContent = input.action === 'start' ? t('Starting Studio Web…') : t('Stopping Studio Web…');
    this.updateButtons();
    this.post({ type: 'settings-remote-access', requestId: id, input });
  }

  handle(message: { type?: string; requestId?: string; result?: Result }): boolean {
    if (message.type !== 'settings-remote-access-result') return false;
    if (!this.request || message.requestId !== this.request.id || !message.result) return true;
    const { result } = message, { action } = this.request;
    this.request = undefined;
    this.root.querySelector<HTMLButtonElement>('button[data-retry]')!.hidden = !('error' in result);
    if ('error' in result) this.notice.textContent = result.error === 'unconfigured' ? t('No remote HTTPS address is configured.') : t('Could not reach the Studio Web service.');
    else if ('copied' in result) this.notice.textContent = t('Pairing link copied.');
    else {
      if (action !== 'status') this.notice.textContent = '';
      if (action === 'status' && result.running && result.pairExpiresAt === this.state?.pair?.expiresAt) result.pair = this.state?.pair;
      this.render(result);
    }
    this.updateButtons();
    return true;
  }

  private clearPair(): void {
    if (this.state) this.state.pair = undefined;
    this.renderPair(undefined);
  }

  private render(state: RemoteAccessState): void {
    const previous = this.state;
    this.state = state;
    const managed = state.mode !== 'remote';
    this.content.hidden = !state.running || !managed;
    this.toggle.hidden = state.mode === 'local' && !state.running;
    this.toggle.textContent = state.mode === 'remote' ? t('Sign out this device') : state.running ? t('Stop Studio Web') : t('Start Studio Web');
    this.root.querySelector('[data-status]')!.textContent = state.mode === 'remote' ? t('This browser is paired. Manage other devices on the host.') : state.running ? t('Studio Web is running.') : t('Studio Web is stopped.');
    this.root.querySelector('[data-urls]')!.textContent = state.running ? state.localUrls.join('  ·  ') : '';
    if (JSON.stringify(previous?.remoteUrls) !== JSON.stringify(state.remoteUrls)) {
      const selected = this.select.value;
      this.select.replaceChildren(...state.remoteUrls.map(origin => new Option(origin, origin)));
      if (state.remoteUrls.includes(selected)) this.select.value = selected;
    }
    this.select.hidden = !state.remoteUrls.length;
    if (previous?.pair?.link !== state.pair?.link) this.renderPair(state.pair);
    this.timeLeft();
    if (JSON.stringify(previous?.devices) !== JSON.stringify(state.devices)) this.renderDevices(state.devices);
    if (managed && state.running && !state.remoteUrls.length) this.notice.textContent = t('No remote HTTPS address is configured.');
  }

  private renderPair(pair: RemoteAccessState['pair']): void {
    this.pair.hidden = !pair;
    this.pair.replaceChildren();
    if (!pair) return;
    const qr = document.createElement('img'); qr.src = pair.qr; qr.alt = t('Pairing QR code'); qr.width = qr.height = 128;
    const details = document.createElement('div');
    const code = document.createElement('code'); code.className = 'remote-code'; code.textContent = pair.code;
    const expiry = document.createElement('p'); expiry.className = 'muted'; expiry.dataset.expiry = '';
    const link = document.createElement('code'); link.textContent = pair.link;
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'secondary'; copy.dataset.remoteAction = '';
    copy.textContent = t('Copy pairing link'); copy.addEventListener('click', () => this.run({ action: 'copy', value: pair.link }));
    details.append(code, expiry, link, copy); this.pair.append(qr, details);
  }

  private renderDevices(devices: RemoteAccessState['devices']): void {
    const rows = devices.map(device => {
      const row = document.createElement('div'); row.className = 'setting-row remote-device';
      const summary = document.createElement('div');
      const label = document.createElement('strong'); label.textContent = device.label || t('Browser');
      const activity = document.createElement('p'); activity.className = 'muted setting-description';
      const time = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(device.lastSeenAt);
      activity.textContent = t('Last active: {0}', time);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.dataset.remoteAction = '';
      remove.textContent = t('Revoke device'); remove.addEventListener('click', () => this.run({ action: 'revoke', id: device.id }));
      summary.append(label, activity); row.append(summary, remove);
      return row;
    });
    if (!rows.length) { const row = document.createElement('p'); row.className = 'muted remote-empty'; row.textContent = t('No paired devices.'); rows.push(row); }
    this.devices.replaceChildren(...rows);
  }

  private timeLeft(): void {
    const pair = this.state?.pair;
    if (!pair) return;
    const seconds = Math.max(0, Math.ceil((pair.expiresAt - Date.now()) / 1000));
    if (!seconds) { this.clearPair(); return; }
    const label = this.pair.querySelector('[data-expiry]');
    if (label) label.textContent = t('Expires in {0}', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
  }

  private updateButtons(): void {
    const busy = !!this.request && this.request.action !== 'status';
    this.toggle.disabled = this.select.disabled = busy;
    this.generate.disabled = busy || !this.state?.remoteUrls.length;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-remote-action]')) button.disabled = busy;
  }
}
