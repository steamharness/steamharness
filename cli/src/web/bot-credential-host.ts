import { randomUUID } from 'node:crypto';
import * as core from 'steamharness';
import type { BotCredentialSlot, BotCredentialStatus, BotCredentialUse, BotCredentialUseResult } from 'steamharness';
import { t } from './localization';

export type BotCredentialApproval = { scopeId: string; mode: 'prompt' | 'reuse' } | { mode: 'auto' };
export type BotCredentialAction = { action: 'capture'; slot: BotCredentialSlot } | { action: 'manage' }
  | { action: 'use'; use: BotCredentialUse; approval?: BotCredentialApproval };
export type BotCredentialTurn = { conversationId: string; requestId: string };
export type BotCredentialHost = (entryId: string, action: BotCredentialAction, signal?: AbortSignal, turn?: BotCredentialTurn) => Promise<BotCredentialStatus | 'managed' | 'approval-required' | BotCredentialUseResult>;

export const credentialUnavailable = () => new Error(t('Secure credential entry is unavailable. Open this Bot in a supported local Studio window.'));
export const credentialStatus = (value: unknown): value is BotCredentialStatus => value === 'saved' || value === 'existing' || value === 'declined';
// Older compatible runtime builds may not yet export the use protocol.
export const { parseBotCredentialUse, parseBotCredentialUseResult } = core;
export const credentialUseSupported = core.BOT_CREDENTIAL_USE_VERSION === 1 && typeof parseBotCredentialUse === 'function' && typeof parseBotCredentialUseResult === 'function';

/** The private host pipe accepts only capture/management statuses or a validated connector receipt. */
export function createBotCredentialHost(send: (message: object) => void) {
  const pending = new Map<string, (message?: Record<string, unknown>) => void>();
  let closed = false;
  const open: BotCredentialHost = (entryId, action, signal, turn) => new Promise((resolve, reject) => {
    if (closed || signal?.aborted || pending.size >= 8) { reject(credentialUnavailable()); return; }
    const id = randomUUID();
    const cancel = () => { if (pending.has(id)) { send({ type: 'bot-credential-cancel', id }); settle(); } };
    const settle = (message?: Record<string, unknown>) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      const status = message?.status;
      const result = action.action === 'use' && credentialUseSupported && status === undefined ? parseBotCredentialUseResult(message?.result, action.use) : undefined;
      if (result) resolve(result);
      else if (message?.result === undefined && action.action === 'use' && (action.approval?.mode === 'reuse' || action.approval?.mode === 'auto') && status === 'approval-required') resolve(status);
      else if (message?.result === undefined && (action.action === 'capture' && credentialStatus(status) || action.action === 'manage' && status === 'managed')) resolve(status as BotCredentialStatus | 'managed');
      else if (message?.result === undefined && status === 'busy') reject(new Error(t('A secure credential prompt is already open. Try again after closing it.')));
      else reject(credentialUnavailable());
    };
    const timeout = action.action === 'use' && (action.approval?.mode === 'reuse' || action.approval?.mode === 'auto') ? 20_000 : 5 * 60_000;
    const timer = setTimeout(cancel, timeout); timer.unref();
    pending.set(id, settle); signal?.addEventListener('abort', cancel, { once: true });
    send({ type: 'bot-credential-request', id, entryId, ...action, ...(turn && { turn }) });
  });
  return { open,
    reply(message: Record<string, unknown>) {
      if (typeof message.id === 'string' && Object.keys(message).every(key => ['type', 'id', 'status', 'result'].includes(key))) pending.get(message.id)?.(message);
    },
    close() { closed = true; for (const settle of pending.values()) settle(); },
  };
}
