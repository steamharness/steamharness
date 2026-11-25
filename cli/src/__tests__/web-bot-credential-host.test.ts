import { expect, it } from 'vitest';
import { createBotCredentialHost } from '../web/bot-credential-host';

it('accepts only a matching status receipt, sends cancellation, and joins requests on close', async () => {
  const outbound: Record<string, unknown>[] = [];
  const broker = createBotCredentialHost(message => outbound.push(message as Record<string, unknown>));
  const slot = { name: 'ci-deploy', kind: 'api-key' as const };
  const request = broker.open('agent', { action: 'capture', slot });
  expect(outbound[0]).toEqual({ type: 'bot-credential-request', id: expect.any(String), entryId: 'agent', slot, action: 'capture' });
  const { id } = outbound[0];
  broker.reply({ type: 'bot-credential-result', id: 'different', status: 'saved' });
  broker.reply({ type: 'bot-credential-result', id, status: 'saved', value: 'fixture-private-value' });
  broker.reply({ type: 'bot-credential-result', id, status: 'existing' });
  expect(await request).toBe('existing');
  const abort = new AbortController();
  const pending = broker.open('agent', { action: 'capture', slot }, abort.signal);
  const rejected = expect(pending).rejects.toThrow();
  abort.abort();
  await rejected;
  expect(outbound.at(-1)).toEqual({ type: 'bot-credential-cancel', id: outbound[1].id });
  const closing = expect(broker.open('agent', { action: 'manage' })).rejects.toThrow();
  broker.close(); await closing;
});

it('does not echo unexpected host statuses', async () => {
  let id: unknown;
  const broker = createBotCredentialHost(message => { id = (message as { id: string }).id; });
  const request = broker.open('agent', { action: 'manage' });
  broker.reply({ type: 'bot-credential-result', id, status: 'fixture-private-value' });
  await expect(request).rejects.not.toThrow(/fixture-private-value/);
});
