import { afterEach, expect, it } from 'vitest';
import { createMemoryRuntimePersistence, type RuntimePersistence } from 'steamharness/runtime-storage';
import { ConversationOwnership } from '../web/conversation-ownership';
const owners: ConversationOwnership[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); });
function fixture(scope?: (id: string) => string) {
  const persistence = createMemoryRuntimePersistence();
  const owner = () => { const value = new ConversationOwnership(() => persistence, scope); owners.push(value); return value; };
  return { persistence, owner };
}
it('admits one process and one page per conversation while allowing independent conversations', async () => {
  const f = fixture(), one = f.owner(), two = f.owner();
  await one.assertWritable('same', 'page-a');
  expect(one.select('page-a', 'same').readOnly).toBe(false);
  expect(one.select('page-b', 'same').readOnly).toBe(true);
  await expect(two.assertWritable('same', 'page-c')).rejects.toThrow('another window');
  await two.assertWritable('different', 'page-c');
  expect(two.select('page-c', 'different').readOnly).toBe(false);
  await one.close(); await two.assertWritable('same', 'page-c');
});
it('retains the execution owner after navigation and releases idle scopes', async () => {
  const f = fixture(), one = f.owner(), two = f.owner();
  await one.assertWritable('running', 'page'); one.select('page', 'running');
  expect(one.execute('running')).toBe(true);
  one.select('page', 'other');
  await expect(two.assertWritable('running')).rejects.toThrow('another window');
  one.update(new Set(), new Set());
  await two.assertWritable('running'); expect(two.owns('running')).toBe(true);
});
it('groups child execution with its root and retains an independent scope through its save', async () => {
  const f = fixture(id => id === 'child' ? 'root' : id), one = f.owner(), two = f.owner();
  await one.assertWritable('root', 'root-page'); one.select('root-page', 'root');
  await one.assertWritable('child', 'child-page'); one.select('child-page', 'child');
  expect(one.owns('child')).toBe(true); await expect(two.assertWritable('child')).rejects.toThrow('another window');
  const independent = new ConversationOwnership(() => f.persistence); owners.push(independent);
  await one.close(); await independent.assertWritable('child');
  const release = await independent.independent('child');
  independent.update(new Set(), new Set()); expect(independent.owns('child')).toBe(true);
  release(); independent.update(new Set(), new Set()); expect(independent.owns('child')).toBe(false);
});
it('waits for in-flight acquisitions when identity changes and never retains their leases', async () => {
  const persistence = createMemoryRuntimePersistence(); let resolve!: () => void;
  const gate = new Promise<void>(done => { resolve = done; });
  const delayed = { ...persistence, acquire: async (scope: string) => { await gate; return persistence.acquire(scope); } };
  const owner = new ConversationOwnership(() => delayed); owners.push(owner);
  const acquiring = owner.acquire('old'); const reset = owner.reset(); resolve(); await acquiring; await reset;
  expect(owner.owns('old')).toBe(false);
  const lease = await persistence.acquire('old'); await lease.close();
});
it('waits for release before reacquiring and ignores a late failure from the previous lease', async () => {
  const persistence = createMemoryRuntimePersistence();
  let finishRelease!: () => void, oldFailure!: (error: Error) => void, acquisitions = 0;
  const releaseGate = new Promise<void>(resolve => { finishRelease = resolve; });
  const backend: RuntimePersistence = { ...persistence, acquire: async (scope, onLost) => {
    const lease = await persistence.acquire(scope); acquisitions++;
    if (acquisitions !== 1) return lease;
    oldFailure = onLost!;
    return { ...lease, close: async () => { await releaseGate; await lease.close(); } };
  } };
  const owner = new ConversationOwnership(() => backend); owners.push(owner);
  await owner.assertWritable('same'); owner.update(new Set(), new Set());
  const replacement = owner.assertWritable('same');
  await Promise.resolve(); expect(acquisitions).toBe(1);
  finishRelease(); await replacement;
  oldFailure(new Error('Expired old fence'));
  expect(owner.owns('same')).toBe(true); expect(acquisitions).toBe(2);
});
it('retains a new account acquisition while an old account reset finishes', async () => {
  const oldAccount = createMemoryRuntimePersistence(), newAccount = createMemoryRuntimePersistence();
  let releaseOld!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { releaseOld = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  let backend: RuntimePersistence = { ...oldAccount, acquire: async scope => { started(); await gate; return oldAccount.acquire(scope); } };
  const owner = new ConversationOwnership(() => backend); owners.push(owner);
  const previous = owner.acquire('same'); await ready;
  const reset = owner.reset(); backend = newAccount;
  await owner.assertWritable('same');
  releaseOld(); await previous; await reset;
  expect(owner.owns('same')).toBe(true);
  const released = await oldAccount.acquire('same'); await released.close();
});
