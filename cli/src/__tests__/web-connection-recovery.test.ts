import { afterEach, expect, it, vi } from 'vitest';
import { HostConnectionRecovery } from '../web/ui/connection-recovery';
import { StateRevisions } from '../web/ui/state-revisions';
import { TraceBridge } from '../web/ui/trace-bridge';

afterEach(() => vi.useRealTimers());

it('correlates host recovery, coalesces clicks, and allows another attempt after failure', async () => {
  vi.useFakeTimers();
  const sent: any[] = [];
  const recovery = new HostConnectionRecovery(message => sent.push(message));
  expect(await recovery.recover()).toBeUndefined(); expect(sent).toEqual([]);
  recovery.enabled = true;
  const first = recovery.recover(); expect(recovery.recover()).toBe(first);
  recovery.receive({ requestId: 'other', token: 'b'.repeat(64) }); expect(sent).toHaveLength(1);
  recovery.receive({ requestId: sent[0].requestId, token: 'b'.repeat(64) });
  expect(await first).toBe('b'.repeat(64));
  const failed = recovery.recover(); const rejected = expect(failed).rejects.toThrow('Dependencies missing');
  recovery.receive({ requestId: sent[1].requestId, error: 'Dependencies missing' }); await rejected;
  const timeout = recovery.recover(); const timedOut = expect(timeout).rejects.toThrow('recovery timed out');
  await vi.advanceTimersByTimeAsync(50_000); await timedOut;
  const closed = recovery.recover(); const closedResult = expect(closed).rejects.toThrow('closed');
  recovery.close(); await closedResult; expect(vi.getTimerCount()).toBe(0);
});

it('accepts the new service revision sequence and rejects late snapshots from the retired process', () => {
  const revisions = new StateRevisions();
  expect(revisions.accept({ stateRevision: 100 })).toBe(true);
  expect(revisions.accept({ serverInstanceId: 'old', stateRevision: 101 })).toBe(true);
  expect(revisions.accept({ serverInstanceId: 'old', stateRevision: 100 })).toBe(false);
  expect(revisions.accept({ serverInstanceId: 'replacement', stateRevision: 1 })).toBe(true);
  expect(revisions.accept({ serverInstanceId: 'old', stateRevision: 102 })).toBe(false);
  expect(revisions.accept({ stateRevision: 103 })).toBe(false);
  expect(revisions.accept({ serverInstanceId: 'replacement', stateRevision: 2 })).toBe(true);
  const sent: any[] = [], bridge = new TraceBridge(message => sent.push(message)); bridge.enable(1);
  const state = { type: 'state', project: { projectType: 'conversation' }, sessions: [] };
  bridge.receive({ ...state, serverInstanceId: 'old', stateRevision: 400, activeId: 'old' });
  bridge.receive({ ...state, serverInstanceId: 'new', stateRevision: 1, activeId: 'restored' });
  bridge.receive({ ...state, serverInstanceId: 'old', stateRevision: 401, activeId: 'stale' });
  expect(sent.at(-1).snapshot.activeId).toBe('restored');
});
