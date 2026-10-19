import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { register } from 'tsx/esm/api';

register();
const {
  Account, ServerClient, normalizeProjectServerUrl, projectAuthEnvironment,
  isPrivateEnvironmentKey, sanitizeProjectEnvironment,
} = await import('../extensions/studio-workstation/src/workflow-auth-client.ts');

const serverUrl = 'https://dev.workflow.test';
const user = { userId: 'test-user', email: 'user@example.test', displayName: 'Studio User', avatarUrl: '/avatar/user.png' };
const token = 'test-studio-session';

test('worker environment filtering removes internal extension and cloud credential paths', () => {
  const environment = sanitizeProjectEnvironment({
    PATH: '/bin',
    STEAMHARNESS_STUDIO_INTERNAL: '1',
    STEAMHARNESS_STUDIO_INTERNAL_MODULE: '/private/extension-layer.mjs',
    STEAMHARNESS_STUDIO_INTERNAL_SERVER_URL: 'http://127.0.0.1:7127',
    GOOGLE_APPLICATION_CREDENTIALS: '/private/gcp.json',
    AWS_SHARED_CREDENTIALS_FILE: '/private/aws-credentials',
    AWS_CONFIG_FILE: '/private/aws-config',
    DOCKER_CONFIG: '/private/docker',
    KUBECONFIG: '/private/kubeconfig',
    SSH_AUTH_SOCK: '/private/ssh-agent.sock',
    STEAMHARNESS_RUNTIME_LOCALE: 'zh-CN',
  });
  assert.deepEqual(environment, { PATH: '/bin', STEAMHARNESS_RUNTIME_LOCALE: 'zh-CN' });
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'DOCKER_CONFIG', 'KUBECONFIG', 'SSH_AUTH_SOCK']) {
    assert.equal(isPrivateEnvironmentKey(key), true, key);
  }
});

function fixture() {
  let stored;
  let acceptedToken = token;
  let profile = user;
  let unavailable = false;
  let gate;
  let verificationGate;
  const events = [];
  const requests = [];
  const writes = [];
  const fetcher = async (url, options) => {
    requests.push({ url, ...options });
    if (unavailable) { throw new Error('Network unavailable'); }
    const path = new URL(url).pathname;
    let data;
    let status = 200;
    if (path === '/api/auth/login') {
      if (gate) { await gate; }
      const body = JSON.parse(options.body);
      if (body.password !== 'correct-password') { status = 401; }
      else { data = { authenticated: true, accessToken: acceptedToken, apiKey: { id: `key-${acceptedToken}` } }; }
    } else if (options.method === 'DELETE') {
      if (options.headers.Cookie !== 'wf_session=test-cookie') { status = 403; }
      else { data = { revoked: true }; }
    } else if (path === '/api/auth/logout') { data = { loggedOut: true }; }
    else if (options.headers.Authorization !== `Bearer ${acceptedToken}`) { status = 401; }
    else if (path === '/api/auth/me') {
      if (verificationGate) { await verificationGate; }
      data = { profile, principal: { apiKeyId: `key-${acceptedToken}`, expiresAt: '2099-01-01T00:00:00Z' } };
    }
    else { throw new Error(`Unexpected request: ${path}`); }
    return Response.json({ errCode: status === 200 ? 0 : status, errMessage: status === 401 ? 'Unauthorized' : '', data }, {
      status, headers: path === '/api/auth/login' && status === 200 ? { 'Set-Cookie': 'wf_session=test-cookie; HttpOnly; Path=/; SameSite=Lax' } : {},
    });
  };
  const secrets = { get: async () => stored, store: async (value) => { writes.push(value); stored = value; }, delete: async () => { writes.push(undefined); stored = undefined; } };
  const account = new Account(serverUrl, secrets, (event) => events.push(event), (url) => new ServerClient(url, fetcher));
  return {
    account, secrets, events, requests, writes, fetcher,
    get stored() { return stored; },
    set stored(value) { stored = value; },
    set token(value) { acceptedToken = value; },
    set profile(value) { profile = value; },
    set unavailable(value) { unavailable = value; },
    set gate(value) { gate = value; },
    set verificationGate(value) { verificationGate = value; },
  };
}

