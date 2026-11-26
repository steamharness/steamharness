import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildStudioNode as build } from '../scripts/node-extension-build.mjs';
import ssh from 'ssh2';

const { Server, utils } = ssh;

const root = fileURLToPath(new URL('../extensions/studio-workstation/src/', import.meta.url));
const { outputFiles } = await build({ stdin: { resolveDir: root, contents: `
  export { runBotCredentialHttpQuery } from './bot-credential-http';
  export { runBotCredentialSshQuery } from './bot-credential-ssh';
  export { botCredentialCommandSupported, runBotCredentialCommand } from './bot-credential-command';
  export { resolveCredentialAddress } from './bot-credential-network';
  export { botCredentialUseOperations, prepareBotCredentialOperation } from './bot-credential-operations';
` }, bundle: true, format: 'esm', platform: 'node', write: false,
  banner: { js: "import {createRequire} from 'node:module'; const __dirname = process.cwd(); const require = createRequire(__dirname + '/package.json');" } });
const { runBotCredentialHttpQuery, runBotCredentialSshQuery, resolveCredentialAddress, botCredentialUseOperations, prepareBotCredentialOperation,
  botCredentialCommandSupported, runBotCredentialCommand } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const signal = new AbortController().signal;
const exampleAddress = async () => ({ address: '203.0.113.10', family: 4 });

function httpsFixture(body, inspect, statusCode = 200, type = 'application/json; charset=utf-8') {
  return (options, callback) => {
    const req = new EventEmitter();
    req.end = () => {
      inspect?.(options);
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = statusCode;
      response.headers = { 'content-type': type, location: 'https://unapproved.example.test/redirect' };
      callback(response);
    };
    return req;
  };
}

const use = { name: 'saved-token', connector: 'host', operation: 'https.get-json', args: {
  url: 'https://GIT.example.test:9443/api/v4/user', auth: { kind: 'api-key', scheme: 'header', header: 'PRIVATE-TOKEN' },
} };

test('host registry normalizes targets and rejects unregistered or unsafe operations', () => {
  assert.ok(botCredentialUseOperations.some(item => item.id === use.operation));
  const operation = prepareBotCredentialOperation(use);
  assert.equal(operation.target, 'https://git.example.test:9443/api/v4/user');
  assert.deepEqual(operation.slots, [{ name: 'saved-token', kind: 'api-key' }]);
  assert.throws(() => prepareBotCredentialOperation({ ...use, operation: 'https.post' }));
  for (const url of ['http://example.test/', 'https://user:pass@example.test/', 'https://example.test/#note', 'https://127.1/', 'https://a.localhost/', 'https://example.test:0/']) {
    assert.throws(() => prepareBotCredentialOperation({ ...use, args: { ...use.args, url } }));
  }
  for (const header of ['HOST', 'X-Forwarded-Host', 'Transfer-Encoding', 'X-HTTP-Method-Override', 'Cookie', 'Accept-Encoding', 'x-token\r\n']) {
    assert.throws(() => prepareBotCredentialOperation({ ...use, args: { ...use.args, auth: { ...use.args.auth, header } } }));
  }
  assert.throws(() => prepareBotCredentialOperation({ ...use, args: { ...use.args, auth: { kind: 'structured', scheme: 'headers', headers: { 'X-Token': 'token', 'x-token': 'different' } } } }));
});

test('HTTPS can use a saved single-value token, password, or structured fields without an adapter per service', async () => {
  const credential = 'fixture-token-not-a-real-credential';
  const request = prepareBotCredentialOperation(use).binding;
  const cases = [
    [request.auth, ` ${credential} `, { 'private-token': credential }],
    [{ kind: 'password', scheme: 'basic', username: 'local-user' }, credential, { authorization: `Basic ${Buffer.from(`local-user:${credential}`).toString('base64')}` }],
    [{ kind: 'structured', scheme: 'bearer', field: 'AccessToken' }, { AccessToken: credential }, { authorization: `Bearer ${credential}` }],
    [{ kind: 'access-key-pair', scheme: 'headers', headers: { 'x-id': 'AccessKeyId', 'x-key': 'AccessKeySecret' } },
      { AccessKeyId: 'fixture-id', AccessKeySecret: credential }, { 'x-id': 'fixture-id', 'x-key': credential }],
  ];
  for (const [auth, stored, expected] of cases) {
    const fixture = httpsFixture('{"id":5,"username":"example-user"}', options => {
      assert.equal(options.hostname, 'git.example.test');
      assert.equal(options.port, 9443);
      assert.equal(options.path, '/api/v4/user');
      assert.equal(options.method, 'GET');
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false);
      assert.deepEqual(options.headers, { ...expected, accept: 'application/json', 'accept-encoding': 'identity' });
      options.lookup('git.example.test', { all: true }, (err, addresses) => assert.deepEqual(addresses, [ { address: '203.0.113.10', family: 4 } ]));
    });
    assert.deepEqual(await runBotCredentialHttpQuery({ ...request, auth }, stored, signal, fixture, exampleAddress),
      { status: 'ok', data: { httpStatus: 200, body: { id: 5, username: 'example-user' } } });
  }
});

