export function createKanbanRevisionBatcher(options: {
  isClosed(): boolean;
  validate(): Promise<void>;
  publish(projectId: string, revision: string): void;
  onUnavailable(): Promise<void>;
}): {
  enqueue(projectId: string, revision: string): void;
  remember(projectId: string, revision: string): void;
} {
  const current = new Map<string, string>();
  const pending = new Map<string, string>();
  let drainPromise: Promise<void> | undefined;

  const scheduleDrain = () => {
    if (drainPromise !== undefined || options.isClosed() || pending.size === 0) return;
    const drain = async () => {
      while (!options.isClosed() && pending.size > 0) {
        const batch = new Map(pending);
        pending.clear();
        await options.validate();
        if (options.isClosed()) return;
        for (const [projectId, revision] of pending) batch.set(projectId, revision);
        pending.clear();
        for (const [projectId, revision] of batch) {
          if (current.get(projectId) === revision) continue;
          options.publish(projectId, revision);
          current.set(projectId, revision);
        }
      }
    };
    const activeDrain = Promise.resolve()
      .then(drain)
      .catch(async () => {
        await options.onUnavailable().catch(() => undefined);
      })
      .finally(() => {
        if (drainPromise === activeDrain) drainPromise = undefined;
        scheduleDrain();
      });
    drainPromise = activeDrain;
  };

  return {
    enqueue(projectId, revision) {
      if (options.isClosed() || current.get(projectId) === revision) return;
      pending.set(projectId, revision);
      scheduleDrain();
    },
    remember(projectId, revision) {
      current.set(projectId, revision);
      if (pending.get(projectId) === revision) pending.delete(projectId);
    },
  };
}