test('desktop password login verifies the issued token and keeps it out of public account state', async () => {
  const f = fixture();
  await f.account.restore();
  await f.account.login(`${serverUrl}/`, user.email, 'correct-password');
  assert.equal(f.account.getState().status, 'authenticated');
  assert.deepEqual(f.account.getState().user, { ...user, avatarUrl: `${serverUrl}/avatar/user.png` });
  assert.deepEqual(f.account.getConnection(), { serverUrl, accessToken: token });
  assert.equal(JSON.parse(f.stored).accessToken, token);
  assert.equal(JSON.stringify(f.events).includes(token), false);
  assert.equal(JSON.parse(f.stored).sessionCookie, 'wf_session=test-cookie');
  assert.equal(JSON.stringify(f.events).includes('test-cookie'), false);
  assert.deepEqual(JSON.parse(f.requests[0].body), {
    email: user.email, password: 'correct-password', source: 'desktop', clientName: 'Studio Workstation',
  });
  assert.equal(f.requests[0].headers.Authorization, undefined);
  assert.equal(f.requests[1].headers.Authorization, `Bearer ${token}`);
});

test('account avatars accept Server image data URLs and local storage URLs', async () => {
  const f = fixture();
  for (const avatarUrl of [
    ...['png', 'jpeg', 'jpg', 'webp', 'gif'].map(type => `data:image/${type};base64,YXZhdGFy`),
    'http://127.0.0.1:7126/storage/avatars/user/avatar.png',
  ]) {
    f.profile = { ...user, avatarUrl };
    const session = await new ServerClient(serverUrl, f.fetcher).verify({ serverUrl, accessToken: token });
    assert.equal(session.user.avatarUrl, avatarUrl);
  }
  for (const avatarUrl of ['data:text/html;base64,YXZhdGFy', 'data:image/svg+xml;base64,YXZhdGFy', 'javascript:alert(1)', 'https://user:password@example.test/avatar.png', `data:image/png;base64,${'a'.repeat(1024 * 1024)}`]) {
    f.profile = { ...user, avatarUrl };
    const session = await new ServerClient(serverUrl, f.fetcher).verify({ serverUrl, accessToken: token });
    assert.equal(session.user.avatarUrl, undefined);
  }
});

test('a rejected password or missing profile never becomes a saved login', async () => {
  const f = fixture();
  await f.account.restore();
  await assert.rejects(f.account.login(serverUrl, user.email, 'incorrect-password'), /Incorrect email or password/);
  assert.equal(f.stored, undefined);
  assert.equal(f.account.getConnection(), undefined);
  f.profile = null;
  await assert.rejects(f.account.login(serverUrl, user.email, 'correct-password'), /account information/);
  assert.equal(f.stored, undefined);
  assert.equal(f.account.getState().status, 'error');
});

test('AI connection is cleared when the project account changes or signs out', async () => {
  const f = fixture();
  await f.account.login(serverUrl, user.email, 'correct-password');
  f.account.setAiConnection({ serverUrl: 'https://ai.workflow.test', accessToken: 'ai-session' });
  assert.equal(f.account.getConnection().aiAccessToken, 'ai-session');
  const otherProfile = { ...user, userId: 'other-user', email: 'other@example.test' };
  f.profile = otherProfile;
  f.token = 'other-studio-session';
  await f.account.login(serverUrl, otherProfile.email, 'correct-password');
  assert.equal(f.account.getConnection().aiAccessToken, undefined);
  f.account.setAiConnection({ serverUrl: 'https://ai.workflow.test', accessToken: 'ai-session' });
  await f.account.logout(false);
  assert.equal(f.account.getConnection(), undefined);
});

test('restoring credentials requires server verification and survives a temporary connection failure', async () => {
  const f = fixture();
  await f.account.login(serverUrl, user.email, 'correct-password');
  const saved = f.stored;
  f.unavailable = true;
  const restored = new Account(serverUrl, f.secrets, () => undefined, (url) => new ServerClient(url, f.fetcher));
  await restored.restore();
  assert.equal(restored.getState().status, 'error');
  assert.equal(restored.getConnection(), undefined);
  assert.equal(f.stored, saved);
  f.unavailable = false;
  await restored.verify();
  assert.equal(restored.getState().status, 'authenticated');
});

test('expired or revoked credentials clear the stored session and cannot reach a worker', async () => {
  const f = fixture();
  await f.account.restore();
  await f.account.login(serverUrl, user.email, 'correct-password');
  f.token = 'revoked-token';
  await f.account.verify();
  assert.equal(f.account.getState().status, 'expired');
  assert.equal(f.account.getConnection(), undefined);
  assert.equal(f.stored, undefined);
  f.stored = JSON.stringify({ serverUrl, accessToken: token, expiresAt: '2000-01-01T00:00:00Z' });
  const requestCount = f.requests.length;
  await f.account.restore();
  assert.equal(f.account.getState().status, 'expired');
  assert.equal(f.requests.length, requestCount);
});

