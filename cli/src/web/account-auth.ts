import { randomBytes } from 'node:crypto';
import { ServerAuthClient, type DeviceStart } from '@steamharness/server-auth';
import { readCliAuthConfig, writeCliAuthConfig, clearCliAuthConfig } from '../auth-config';
import { serviceChannel } from '../service-url';
import { locale, t } from './localization';
export interface BrowserSignIn { url: string; userCode: string; expiresAt: string; state: string }
/** Aggregate entries share this controller, including cancellation and credential persistence. */
export class WebAccountLogin {
  private pending?: { client: ServerAuthClient; started: DeviceStart; abort: AbortController; state: string };
  private starting?: AbortController;
  private epoch = 0;
  private lastState?: {state:string;expires:number};
  matchesState(state: string): boolean {return state === this.info?.state || !!this.lastState && this.lastState.expires > Date.now() && state === this.lastState.state;}
  private listeners = new Set<(error?: string) => void>();
  info?: BrowserSignIn;
  get busy(): boolean { return !!this.starting || !!this.pending; }
  subscribe(listener: (error?: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(error?: string): void { for (const listener of this.listeners) listener(error); }
  async start(serverUrl: string, returnUrl?: string): Promise<void> {
    if (this.busy) return;
    const epoch = ++this.epoch, abort = new AbortController(); this.starting = abort;
    this.emit();
    try {
      const client = new ServerAuthClient(serverUrl, fetch, locale()), state = randomBytes(32).toString('base64url');
      const started = await client.start({ clientName: 'SteamHarness CLI Web', source: 'cli', context: { clientKind: 'cli-web', channel: serviceChannel(), state, ...(returnUrl ? { returnUrl } : {}) } }, abort.signal);
      if (epoch !== this.epoch || abort.signal.aborted) { await client.cancel(started.deviceCode); return; }
      this.pending = { client, started, abort, state }; this.starting = undefined;
      this.info = { url: started.verificationUriComplete, userCode: started.userCode, expiresAt: started.expiresAt, state }; this.emit();
      void this.finish(epoch, this.pending);
    } catch (error) {
      if (epoch === this.epoch) { this.starting = undefined; this.emit(loginError(error)); }
      throw error;
    }
  }
  private async finish(epoch: number, pending: NonNullable<WebAccountLogin['pending']>): Promise<void> {
    try {
      const token = await pending.client.poll(pending.started, pending.abort.signal);
      if (epoch !== this.epoch) { await pending.client.cancel(pending.started.deviceCode); return; }
      const old = await readCliAuthConfig();
      if (epoch !== this.epoch) { await pending.client.cancel(pending.started.deviceCode); return; }
      await writeCliAuthConfig({ serverUrl: pending.client.serverUrl, apiKey: token.accessToken, user: token.user, expiresAt: token.expiresAt, source: 'device_flow',
        ...(old.serverUrl === pending.client.serverUrl && old.user?.userId === token.user.userId ? { aiServerUrl: old.aiServerUrl, aiApiKey: old.aiApiKey } : {}) });
      if (epoch !== this.epoch) { await clearCliAuthConfig(process.env, token.accessToken); await pending.client.cancel(pending.started.deviceCode); return; }
      this.lastState = {state:pending.state,expires:Date.now()+600_000};
      this.pending = undefined; this.info = undefined; this.emit();
      if (old.apiKey && old.apiKey !== token.accessToken) void fetch(`${old.serverUrl}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${old.apiKey}` }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    } catch (error) {
      await pending.client.cancel(pending.started.deviceCode).catch(() => undefined);
      if (epoch === this.epoch) { this.pending = undefined; this.info = undefined; this.emit(loginError(error)); }
    }
  }
  cancel(): void {
    ++this.epoch; this.lastState = undefined; this.starting?.abort(); this.starting = undefined;
    const pending = this.pending; this.pending = undefined; this.info = undefined;
    if (pending) { pending.abort.abort(); void pending.client.cancel(pending.started.deviceCode).catch(() => undefined); }
    this.emit();
  }
}
const logins = new WeakMap<object, WebAccountLogin>();
export function sharedWebLogin(owner: object): WebAccountLogin {
  let login = logins.get(owner); if (!login) { login = new WebAccountLogin(); logins.set(owner, login); } return login;
}

function loginError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message === 'expired_token' ? t('Sign-in request expired. Start again.') : message === 'access_denied' ? t('Sign-in request was denied.') : message || t('Sign-in failed.');
}
