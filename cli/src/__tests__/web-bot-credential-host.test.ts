import { expect, it } from 'vitest';
import { createBotCredentialHost } from '../web/bot-credential-host';
import { parseBotCredentialUse } from 'steamharness';

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

it('validates connector replies against the pending use and rejects raw data', async () => {
  const messages: Record<string, unknown>[] = [];
  const broker = createBotCredentialHost(message => messages.push(message as Record<string, unknown>));
  const use = parseBotCredentialUse({ name: 'my-dns', connector: 'alibaba-cloud-dns', operation: 'list-domains',
    fields: { accessKeyId: 'my-id', accessKeySecret: 'my-secret' } });
  const result = { status: 'ok', page: 1, total: 1, rows: [{ domain: 'example.com' }] };
  const request = broker.open('main', { action: 'use', use });
  expect(messages[0]).toMatchObject({ action: 'use', use });
  broker.reply({ type: 'bot-credential-result', id: messages[0].id, result });
  expect(await request).toEqual(result);

  const invalid = broker.open('main', { action: 'use', use });
  broker.reply({ type: 'bot-credential-result', id: messages[1].id, result: { ...result, rows: [{ domain: 'example.com', raw: 'fixture-value' }] } });
  await expect(invalid).rejects.not.toThrow(/fixture-value/);

  const capture = broker.open('main', { action: 'capture', slot: { name: 'my-dns', kind: 'structured' } });
  broker.reply({ type: 'bot-credential-result', id: messages[2].id, result });
  await expect(capture).rejects.toThrow();
});

it('treats a missing conversation approval as a private fallback only for reuse', async () => {
  const messages: Record<string, unknown>[] = [];
  const broker = createBotCredentialHost(message => messages.push(message as Record<string, unknown>));
  const use = parseBotCredentialUse({ name: 'my-dns', connector: 'alibaba-cloud-dns', operation: 'list-domains',
    fields: { accessKeyId: 'my-id', accessKeySecret: 'my-secret' } });
  const scopeId = crypto.randomUUID();
  const pending = broker.open('main', { action: 'use', use, approval: { scopeId, mode: 'reuse' } });
  broker.reply({ type: 'bot-credential-result', id: messages[0].id, status: 'approval-required' });
  await expect(pending).resolves.toBe('approval-required');
  const interactive = broker.open('main', { action: 'use', use, approval: { scopeId, mode: 'prompt' } });
  broker.reply({ type: 'bot-credential-result', id: messages[1].id, status: 'approval-required' });
  await expect(interactive).rejects.toThrow();
});