test('a different server cannot receive saved credentials', async () => {
  const f = fixture();
  f.stored = JSON.stringify({ serverUrl: 'https://other.workflow.test', accessToken: token });
  await f.account.restore();
  assert.equal(f.account.getState().status, 'signed-out');
  assert.equal(f.requests.length, 0);
  assert.equal(f.stored, undefined);
  await f.account.login(serverUrl, user.email, 'correct-password');
  await f.account.changeServer('https://next.workflow.test');
  assert.equal(f.account.getState().serverUrl, 'https://next.workflow.test');
  assert.equal(f.account.getConnection(), undefined);
  assert.equal(f.stored, undefined);
});

test('logout wins over an unfinished login and revokes only this Studio session', async () => {
  const f = fixture();
  await f.account.restore();
  let release;
  f.gate = new Promise((resolve) => { release = resolve; });
  const pending = f.account.login(serverUrl, user.email, 'correct-password');
  await f.account.logout();
  release();
  await pending;
  assert.equal(f.account.getState().status, 'signed-out');
  assert.equal(f.stored, undefined);
  assert.ok(f.requests.some((request) => request.method === 'DELETE'));
  f.gate = undefined;
  await f.account.login(serverUrl, user.email, 'correct-password');
  await f.account.logout();
  const revoke = f.requests.find((request) => request.method === 'DELETE');
  assert.equal(revoke.url, `${serverUrl}/api/auth/api-keys/key-${token}`);
  assert.equal(revoke.headers.Cookie, 'wf_session=test-cookie');
  assert.equal(revoke.headers.Authorization, undefined);
  assert.equal(f.requests.at(-1).url, `${serverUrl}/api/auth/logout`);
});

test('verification and restore preserve the cookie required to revoke the issued API key', async () => {
  const f = fixture(); await f.account.login(serverUrl, user.email, 'correct-password'); await f.account.verify();
  assert.equal(JSON.parse(f.stored).sessionCookie, 'wf_session=test-cookie');
  const restored = new Account(serverUrl, f.secrets, () => undefined, (url) => new ServerClient(url, f.fetcher));
  await restored.restore(); await restored.logout();
  assert.ok(f.requests.some((request) => request.method === 'DELETE' && request.headers.Cookie === 'wf_session=test-cookie'));
});

test('concurrent verification keeps the verified account available and shares one server request', async () => {
  const f = fixture(); await f.account.restore(); await f.account.login(serverUrl, user.email, 'correct-password');
  const connection = f.account.getConnection();
  let release;
  f.verificationGate = new Promise(resolve => { release = resolve; });
  const count = f.requests.length;
  const checks = [f.account.verify(), f.account.verify(), f.account.verify()];
  try {
    assert.equal(f.account.getState().status, 'checking');
    assert.deepEqual(f.account.getConnection(), connection);
    assert.equal(f.account.getSession().user.avatarUrl, `${serverUrl}/avatar/user.png`);
    assert.equal(f.requests.length - count, 1);
  } finally { release(); await Promise.all(checks); }
  assert.equal(f.account.getState().status, 'authenticated');
});

test('unchanged verification does not write secrets or disconnect an account on network failure', async () => {
  const f = fixture(); await f.account.restore(); await f.account.login(serverUrl, user.email, 'correct-password');
  const connection = f.account.getConnection(), writes = f.writes.length;
  await f.account.verify(); await f.account.restore();
  assert.equal(f.writes.length, writes);
  f.unavailable = true; await f.account.verify();
  assert.equal(f.account.getState().status, 'error');
  assert.deepEqual(f.account.getConnection(), connection);
  f.token = 'revoked-token'; f.unavailable = false; await f.account.verify();
  assert.equal(f.account.getConnection(), undefined);
  assert.equal(f.account.getState().status, 'expired');
});

