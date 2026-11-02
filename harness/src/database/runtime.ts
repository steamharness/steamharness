import { assertDatabaseAlias, type DatabaseClient, type DatabaseDescriptor, type NodeDatabaseDescriptor, type DatabaseOperation, type RelationalDatabasesContext } from "./index";
import { DatabaseResourceError, type DatabaseBindingIdentity } from "./resources";
import type { DatabaseConnectionLease, DatabaseConnectionRequest, RelationalDatabaseHost } from "./host";

const reads = new Set<DatabaseOperation>(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
const operations: DatabaseOperation[] = [...reads, "create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"];
interface Engine {
  [model: string]: unknown;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<T>(work: (transaction: Engine) => Promise<T>, options: { maxWait: number; timeout: number }): Promise<T>;
}
interface ConnectionState {
  lease: DatabaseConnectionLease;
  engine: Engine;
  active: number;
  retired: boolean;
  releasing?: Promise<void>;
  closing?: Promise<void>;
}
const closed = () => new DatabaseResourceError("DATABASE_CLOSED", "This database connection is closed.");

/** The host owns connection pools and release. The project only receives model delegates. */
export function createDatabaseConnector(options: {
  projectId: string; entryId: string; host?: RelationalDatabaseHost; signal?: AbortSignal;
}): RelationalDatabasesContext & { close(): Promise<void> } {
  let disposed = false;
  const connections = new Set<{ close(): Promise<void> }>();
  const pending = new Set<Promise<unknown>>();
  const assertOpen = () => {
    if (disposed) throw closed();
    if (options.signal?.aborted) throw options.signal.reason ?? closed();
  };
  const close = async () => {
    disposed = true;
    options.signal?.removeEventListener("abort", abort);
    await Promise.allSettled([...pending]);
    await Promise.all([...connections].map(connection => connection.close()));
  };
  const abort = () => { void close(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  return {
    async connect<Descriptor extends DatabaseDescriptor>(descriptor: Descriptor): Promise<DatabaseClient<Descriptor>> {
      assertOpen();
      validateDescriptor(descriptor);
      if (!options.host) throw new DatabaseResourceError("DATABASE_UNBOUND", "A database host and account login are required. Bind this entry's database alias first.");
      const task = openClient(descriptor as unknown as NodeDatabaseDescriptor, options.host, { projectId: options.projectId, entryId: options.entryId }, assertOpen);
      pending.add(task);
      try {
        const connection = await task;
        connections.add(connection);
        assertOpen();
        return connection.client as DatabaseClient<Descriptor>;
      } finally { pending.delete(task); }
    },
    close,
  };
}

function validateDescriptor(value: DatabaseDescriptor): void {
  if (!value || value.kind !== "steamharness.database" || value.version !== 1 || value.provider !== "postgresql" || !/^[a-f0-9]{64}$/.test(value.schemaHash)) {
    throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "Use a generated SteamHarness database descriptor.");
  }
  assertDatabaseAlias(value.alias);
  if (value.target !== "node" || typeof (value as NodeDatabaseDescriptor).loadEngine !== "function") {
    throw new DatabaseResourceError("DATABASE_TARGET_UNSUPPORTED", "The Node host requires a generated database/node descriptor. Browser querying requires a host proxy.");
  }
  if (!value.metadata || !Array.isArray(value.metadata.models) || new Set(value.metadata.models.map(model => model.delegate)).size !== value.metadata.models.length
    || value.metadata.models.some(model => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(model.delegate) || ["constructor", "prototype", "__proto__", "then", "transaction"].includes(model.delegate))) {
    throw new DatabaseResourceError("DATABASE_INVALID_REQUEST", "The generated database model metadata is invalid.");
  }
}

async function openClient(descriptor: NodeDatabaseDescriptor, host: RelationalDatabaseHost,
  consumer: { projectId: string; entryId: string }, assertOpen: () => void) {
  const request: DatabaseConnectionRequest = { ...consumer, alias: descriptor.alias, schemaHash: descriptor.schemaHash };
  let binding: DatabaseBindingIdentity | undefined;
  let accessRevision: number | undefined;
  let current: Promise<ConnectionState> | undefined;
  let disposed = false;
  const states = new Set<ConnectionState>();
  const tasks = new Set<Promise<unknown>>();
  const check = () => { assertOpen(); if (disposed) throw closed(); };
  const release = (state: ConnectionState) => state.releasing ??= host.release(state.lease.credential.id).catch(() => undefined);
  const finish = async (state: ConnectionState) => {
    if (!state.retired || state.active) return;
    state.closing ??= (async () => {
      try { await state.engine.$disconnect().catch(() => undefined); }
      finally { await release(state); states.delete(state); }
    })();
    await state.closing;
  };
  const acquire = async (): Promise<ConnectionState> => {
    check();
    const lease = await host.open({ ...request, binding });
    let engine: Engine | undefined;
    try {
      check();
      if (!lease?.binding || !lease.credential || lease.binding.projectId !== consumer.projectId || lease.binding.entryId !== consumer.entryId || lease.binding.alias !== descriptor.alias
        || lease.binding.databaseId !== lease.credential.databaseId || lease.credential.schemaHash !== descriptor.schemaHash
        || !["read", "write"].includes(lease.credential.mode) || !Number.isFinite(Date.parse(lease.credential.expiresAt)) || Date.parse(lease.credential.expiresAt) <= Date.now()
        || binding && (lease.binding.id !== binding.id || lease.binding.revision !== binding.revision)) {
        throw new DatabaseResourceError("DATABASE_BINDING_CHANGED", "The database host returned a different or expired binding.");
      }
      if (accessRevision !== undefined && lease.credential.revision !== accessRevision) throw new DatabaseResourceError("DATABASE_CONNECTION_EXPIRED", "Database authorization changed. Open a new client explicitly.");
      const module = await descriptor.loadEngine() as { PrismaClient: new (options: unknown) => Engine };
      const { PrismaPg } = await import("@prisma/adapter-pg");
      engine = new module.PrismaClient({ adapter: new PrismaPg({ connectionString: lease.credential.connectionString, max: 2, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, statement_timeout: 30_000 }) });
      await engine.$connect();
      check();
      binding ??= { id: lease.binding.id, revision: lease.binding.revision };
      accessRevision ??= lease.credential.revision;
      const state: ConnectionState = { lease, engine, active: 0, retired: false };
      states.add(state); return state;
    } catch (error) {
      await engine?.$disconnect().catch(() => undefined);
      if (lease?.credential?.id) await host.release(lease.credential.id).catch(() => undefined);
      if (error instanceof DatabaseResourceError) throw error;
      throw new DatabaseResourceError("DATABASE_UNAVAILABLE", `Database "${descriptor.alias}" could not connect.`);
    }
  };
  const getState = async (): Promise<ConnectionState> => {
    check();
    current ??= acquire().catch(error => { current = undefined; throw error; });
    const previous = current;
    const state = await previous;
    check();
    if (Date.parse(state.lease.credential.expiresAt) <= Date.now() + 1000) {
      if (current === previous) {
        state.retired = true;
        current = acquire().catch(error => { current = undefined; throw error; });
        void finish(state).catch(() => undefined);
      }
      return current!;
    }
    return state;
  };
  const authorize = async (state: ConnectionState) => {
    check();
    await host.authorize({ ...request, binding, credentialId: state.lease.credential.id });
    check();
  };
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    const task = work(); tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => undefined);
    return task;
  };
  const use = async <T>(work: (state: ConnectionState) => Promise<T>): Promise<T> => {
    const state = await getState(); state.active++;
    try { await authorize(state); return await work(state); }
    finally { state.active--; await finish(state); }
  };
  const query = async (engine: Engine, state: ConnectionState, model: string, operation: DatabaseOperation, args: unknown) => {
    if (state.lease.credential.mode === "read" && !reads.has(operation)) throw new DatabaseResourceError("DATABASE_ACCESS_DENIED", "This database connection is read-only.");
    try {
      const delegate = engine[model] as Record<string, (args: unknown) => Promise<unknown>>;
      return await delegate[operation](args);
    } catch (error) {
      // Never propagate engine invocations, SQL, connection URLs, or credentials into reports.
      const queryCode = typeof (error as { code?: unknown })?.code === "string" && /^P\d{4}$/.test((error as { code: string }).code) ? (error as { code: string }).code : undefined;
      throw Object.assign(new DatabaseResourceError("DATABASE_QUERY_FAILED", `Database ${model}.${operation} failed${queryCode ? ` (${queryCode})` : ""}.`), queryCode ? { queryCode } : {});
    }
  };
  const delegates = (invoke: (model: string, operation: DatabaseOperation, args: unknown) => Promise<unknown>) => Object.fromEntries(descriptor.metadata.models.map(model => [model.delegate,
    Object.freeze(Object.assign(Object.create(null), Object.fromEntries(operations.map(operation => [operation, (args?: unknown) => invoke(model.delegate, operation, args)]))))]));
  const client = Object.freeze(Object.assign(Object.create(null), delegates((model, operation, args) => track(() => use(state => query(state.engine, state, model, operation, args)))), {
    transaction<T>(work: (transaction: unknown) => Promise<T>): Promise<T> {
      if (typeof work !== "function") return Promise.reject(new DatabaseResourceError("DATABASE_INVALID_REQUEST", "Database transaction requires a callback."));
      return track(() => use(async state => {
        let active = true;
        let failure: unknown;
        let callbackError: unknown;
        const queries = new Set<Promise<unknown>>();
        try {
          return await state.engine.$transaction(async engine => {
            const transaction = Object.freeze(Object.assign(Object.create(null), delegates((model, operation, args) => {
              const task = (async () => {
                if (!active) throw closed();
                try { await authorize(state); if (!active) throw closed(); return await query(engine, state, model, operation, args); }
                catch (error) { failure ??= error; throw error; }
              })();
              queries.add(task); void task.finally(() => queries.delete(task)).catch(() => undefined); return task;
            })));
            try {
              let result: T;
              try { result = await work(transaction); }
              finally { active = false; await Promise.allSettled([...queries]); }
              if (failure) throw failure;
              await authorize(state);
              return result;
            } catch (error) { callbackError = error; throw error; }
          }, { maxWait: 5000, timeout: 30_000 });
        } catch (error) {
          if (error === callbackError || error instanceof DatabaseResourceError) throw error;
          throw new DatabaseResourceError("DATABASE_QUERY_FAILED", "Database transaction failed. The transaction was not replayed.");
        } finally { active = false; }
      }));
    },
  }));
  const close = async () => {
    disposed = true;
    // Revoke first so cancellation also interrupts SQL that is already running.
    await Promise.all([...states].map(release));
    await Promise.allSettled([...(current ? [current] : []), ...tasks]);
    for (const state of states) state.retired = true;
    await Promise.all([...states].map(finish));
  };
  try { await getState(); return { client, close }; }
  catch (error) { await close(); throw error; }
}
