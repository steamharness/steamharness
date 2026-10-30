import { describe, expect, it, vi } from 'vitest';
import { KanbanMethodHub } from '../web/kanban-methods';

function fixture() {
  const configuration = { id: 'configuration', name: 'Config', params: {} }, emit = vi.fn();
  const hub = new KanbanMethodHub(() => configuration, emit);
  const disconnect = hub.connect('client');
  hub.publish({ clientId: 'client', instanceId: 'instance', ready: true, configurationId: configuration.id, presentation: { mode: 'fullscreen' }, methods: [{ name: 'tasks.list', description: 'List tasks', inputSchema: { type: 'object' }, readOnly: true }] });
  const call = { instanceId: 'instance', configurationId: configuration.id, method: 'tasks.list', args: {} };
  return { hub, configuration, emit, call, disconnect };
}
describe('Kanban page method routing', () => {
  it('limits diagnostics to explicitly readOnly methods before sending to the page', async () => {
    const { hub, emit, call } = fixture();
    hub.publish({ clientId: 'client', instanceId: 'instance', ready: true, configurationId: 'configuration', presentation: { mode: 'fullscreen' }, methods: [
      { name: 'tasks.list', description: 'Read', inputSchema: { type: 'object' }, readOnly: true },
      { name: 'tasks.delete', description: 'Write', inputSchema: { type: 'object' }, readOnly: false },
      { name: 'tasks.unknown', description: 'Unspecified', inputSchema: { type: 'object' } },
    ] });
    for (const method of ['tasks.delete', 'tasks.unknown']) await expect(hub.invoke({ ...call, method }, { readOnly: true })).rejects.toThrow('readOnly');
    expect(emit).not.toHaveBeenCalled();
    const running = hub.invoke(call, { readOnly: true });
    hub.reply({ ...emit.mock.calls[0][0], clientId: 'client', ok: true, value: { imageReady: false } });
    expect(await running).toEqual({ imageReady: false });
  });
  it('discovers the exact preview and routes replies only from its instance', async () => {
    const { hub, emit, call } = fixture(); expect(hub.list()[0]).toMatchObject({ configurationName: 'Config', instanceId: 'instance', ready: true });
    const running = hub.invoke(call); const request = emit.mock.calls[0][0];
    expect(() => hub.reply({ requestId: request.requestId, instanceId: 'other', ok: true, value: [] })).toThrow('changed');
    expect(() => hub.reply({ requestId: request.requestId, instanceId: 'instance', clientId: 'other', ok: true, value: [] })).toThrow('changed');
    hub.reply({ requestId: request.requestId, instanceId: 'instance', clientId: 'client', ok: true, value: [1, 2] }); expect(await running).toEqual([1, 2]);
  });
  it('removes disconnected pages immediately and cancels their pending calls', async () => {
    const { hub, call, disconnect } = fixture();
    const running = hub.invoke(call), checked = expect(running).rejects.toThrow('closed');
    disconnect(); await checked; expect(hub.list()).toEqual([]);
    await expect(hub.invoke(call)).rejects.toThrow('changed');
    expect(() => hub.publish({ clientId: 'client' })).toThrow('Invalid');
  });
  it('keeps a reconnected client when its older stream closes', () => {
    const { hub, disconnect } = fixture();
    const closeNew = hub.connect('client'); disconnect();
    hub.publish({ clientId: 'client', instanceId: 'new', ready: true, configurationId: 'configuration', presentation: { mode: 'fullscreen' }, methods: [] });
    expect(hub.list()).toHaveLength(1); closeNew(); expect(hub.list()).toEqual([]);
  });
  it('rejects stale configuration and undeclared methods, cancelling on refresh', async () => {
    const { hub, configuration, call, emit } = fixture();
    await expect(hub.invoke({ ...call, configurationId: 'old' })).rejects.toThrow('changed');
    await expect(hub.invoke({ ...call, method: 'invented' })).rejects.toThrow('register');
    const running = hub.invoke(call); const rejected = expect(running).rejects.toThrow('changed');
    configuration.id = 'new'; hub.clear(); await rejected; expect(hub.list()).toEqual([]); expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'kanban-method-cancel' }));
  });
  it('bounds concurrency and timeouts without retrying mutations', async () => {
    vi.useFakeTimers();
    try {
      const { hub, call, emit } = fixture();
      const running = Array.from({ length: 4 }, () => hub.invoke(call));
      const checked = Promise.all(running.map(result => expect(result).rejects.toThrow('timed out')));
      await expect(hub.invoke(call)).rejects.toThrow('Too many');
      await vi.advanceTimersByTimeAsync(15_000); await checked;
      expect(emit.mock.calls.filter(([message]) => message.type === 'kanban-method-invoke')).toHaveLength(4);
      expect(hub.list()).toHaveLength(1); await vi.advanceTimersByTimeAsync(1); expect(hub.list()).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