test('background profile refresh updates and clears avatars without changing the connection or flashing account state', async () => {
  const f = fixture(); await f.account.login(serverUrl, user.email, 'correct-password');
  const connection = f.account.getConnection(), eventCount = f.events.length, writes = f.writes.length;
  await f.account.refresh();
  assert.equal(f.events.length, eventCount);
  assert.equal(f.writes.length, writes);

  const avatarUrl = 'data:image/png;base64,YXZhdGFy';
  f.profile = { ...user, displayName: 'Updated user', avatarUrl };
  let release;
  f.verificationGate = new Promise(resolve => { release = resolve; });
  const requests = f.requests.length;
  const refreshing = [f.account.refresh(), f.account.refresh()];
  assert.equal(f.requests.length - requests, 1);
  assert.equal(f.account.getState().status, 'authenticated');
  assert.deepEqual(f.account.getConnection(), connection);
  release(); await Promise.all(refreshing);
  assert.equal(f.account.getState().user.avatarUrl, avatarUrl);
  assert.equal(f.account.getState().user.displayName, 'Updated user');
  assert.equal(JSON.parse(f.stored).user.avatarUrl, avatarUrl);
  assert.deepEqual(f.events.slice(eventCount).map(state => state.status), ['authenticated']);
  assert.deepEqual(f.account.getConnection(), connection);

  f.profile = { ...user, avatarUrl: undefined };
  await f.account.refresh();
  assert.equal(f.account.getState().user.avatarUrl, undefined);
});

test('background profile refresh preserves login on network failure and expires revoked credentials', async () => {
  const f = fixture(); await f.account.login(serverUrl, user.email, 'correct-password');
  const state = f.account.getState(), connection = f.account.getConnection(), writes = f.writes.length;
  f.unavailable = true; await f.account.refresh();
  assert.deepEqual(f.account.getState(), state);
  assert.deepEqual(f.account.getConnection(), connection);
  assert.equal(f.writes.length, writes);
  f.unavailable = false; f.token = 'revoked-token';
  await f.account.refresh();
  assert.equal(f.account.getState().status, 'expired');
  assert.equal(f.account.getConnection(), undefined);
  assert.equal(f.stored, undefined);
});

test('background profile refresh cannot interrupt login or restore an account after logout', async () => {
  const f = fixture(); await f.account.refresh();
  assert.equal(f.requests.length, 0);
  await f.account.login(serverUrl, user.email, 'correct-password');
  let release;
  f.gate = new Promise(resolve => { release = resolve; });
  const signingIn = f.account.login(serverUrl, user.email, 'correct-password');
  const requests = f.requests.length;
  await f.account.refresh();
  assert.equal(f.requests.length, requests);
  release(); await signingIn;
  f.verificationGate = new Promise(resolve => { release = resolve; });
  const refreshing = f.account.refresh();
  await f.account.logout(false);
  release(); await refreshing;
  assert.equal(f.account.getState().status, 'signed-out');
  assert.equal(f.account.getConnection(), undefined);
  assert.equal(f.stored, undefined);
});

test('restoring another window\'s credentials verifies them without writing back refreshed metadata', async () => {
  const f = fixture(); await f.account.login(serverUrl, user.email, 'correct-password');
  const saved = f.stored, writes = f.writes.length;
  f.profile = { ...user, displayName: 'Updated profile' };
  const restored = new Account(serverUrl, f.secrets, () => undefined, url => new ServerClient(url, f.fetcher));
  await restored.restore();
  assert.equal(restored.getState().user.displayName, 'Updated profile');
  assert.equal(f.stored, saved);
  assert.equal(f.writes.length, writes);
});

test('an old secret read cannot restore credentials after logout', async () => {
  const f = fixture(); await f.account.restore(); await f.account.login(serverUrl, user.email, 'correct-password');
  const saved = f.stored;
  let release;
  f.secrets.get = () => new Promise(resolve => { release = () => resolve(saved); });
  const restoring = f.account.restore();
  await new Promise(resolve => setImmediate(resolve));
  await f.account.logout(false); release(); await restoring;
  assert.equal(f.account.getState().status, 'signed-out');
  assert.equal(f.account.getConnection(), undefined);
  assert.equal(f.stored, undefined);
});

test('system AI usage and server resource cards use the active account and dev API contracts', async () => {
  const calls = [];
  const client = new ServerClient(serverUrl, async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    if (path === '/api/ai/usage') {
      assert.equal(options.headers.Authorization, 'Bearer ai-token');
      return new Response(JSON.stringify({ errCode: 0, data: { balance: 12, groups: [] } }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ errCode: 0, data: String(url).includes('/files?') ? { files: [{ path: 'notes.md', content: 'Notes' }] } : {} }), { headers: { 'Content-Type': 'application/json' } });
  });
  const aiServerUrl = 'https://ai.workflow.test';
  const connection = { serverUrl, accessToken: token, aiServerUrl, aiAccessToken: 'ai-token' };
  await client.systemAiUsage(connection);
  await client.resource(connection, 'kv', { projectId: 'project', scope: 'conversation', conversationId: 'session', key: 'a key' });
  await client.resource(connection, 'knowledge', { projectId: 'project', documentId: 'document' });
  const file = await client.resource(connection, 'file', { projectId: 'project', filePath: 'notes.md' });
  assert.equal(file.content, 'Notes');
  assert.deepEqual(calls.map((call) => call.url), [
    `${aiServerUrl}/api/ai/usage`, `${serverUrl}/api/projects/project/kv/entry?scope=conversation&conversationId=session&key=a+key`,
    `${serverUrl}/api/projects/project/knowledge-documents/document`, `${serverUrl}/api/projects/project/files?target=latest&includeBinary=true`,
  ]);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ai-token');
  assert.ok(calls.slice(1).every((call) => call.options.headers.Authorization === `Bearer ${token}` && call.options.redirect === 'error'));
  await assert.rejects(client.resource({ serverUrl: 'https://wrong.test', accessToken: token }, 'knowledge', { projectId: 'project' }), /Invalid resource server/);
});

