import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../extensions/studio-workstation/src/bot-credential-dns.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', write: false });
const { runBotCredentialDnsQuery } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

const use = { name: 'fixture-dns', connector: 'alibaba-cloud-dns', operation: 'list-domains', page: 1,
  fields: { accessKeyId: 'client-id', accessKeySecret: 'client.secret', securityToken: 'session' } };
const stored = { 'client-id': 'FixtureClientId', 'client.secret': 'fixture-only-signing-secret', session: 'fixture-temporary-token', unrelated: 'fixture-not-mapped' };
const transport = (responses, sent) => (options, reply) => {
  sent.push(options);
  const [statusCode, body] = responses.shift();
  const req = new EventEmitter();
  req.end = () => { reply(Object.assign(Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { statusCode })); };
  return req;
};

test('the native connector signs only official read-only DNS calls and never returns raw server data', async () => {
  const sent = [], signal = new AbortController().signal;
  const record = { RR: '@', Type: 'A', Value: '192.0.2.1', TTL: 600, Unknown: stored['client.secret'] };
  const httpsRequest = transport([
    [200, { TotalCount: 1, Domains: { Domain: [{ DomainName: 'example.com', Secret: stored.session }] }, Debug: stored['client.secret'] }],
    [200, { TotalCount: 3, DomainRecords: { Record: [record, { ...record, Value: stored['client.secret'] }, { ...record, Value: Buffer.from(stored.session).toString('base64') }] } }],
  ], sent);
  assert.deepEqual(await runBotCredentialDnsQuery(use, stored, signal, httpsRequest), { status: 'ok', page: 1, total: 1, rows: [{ domain: 'example.com' }] });
  assert.deepEqual(await runBotCredentialDnsQuery({ ...use, operation: 'list-records', domain: 'example.com', page: 2 }, stored, signal, httpsRequest),
    { status: 'ok', page: 2, total: 3, rows: [{ name: '@', type: 'A', value: '192.0.2.1', ttl: 600 }] });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(o => [o.hostname, o.method, o.path, o.headers['x-acs-action']]), [
    ['alidns.aliyuncs.com', 'POST', '/?PageNumber=1&PageSize=20', 'DescribeDomains'],
    ['alidns.aliyuncs.com', 'POST', '/?DomainName=example.com&PageNumber=2&PageSize=20', 'DescribeDomainRecords'],
  ]);
  const first = sent[0];
  assert.equal(first.rejectUnauthorized, true);
  assert.equal(first.headers['x-acs-version'], '2015-01-09');
  assert.equal(first.headers['x-acs-security-token'], stored.session);
  assert.ok(!JSON.stringify(first).includes(stored['client.secret']));
  assert.ok(!JSON.stringify(first).includes(stored.unrelated));
  assert.notEqual(first.headers['x-acs-signature-nonce'], sent[1].headers['x-acs-signature-nonce']);
  const hash = data => createHash('sha256').update(data).digest('hex');
  const signed = ['host', 'x-acs-action', 'x-acs-content-sha256', 'x-acs-date', 'x-acs-security-token', 'x-acs-signature-nonce', 'x-acs-version'];
  const canonical = `POST\n/\nPageNumber=1&PageSize=20\n${signed.map(key => `${key}:${first.headers[key]}\n`).join('')}\n${signed.join(';')}\n${hash('')}`;
  const signature = createHmac('sha256', stored['client.secret']).update(`ACS3-HMAC-SHA256\n${hash(canonical)}`).digest('hex');
  assert.equal(first.headers.authorization, `ACS3-HMAC-SHA256 Credential=${stored['client-id']},SignedHeaders=${signed.join(';')},Signature=${signature}`);
});

test('no network is used for missing fields or cancellation; redirects, denial and malformed bodies are not forwarded', async () => {
  const sent = [], signal = new AbortController().signal;
  const record = { Code: 'fixture', Message: stored['client.secret'] };
  const httpsRequest = transport([[302, record], [403, record], [200, record], [200, 'x'.repeat(257 * 1024)], [200, { TotalCount: 0 }]], sent);
  assert.deepEqual(await runBotCredentialDnsQuery(use, {}, signal, httpsRequest), { status: 'missing-fields' });
  assert.deepEqual(await runBotCredentialDnsQuery(use, stored, AbortSignal.abort(), httpsRequest), { status: 'failed' });
  assert.equal(sent.length, 0);
  for (const status of ['failed', 'denied', 'failed', 'failed']) assert.deepEqual(await runBotCredentialDnsQuery(use, stored, signal, httpsRequest), { status });
  assert.deepEqual(await runBotCredentialDnsQuery(use, stored, signal, httpsRequest), { status: 'ok', page: 1, total: 0, rows: [] });
  assert.equal(sent.length, 5);
});
