import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';
register();
const { registerWebAppProvider, openWebApp } = await import('../extensions/studio-workstation/src/web-app-providers.ts');
const request = signal => ({ projectId: 'project', entryId: 'main', service: 'sample.app', connection: { serverUrl: 'https://account.invalid', accessToken: 'host-secret' }, signal });

test('an unmatched or ambiguous provider cannot open a project application', async t => {
  await assert.rejects(openWebApp(request(new AbortController().signal)), /No unique/);
  const provider = { matches: () => true, open: async () => { throw Error('must not run'); } };
  const a = registerWebAppProvider(provider), b = registerWebAppProvider({ ...provider });
  t.after(() => { a.dispose(); b.dispose(); });
  await assert.rejects(openWebApp(request(new AbortController().signal)), /No unique/);
});

test('a late authorization result is disposed after account cancellation', async t => {
  let complete, disposed = 0;
  const registration = registerWebAppProvider({ matches: () => true, open: () => new Promise(resolve => { complete = resolve; }) });
  t.after(() => registration.dispose());
  const abort = new AbortController(), pending = openWebApp(request(abort.signal));
  abort.abort(); complete({ binding: { service: 'sample.app' }, dispose: () => { disposed++; } });
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(disposed, 1);
});

test('a provider cannot substitute another service', async t => {
  let disposed = 0;
  const registration = registerWebAppProvider({ matches: () => true, open: async () => ({ binding: { service: 'other.app' }, dispose: () => { disposed++; } }) });
  t.after(() => registration.dispose());
  await assert.rejects(openWebApp(request(new AbortController().signal)), /mismatch/); assert.equal(disposed, 1);
});
