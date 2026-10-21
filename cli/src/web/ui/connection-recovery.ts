import { t } from '../localization';

/** Requests only process recovery; business operations stay with their caller. */
export class HostConnectionRecovery {
  enabled = false;
  private pending?: { id: string; resolve(token?: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; promise: Promise<string | undefined> };
  constructor(private readonly send: (message: Record<string, unknown>) => void) {}
  recover(): Promise<string | undefined> {
    if (!this.enabled) return Promise.resolve(undefined);
    if (this.pending) return this.pending.promise;
    const id = crypto.randomUUID();
    let resolve!: (token?: string) => void, reject!: (error: Error) => void;
    const promise = new Promise<string | undefined>((done, fail) => { resolve = done; reject = fail; });
    const timer = setTimeout(() => this.receive({ requestId: id, error: t('Project recovery timed out.') }), 50_000);
    this.pending = { id, resolve, reject, timer, promise };
    try { this.send({ type: 'workflow-reconnect', version: 1, requestId: id }); }
    catch (error) { this.receive({ requestId: id, error: String(error) }); }
    return promise;
  }
  receive(reply: Record<string, unknown>): void {
    const pending = this.pending;
    if (!pending || reply.requestId !== pending.id) return;
    clearTimeout(pending.timer); this.pending = undefined;
    if (reply.error) pending.reject(new Error(String(reply.error)));
    else if (reply.token !== undefined && (typeof reply.token !== 'string' || !/^[a-f0-9]{64}$/.test(reply.token))) pending.reject(new Error(t('Invalid recovered project connection.')));
    else pending.resolve(reply.token as string | undefined);
  }
  close(): void { if (this.pending) this.receive({ requestId: this.pending.id, error: t('Project page has closed.') }); }
}
