/** Domain rows with optimistic concurrency; no local persistence or automatic fallback. */
export function createTaskRepository(connect) {
  const snapshots = new Map();
  let connection;
  const database = () => connection ??= Promise.resolve().then(connect).catch(error => { connection = undefined; throw error; });
  return {
    async load(configurationId) {
      const db = await database();
      const rows = [];
      for (let page = 1; ; page++) {
        const result = await db.task.rows({ where: { configurationId }, orderBy: { position: 'asc', id: 'asc' }, page, pageSize: 100 });
        rows.push(...result.items);
        if (rows.length >= result.total || result.items.length === 0) break;
      }
      snapshots.set(configurationId, new Map(rows.map(row => [row.values.id, row])));
      return { version: 1, tasks: rows.map(({ values }) => ({ id: values.id, title: values.title, description: values.description, status: values.status })) };
    },
    async save(configurationId, value) {
      const db = await database(), known = snapshots.get(configurationId);
      if (!known) throw new Error('Load the board before editing tasks.');
      const ids = new Set(value.tasks.map(task => task.id));
      for (const [position, task] of value.tasks.entries()) {
        const previous = known.get(task.id), data = { ...task, configurationId, position };
        if (previous && Object.entries(data).every(([key, value]) => previous.values[key] === value)) continue;
        const row = previous
          ? await db.task.update({ key: { id: task.id }, rowVersion: previous.rowVersion, data })
          : await db.task.insert(data);
        known.set(task.id, row);
      }
      for (const [id, row] of known) if (!ids.has(id)) {
        await db.task.delete({ key: { id }, rowVersion: row.rowVersion }); known.delete(id);
      }
    },
  };
}
