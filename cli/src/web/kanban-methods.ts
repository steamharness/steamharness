import { randomUUID } from 'node:crypto';
import { assertKanbanMethodJson, parseKanbanMethodDefinitions, parseKanbanMethodInvocation, type KanbanInjectedConfiguration, type KanbanMethodState, type KanbanJsonValue } from '@steamharness/kanban-project';

export class KanbanMethodHub {
  private readonly clients = new Map<string, object>();
  private readonly instances = new Map<string, KanbanMethodState & { seen: number; clientId: string }>();
  private readonly pending = new Map<string, { instanceId: string; finish(error?: Error, value?: KanbanJsonValue): void }>();
  constructor(private readonly configuration: () => KanbanInjectedConfiguration, private readonly emit: (message: Record<string, unknown>) => void) {}
  connect(clientId: string): () => void {
    if (!/^[a-zA-Z0-9-]{1,200}$/.test(clientId)) { throw new Error('Invalid Kanban client.'); }
    this.disconnect(clientId);
    const connection = {};
    this.clients.set(clientId, connection);
    return () => { if (this.clients.get(clientId) === connection) { this.disconnect(clientId); } };
  }
  private remove(instanceId: string): void {
    this.instances.delete(instanceId);
    for (const [requestId, request] of this.pending) {
      if (request.instanceId !== instanceId) { continue; }
      request.finish(new Error('Kanban preview changed or closed.'));
      this.emit({ type: 'kanban-method-cancel', requestId, instanceId });
    }
  }
  private disconnect(clientId: string): void {
    this.clients.delete(clientId);
    for (const [instanceId, instance] of this.instances) { if (instance.clientId === clientId) { this.remove(instanceId); } }
  }
  publish(value: Record<string, any>): void {
    if (!this.clients.has(value.clientId) || typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 200 || value.configurationId !== this.configuration().id
      || typeof value.ready !== 'boolean' || !['fullscreen', 'phone', 'tablet', 'card'].includes(value.presentation?.mode)) { throw new Error('Invalid Kanban method instance.'); }
    const existing = this.instances.get(value.instanceId);
    if (existing && existing.clientId !== value.clientId) { throw new Error('Kanban method instance belongs to another client.'); }
    this.instances.set(value.instanceId, { ready: value.ready, configurationId: value.configurationId, configurationName: this.configuration().name, presentation: value.presentation,
      methods: parseKanbanMethodDefinitions(value.methods), seen: Date.now(), clientId: value.clientId });
  }
  list() {
    for (const [id, instance] of this.instances) { if (Date.now() - instance.seen > 15_000) { this.remove(id); } }
    return [...this.instances].map(([instanceId, { seen: _, clientId: __, ...state }]) => ({ instanceId, ...state }));
  }
  async invoke(value: unknown, options: { readOnly?: boolean } = {}): Promise<KanbanJsonValue> {
    const call = parseKanbanMethodInvocation(value); this.list();
    const instance = this.instances.get(call.instanceId);
    if (!instance?.ready || instance.configurationId !== call.configurationId || call.configurationId !== this.configuration().id) { throw new Error('Kanban method instance changed. List instances again.'); }
    const method = instance.methods.find(method => method.name === call.method);
    if (!method) { throw new Error('Kanban page did not register this method.'); }
    if (options.readOnly && method.readOnly !== true) { throw new Error('Kanban diagnostics can only invoke methods declared readOnly.'); }
    if ([...this.pending.values()].filter(item => item.instanceId === call.instanceId).length >= 4) { throw new Error('Too many Kanban method calls.'); }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.get(requestId)?.finish(new Error('Kanban method timed out. Inspect state before retrying.')); this.emit({ type: 'kanban-method-cancel', requestId, instanceId: call.instanceId }); }, 15_000);
      this.pending.set(requestId, { instanceId: call.instanceId, finish: (error, result) => { if (!this.pending.delete(requestId)) { return; } clearTimeout(timer); error ? reject(error) : resolve(result!); } });
      this.emit({ type: 'kanban-method-invoke', requestId, ...call });
    });
  }
  reply(message: Record<string, any>): void {
    const request = this.pending.get(message.requestId);
    if (!request || request.instanceId !== message.instanceId || this.instances.get(message.instanceId)?.clientId !== message.clientId) { throw new Error('Kanban method request changed.'); }
    if (message.ok === true) { assertKanbanMethodJson(message.value); request.finish(undefined, message.value); }
    else { request.finish(new Error(typeof message.error === 'string' ? message.error.slice(0, 2_000) : 'Kanban method failed.')); }
  }
  clear(): void {
    this.instances.clear();
    for (const [requestId, request] of this.pending) { request.finish(new Error('Kanban preview changed or closed.')); this.emit({ type: 'kanban-method-cancel', requestId, instanceId: request.instanceId }); }
  }
}
