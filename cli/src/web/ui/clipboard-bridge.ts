import { t } from '../localization';

type Message = Record<string, any>;

export class ClipboardBridge {
  private enabled = false;
  private readonly pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly send: (message: Message) => void,
    private readonly browserWrite: (text: string) => Promise<void>,
    private readonly requiresHost = false,
  ) {}

  enable(version: unknown): void { this.enabled = version === 1; }

  async writeText(text: string): Promise<void> {
    if (!this.enabled) {
      if (this.requiresHost) { throw new Error(t("Host clipboard is unavailable.")); }
      return this.browserWrite(text);
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(t("Copy timed out."))); }, 10_000);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ type: 'workflow-clipboard', version: 1, command: 'writeText', requestId, text }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  receive(reply: Message | undefined): void {
    if (reply?.version !== 1 || typeof reply.requestId !== 'string' || typeof reply.ok !== 'boolean'
      || (reply.error !== undefined && typeof reply.error !== 'string')) { return; }
    const pending = this.pending.get(reply.requestId);
    if (!pending) { return; }
    this.pending.delete(reply.requestId); clearTimeout(pending.timer);
    if (reply.ok) { pending.resolve(); }
    else { pending.reject(new Error(reply.error || t("Host clipboard is unavailable."))); }
  }

  dispose(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(t("Connection changed."))); }
    this.pending.clear();
  }
}
