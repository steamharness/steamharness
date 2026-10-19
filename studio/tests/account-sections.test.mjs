import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { AccountSections } = await import('../extensions/studio-workstation/src/account-sections.ts');
const connection = { serverUrl: 'https://server.example', accessToken: 'account-token' };
const data = [{ id: 'details', title: 'Details', rows: [{ label: 'Value', value: 'Current' }], actions: [{ id: 'manage', label: 'Manage' }] }];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('the account page has no contributed data until a provider and verified connection exist', async () => {
  const manager = new AccountSections(() => {});
  manager.setConnection(connection);
  await manager.refresh();
  assert.deepEqual(manager.getStates(), []);
  manager.setConnection(undefined);
  let calls = 0;
  manager.register({ id: 'extension', title: 'Extension', load: async () => { calls++; return data; } });
  await manager.refresh();
  assert.equal(calls, 0);
  assert.deepEqual(manager.getStates(), []);
});

test('refreshes coalesce, use a 30 second cache, and keep previous content after a failure', async () => {
  const snapshots = [], pending = deferred();
  const manager = new AccountSections(states => snapshots.push(JSON.stringify(states)));
  let calls = 0, fail = false;
  manager.register({ id: 'extension', title: 'Extension', load: async conn => {
    assert.deepEqual(conn, connection);
    calls++;
    if (fail) { throw new Error('upstream echoed account-token'); }
    await pending.promise;
    return data;
  } });
  manager.setConnection({ ...connection, aiAccessToken: 'other-token' });
  const first = manager.refresh();
  const second = manager.refresh(true);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(manager.getStates()[0].loading, true);
  pending.resolve(); await Promise.all([first, second]);
  await manager.refresh(); assert.equal(calls, 1);
  fail = true;
  const refresh = manager.refresh(true);
  assert.deepEqual(manager.getStates()[0].sections, data);
  await refresh;
  assert.equal(manager.getStates()[0].failed, true);
  assert.deepEqual(manager.getStates()[0].sections, data);
  assert.ok(snapshots.every(snapshot => !snapshot.includes('account-token') && !snapshot.includes('other-token')));
});

test('changing accounts or servers aborts requests and ignores old results, including after sign out', async () => {
  const manager = new AccountSections(() => {}), requests = [];
  manager.register({ id: 'extension', title: 'Extension', load: (conn, signal) => {
    const request = deferred(); requests.push({ ...request, conn, signal }); return request.promise;
  } });
  manager.setConnection(connection);
  const first = manager.refresh(); await Promise.resolve();
  manager.setConnection({ ...connection, serverUrl: 'https://other.example' });
  assert.equal(requests[0].signal.aborted, true);
  const second = manager.refresh(); await Promise.resolve();
  requests[1].resolve(data); await second;
  requests[0].resolve([{ id: 'old', title: 'Old account' }]); await first;
  assert.deepEqual(manager.getStates()[0].sections, data);
  manager.setConnection({ ...connection, accessToken: 'different-account' });
  const third = manager.refresh(); await Promise.resolve();
  assert.deepEqual(manager.getStates()[0].sections, []);
  manager.setConnection(undefined);
  requests[2].resolve(data); await third;
  assert.equal(requests[2].signal.aborted, true);
  assert.deepEqual(manager.getStates(), []);
});

test('only published actions run, and unregistering a provider cancels its pending work', async () => {
  const manager = new AccountSections(() => {}), actions = [];
  const provider = manager.register({ id: 'extension', title: 'Extension', load: async () => data, onAction: (action, conn) => { actions.push({ action, conn }); } });
  manager.setConnection(connection); await manager.refresh();
  await manager.runAction('extension', 'unexpected');
  await manager.runAction('unknown', 'manage');
  await manager.runAction('extension', 'manage');
  assert.deepEqual(actions, [{ action: 'manage', conn: connection }]);
  provider.dispose();
  assert.deepEqual(manager.getStates(), []);
  const pending = deferred(); let signal;
  manager.register({ id: 'pending', title: 'Pending', load: (_conn, value) => { signal = value; return pending.promise; } });
  const refresh = manager.refresh(); await Promise.resolve(); manager.dispose();
  assert.equal(signal.aborted, true);
  pending.resolve(data); await refresh;
  assert.deepEqual(manager.getStates(), []);
});