test('HTTPS never follows redirects or returns reflected values, headers, oversized responses, or remote errors', async () => {
  const credential = 'fixture-only-secret-value';
  const request = prepareBotCredentialOperation(use).binding;
  for (const [body, status, expected, reason] of [
    [JSON.stringify({ [credential]: 'header echo' }), 200, 'failed', 'unsafe-response'],
    [JSON.stringify({ echo: Buffer.from(credential).toString('base64') }), 200, 'failed', 'unsafe-response'],
    [JSON.stringify({ oversized: 'x'.repeat(64 * 1024) }), 200, 'failed', 'response-too-large'],
    ['not valid JSON', 200, 'failed', 'invalid-response'],
    [JSON.stringify({ redirect: credential }), 302, 'failed', 'redirect'],
    [JSON.stringify({ error: credential }), 401, 'denied', 'http-error'],
    [JSON.stringify({ error: credential }), 403, 'denied', 'http-error'],
  ]) {
    let requests = 0;
    assert.deepEqual(await runBotCredentialHttpQuery(request, credential, signal, httpsFixture(body, () => requests++, status), exampleAddress), { status: expected, reason, httpStatus: status });
    assert.equal(requests, 1);
  }
});

test('the address filter admits IPv4 and IPv6 targets without admitting special or mapped destinations', async () => {
  assert.deepEqual(await resolveCredentialAddress('203.0.113.10', signal), { address: '203.0.113.10', family: 4 });
  assert.deepEqual(await resolveCredentialAddress('2001:db8::1', signal), { address: '2001:db8::1', family: 6 });
  for (const address of ['127.0.0.1', '169.254.169.254', '::1', '::ffff:203.0.113.10', 'fe80::1']) {
    await assert.rejects(resolveCredentialAddress(address, signal), /No eligible/);
  }
});

test('approved command receives only an anonymous file handle and reflected values never make a receipt', { skip: !botCredentialCommandSupported }, async () => {
  const secret = 'fixture-only-command-secret';
  const run = script => runBotCredentialCommand({ program: process.execPath, args: ['-e', script] }, secret, process.cwd(), signal);
  const script = `const fs=require('node:fs'); const v=fs.readFileSync(process.env.STEAMHARNESS_BOT_CREDENTIAL_FILE, 'utf8');
    const file=fs.fstatSync(3); process.stdout.write(JSON.stringify({anonymous:file.nlink===0,private:(file.mode&0o777)===0o600,
    length:v.length,containsValue:Object.values(process.env).includes(v)||process.argv.includes(v)}));`;
  const result = await run(script);
  assert.equal(result.status, 'ok');
  assert.deepEqual(JSON.parse(result.data.stdout), { anonymous: true, private: true, length: secret.length, containsValue: false });
  assert.deepEqual(await run(`process.stdout.write(require('node:fs').readFileSync(process.env.STEAMHARNESS_BOT_CREDENTIAL_FILE))`),
    { status: 'failed', reason: 'unsafe-response' });
});

test('SSH verifies the pinned host key before authenticating and reads only SFTP directory entries', { timeout: 6_000 }, async () => {
  const host = utils.generateKeyPairSync('ed25519');
  const passphrase = 'fixture-only-ssh-passphrase';
  const key = utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 4 });
  const publicKey = utils.parseKey(key.public);
  const hostKey = utils.parseKey(host.public);
  const fingerprint = `SHA256:${createHash('sha256').update(hostKey.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  let authentications = 0, directoryReads = 0;
  const fixture = new Server({ hostKeys: [host.private] }, connection => {
    connection.on('error', () => undefined);
    connection.on('authentication', ctx => {
      authentications++;
      if (ctx.method !== 'publickey' || ctx.username !== 'fixture' || !ctx.key.data.equals(publicKey.getPublicSSH())
        || ctx.signature && publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) ctx.reject(['publickey']);
      else ctx.accept();
    });
    connection.on('ready', () => connection.on('session', accept => accept().on('sftp', accept => {
      const sftp = accept();
      sftp.on('error', () => undefined);
      sftp.on('OPENDIR', (id, path) => path === '/reports' ? sftp.handle(id, Buffer.from([1])) : sftp.status(id, utils.sftp.STATUS_CODE.PERMISSION_DENIED));
      sftp.on('READDIR', (id) => {
        if (directoryReads++) sftp.status(id, utils.sftp.STATUS_CODE.EOF);
        else sftp.name(id, [{ filename: 'report.json', longname: '', attrs: { mode: 0o100644 } }]);
      });
      sftp.on('CLOSE', id => sftp.status(id, utils.sftp.STATUS_CODE.OK));
    })));
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  try {
    const target = { host: 'ssh.example.test', port: fixture.address().port, username: 'fixture', fingerprint };
    const localFixtureAddress = async () => ({ address: '127.0.0.1', family: 4 });
    assert.deepEqual(await runBotCredentialSshQuery({ ...target, fingerprint: `SHA256:${'A'.repeat(43)}`, operation: 'authenticate' }, key.private, passphrase, signal, localFixtureAddress), { status: 'failed' });
    assert.equal(authentications, 0, 'a wrong server key must not receive authentication');
    assert.deepEqual(await runBotCredentialSshQuery({ ...target, operation: 'authenticate' }, key.private, passphrase, signal, localFixtureAddress),
      { status: 'ok', data: { authenticated: true } });
    assert.deepEqual(await runBotCredentialSshQuery({ ...target, operation: 'list-directory', path: '/reports' }, key.private, passphrase, signal, localFixtureAddress),
      { status: 'ok', data: { authenticated: true, entries: [{ name: 'report.json', type: 'file' }], truncated: false } });
  } finally { await new Promise(resolve => fixture.close(resolve)); }
});