test('an old worker failure cannot invalidate a newer login', async () => {
  const f = fixture();
  await f.account.restore();
  await f.account.login(serverUrl, user.email, 'correct-password');
  const oldConnection = f.account.getConnection();
  f.token = 'new-studio-session';
  await f.account.login(serverUrl, user.email, 'correct-password');
  await f.account.invalidate(oldConnection);
  assert.equal(f.account.getState().status, 'authenticated');
  assert.equal(f.account.getConnection().accessToken, 'new-studio-session');
});

test('worker and CLI environments isolate Studio credentials from inherited and saved logins', () => {
  const inherited = { STEAMHARNESS_LLM_SERVER_URL: 'https://old.workflow.test', STEAMHARNESS_LLM_SERVER_TOKEN: 'old-token', STEAMHARNESS_SERVER_TOKEN: 'legacy-token', PATH: '/usr/bin' };
  const loggedOut = projectAuthEnvironment(inherited, undefined, '/studio/auth');
  assert.deepEqual(loggedOut, {
    STEAMHARNESS_AI_SERVER_URL: '', STEAMHARNESS_AI_API_KEY: '', STEAMHARNESS_SERVER_TOKEN: '', PATH: '/usr/bin',
    STEAMHARNESS_SERVER_URL: '', STEAMHARNESS_SERVER_ADMIN_KEY: '', STEAMHARNESS_CLI_AUTH_DIR: '/studio/auth',
  });
  const loggedIn = projectAuthEnvironment(inherited, { serverUrl, accessToken: token }, '/studio/auth');
  assert.equal(loggedIn.STEAMHARNESS_SERVER_ADMIN_KEY, token);
  assert.equal(loggedIn.STEAMHARNESS_AI_SERVER_URL, '');
  assert.equal(loggedIn.STEAMHARNESS_AI_API_KEY, '');
  const withAi = projectAuthEnvironment(inherited, { serverUrl, accessToken: token, aiServerUrl: 'https://ai.workflow.test', aiAccessToken: 'ai-token' }, '/studio/auth');
  assert.equal(withAi.STEAMHARNESS_AI_SERVER_URL, 'https://ai.workflow.test');
  assert.equal(withAi.STEAMHARNESS_AI_API_KEY, 'ai-token');
  assert.equal(withAi.STEAMHARNESS_LLM_SERVER_URL, undefined);
  assert.equal(withAi.STEAMHARNESS_LLM_SERVER_TOKEN, undefined);
});

test('server URLs reject embedded credentials and authenticated redirects never forward the token', async (t) => {
  for (const url of ['file:///tmp/server', 'https://user:password@example.test', 'https://example.test?token=secret']) {
    assert.throws(() => normalizeProjectServerUrl(url));
  }
  // Loopback spellings are the same server; a stored session must survive a
  // restart that switches between `localhost`, `127.0.0.1` and `[::1]`.
  for (const url of ['http://localhost:7126', 'http://127.0.0.1:7126/', 'http://[::1]:7126']) {
    assert.equal(normalizeProjectServerUrl(url), 'http://127.0.0.1:7126');
  }
  let redirectedRequests = 0;
  const destination = createServer((_req, res) => { redirectedRequests++; res.end('{}'); });
  await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const source = createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/capture` }); res.end();
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  t.after(() => Promise.all([source, destination].map((server) => new Promise((resolve) => server.close(resolve)))));
  const localUrl = `http://127.0.0.1:${source.address().port}`;
  await assert.rejects(new ServerClient(localUrl).verify({ serverUrl: localUrl, accessToken: token }), /SteamHarness Server/);
  assert.equal(redirectedRequests, 0);
});
