import { randomUUID } from 'node:crypto';
import type { BotCredentialSlot, BotCredentialStatus } from 'steamharness';
import { t } from './localization';

export type BotCredentialAction = { action: 'capture'; slot: BotCredentialSlot } | { action: 'manage' };
export type BotCredentialHost = (entryId: string, action: BotCredentialAction, signal?: AbortSignal) => Promise<BotCredentialStatus | 'managed'>;

export const credentialUnavailable = () => new Error(t('Secure credential entry is unavailable. Open this Bot in a supported local Studio window.'));
export const credentialStatus = (value: unknown): value is BotCredentialStatus => value === 'saved' || value === 'existing' || value === 'declined';

/** The private host pipe accepts a status only. A value never leaves native Studio. */
export function createBotCredentialHost(send: (message: object) => void) {
  const pending = new Map<string, (status?: unknown) => void>();
  let closed = false;
  const open: BotCredentialHost = (entryId, action, signal) => new Promise((resolve, reject) => {
    if (closed || signal?.aborted || pending.size >= 8) { reject(credentialUnavailable()); return; }
    const id = randomUUID();
    const cancel = () => { if (pending.has(id)) { send({ type: 'bot-credential-cancel', id }); settle(); } };
    const settle = (status?: unknown) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (action.action === 'capture' ? credentialStatus(status) : status === 'managed') resolve(status as BotCredentialStatus | 'managed');
      else if (status === 'busy') reject(new Error(t('A secure credential prompt is already open. Try again after closing it.')));
      else reject(credentialUnavailable());
    };
    const timer = setTimeout(cancel, 5 * 60_000); timer.unref();
    pending.set(id, settle); signal?.addEventListener('abort', cancel, { once: true });
    send({ type: 'bot-credential-request', id, entryId, ...action });
  });
  return { open,
    reply(message: Record<string, unknown>) {
      if (typeof message.id === 'string' && Object.keys(message).every(key => ['type', 'id', 'status'].includes(key))) pending.get(message.id)?.(message.status);
    },
    close() { closed = true; for (const settle of pending.values()) settle(); },
  };
}
