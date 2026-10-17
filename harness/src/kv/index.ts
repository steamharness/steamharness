import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkflowError } from "../workflow/errors";

export type WorkflowStorageKind = "kv" | "persistent_value";
export type WorkflowKVScope = "project" | "conversation";

export type WorkflowKVValueType =
  | "null"
  | "array"
  | "object"
  | "string"
  | "number"
  | "boolean";

export interface WorkflowKVStoreGetInput {
  storageKind: WorkflowStorageKind;
  scope: WorkflowKVScope;
  projectId: string;
  key: string;
  conversationId?: string;
}

export interface WorkflowKVStoreSetInput extends WorkflowKVStoreGetInput {
  value: unknown;
  source?: WorkflowKVWriteSource;
}

export type WorkflowKVNamespaceLockInput = Omit<WorkflowKVStoreGetInput, "key">;

/**
 * A store-specific mutation that must operate on one KV namespace atomically.
 *
 * Remote stores can expose a small, server-implemented set of mutations when
 * a callback-based `withNamespaceLock` cannot safely span HTTP requests.
 */
export interface WorkflowKVNamespaceMutation {
  type: string;
  input: unknown;
}

export interface WorkflowKVWriteSource {
  projectId?: string;
  runId?: string;
  conversationId?: string;
}

export type NormalizedWorkflowKVStoreInput =
  | {
      storageKind: WorkflowStorageKind;
      scope: "project";
      projectId: string;
      key: string;
    }
  | {
      storageKind: WorkflowStorageKind;
      scope: "conversation";
      projectId: string;
      conversationId: string;
      key: string;
    };

export interface WorkflowKVStore {
  getValue(input: WorkflowKVStoreGetInput): Promise<unknown | undefined>;
  setValue(input: WorkflowKVStoreSetInput): Promise<void>;
  /**
   * Removes one entry and reports whether it existed, so a caller can tell a
   * real delete from a no-op. Deleting an absent key succeeds.
   *
   * This is deliberately separate from `setValue`: a KV value is never
   * `undefined`, so `undefined` cannot double as a tombstone without making
   * every stored `null` indistinguishable from a missing entry.
   */
  deleteValue(input: WorkflowKVStoreGetInput): Promise<boolean>;
  updateValue?(
    input: WorkflowKVStoreGetInput & { source?: WorkflowKVWriteSource },
    updater: (current: unknown | undefined) => unknown,
  ): Promise<unknown>;
  withNamespaceLock?<T>(
    input: WorkflowKVNamespaceLockInput,
    operation: () => Promise<T> | T,
  ): Promise<T>;
  /**
   * Optional local read transaction used by large namespace scans. Unlike the
   * general lock callback, remote and PostgreSQL stores intentionally do not
   * expose this process-local optimization.
   */
  withNamespaceReadLock?<T>(
    input: WorkflowKVNamespaceLockInput,
    operation: () => Promise<T> | T,
  ): Promise<T>;
  executeNamespaceMutation?<T>(
    input: WorkflowKVNamespaceLockInput,
    mutation: WorkflowKVNamespaceMutation,
  ): Promise<T>;
}

export interface WorkflowKVNamespace {
  getValue(key: string): Promise<unknown | undefined>;
  setValue(key: string, value: unknown): Promise<void>;
  deleteValue(key: string): Promise<boolean>;
  updateValue(
    key: string,
    updater: (current: unknown | undefined) => unknown,
  ): Promise<unknown>;
  withLock?<T>(operation: () => Promise<T> | T): Promise<T>;
  withReadLock?<T>(operation: () => Promise<T> | T): Promise<T>;
  executeMutation?<T>(mutation: WorkflowKVNamespaceMutation): Promise<T>;
}

export interface WorkflowKVContext extends WorkflowKVNamespace {
  conversation: WorkflowKVNamespace;
}

export type WorkflowPersistentValueContext = WorkflowKVContext;

export interface WorkflowKVContextOptions {
  store: WorkflowKVStore;
  projectId: string;
  conversationId?: string;
  source?: WorkflowKVWriteSource;
}

export interface WorkflowPersistentValueContextOptions extends Omit<WorkflowKVContextOptions, "store"> {
  store?: WorkflowKVStore;
}

export interface LocalWorkflowPersistentValueContextOptions extends Omit<WorkflowKVContextOptions, "store"> {
  rootDir: string;
}

export interface LocalWorkflowKVEntrySummary {
  storageKind: WorkflowStorageKind;
  scope: WorkflowKVScope;
  projectId: string;
  key: string;
  conversationId?: string;
  valueType: WorkflowKVValueType;
  valueSizeBytes: number;
  valuePreview: string;
  updatedAt: string;
  source?: WorkflowKVWriteSource;
}

export interface LocalWorkflowKVEntryDetail extends LocalWorkflowKVEntrySummary {
  value: unknown;
}

export interface LocalWorkflowKVEntryPage {
  items: LocalWorkflowKVEntrySummary[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface ListLocalWorkflowKVEntriesOptions {
  rootDir: string;
  storageKind: WorkflowStorageKind;
  pageSize?: number;
  cursor?: string;
  scope?: WorkflowKVScope;
  projectId?: string;
  conversationId?: string;
  valueType?: WorkflowKVValueType;
  query?: string;
}

export interface GetLocalWorkflowKVEntryOptions extends WorkflowKVStoreGetInput {
  rootDir: string;
}

export function createWorkflowKVContext(
  options: WorkflowKVContextOptions,
): WorkflowKVContext {
  return createWorkflowStorageValueContext(options, "kv");
}

function createWorkflowStorageValueContext(
  options: WorkflowKVContextOptions,
  storageKind: WorkflowStorageKind,
): WorkflowKVContext {
  const projectNamespace = createWorkflowKVNamespace(options.store, {
    storageKind,
    scope: "project",
    projectId: options.projectId,
  }, options.source);
  const conversationNamespace = createWorkflowKVNamespace(options.store, {
    storageKind,
    scope: "conversation",
    projectId: options.projectId,
    conversationId: options.conversationId,
  }, options.source);

  return {
    getValue: projectNamespace.getValue,
    setValue: projectNamespace.setValue,
    deleteValue: projectNamespace.deleteValue,
    updateValue: projectNamespace.updateValue,
    withLock: projectNamespace.withLock,
    withReadLock: projectNamespace.withReadLock,
    executeMutation: projectNamespace.executeMutation,
    conversation: conversationNamespace,
  };
}

export function createWorkflowPersistentValueContext(
  options: WorkflowPersistentValueContextOptions,
): WorkflowPersistentValueContext {
  if (options.store === undefined) {
    return createUnavailableWorkflowPersistentValueContext();
  }

  return createWorkflowStorageValueContext({
    store: options.store,
    projectId: options.projectId,
    conversationId: options.conversationId,
    source: options.source,
  }, "persistent_value");
}

export function createLocalWorkflowPersistentValueContext(
  options: LocalWorkflowPersistentValueContextOptions,
): WorkflowPersistentValueContext {
  return createWorkflowPersistentValueContext({
    store: createLocalWorkflowKVStore({
      rootDir: options.rootDir,
      storageKind: "persistent_value",
    }),
    projectId: options.projectId,
    conversationId: options.conversationId,
    source: options.source,
  });
}

export function createLocalWorkflowKVStore(options: {
  rootDir: string;
  storageKind?: WorkflowStorageKind;
}): WorkflowKVStore {
  const rootDir = normalizeLocalKVRootDir(options.rootDir);
  const storageKind = options.storageKind ?? "kv";
  const namespaceTransactions = new AsyncLocalStorage<LocalKVNamespaceTransaction>();
  let initialization: Promise<void> | undefined;
  const initialize = (): Promise<void> => {
    initialization ??= ensureLocalWorkflowStorageFormat(rootDir, storageKind);
    return initialization;
  };

  const getValue = async (input: WorkflowKVStoreGetInput): Promise<unknown | undefined> => {
    await initialize();
    const normalized = normalizeWorkflowKVStoreInput(input);
    assertWorkflowStorageKindMatches(storageKind, normalized.storageKind);
    const transaction = namespaceTransactions.getStore();
    if (transaction !== undefined) {
      assertLocalKVTransactionNamespace(transaction, normalized);
      return getLocalKVTransactionValue(rootDir, transaction, normalized);
    }

    return withRecoveredLocalKVNamespaceLock(
      rootDir,
      toLocalKVNamespace(normalized),
      () => readLocalKVValue(rootDir, normalized),
    );
  };

  const setValue = async (input: WorkflowKVStoreSetInput): Promise<void> => {
    await initialize();
    const normalized = normalizeWorkflowKVStoreInput(input);
    assertWorkflowStorageKindMatches(storageKind, normalized.storageKind);
    const transaction = namespaceTransactions.getStore();
    if (transaction !== undefined) {
      assertLocalKVTransactionNamespace(transaction, normalized);
      stageLocalKVTransactionValue(transaction, normalized, input.value, input.source);
      return;
    }

    await withRecoveredLocalKVNamespaceLock(
      rootDir,
      toLocalKVNamespace(normalized),
      () => writeLocalKVValue(rootDir, normalized, input.value, input.source),
    );
  };

  const deleteValue = async (input: WorkflowKVStoreGetInput): Promise<boolean> => {
    await initialize();
    const normalized = normalizeWorkflowKVStoreInput(input);
    assertWorkflowStorageKindMatches(storageKind, normalized.storageKind);
    const transaction = namespaceTransactions.getStore();
    if (transaction !== undefined) {
      assertLocalKVTransactionNamespace(transaction, normalized);
      return stageLocalKVTransactionDelete(rootDir, transaction, normalized);
    }

    return withRecoveredLocalKVNamespaceLock(
      rootDir,
      toLocalKVNamespace(normalized),
      () => deleteLocalKVValue(rootDir, normalized),
    );
  };

  const withNamespaceLock = async <T>(
    input: WorkflowKVNamespaceLockInput,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    await initialize();
    const normalized = normalizeWorkflowKVNamespaceLockInput(input);
    assertWorkflowStorageKindMatches(storageKind, normalized.storageKind);
    const activeTransaction = namespaceTransactions.getStore();
    if (activeTransaction !== undefined) {
      if (isSameLocalKVNamespace(activeTransaction.namespace, normalized)) {
        return operation();
      }
      throw createLocalKVNestedNamespaceError(activeTransaction.namespace, normalized);
    }

    return withRecoveredLocalKVNamespaceLock(
      rootDir,
      normalized,
      async () => {
        const transaction: LocalKVNamespaceTransaction = {
          namespace: normalized,
          writes: new Map(),
        };
        const result = await namespaceTransactions.run(transaction, operation);
        await commitLocalKVNamespaceTransaction(rootDir, transaction);
        return result;
      },
    );
  };

  return {
    getValue,
    setValue,
    deleteValue,
    async updateValue(input, updater) {
      await initialize();
      const normalized = normalizeWorkflowKVStoreInput(input);
      assertWorkflowStorageKindMatches(storageKind, normalized.storageKind);
      const transaction = namespaceTransactions.getStore();
      if (transaction !== undefined) {
        assertLocalKVTransactionNamespace(transaction, normalized);
        const current = await getLocalKVTransactionValue(rootDir, transaction, normalized);
        const value = updater(current);
        stageLocalKVTransactionValue(transaction, normalized, value, input.source);
        return value;
      }

      return withRecoveredLocalKVNamespaceLock(
        rootDir,
        toLocalKVNamespace(normalized),
        () => updateLocalKVValue(rootDir, normalized, input.source, updater),
      );
    },
    withNamespaceLock,
    withNamespaceReadLock: withNamespaceLock,
  };
}

async function readLocalKVValue(
  rootDir: string,
  input: NormalizedWorkflowKVStoreInput,
): Promise<unknown | undefined> {
  const entry = await readLocalKVEntry(resolveLocalKVEntryPath(rootDir, input), input);
  return entry?.value;
}

async function writeLocalKVValue(
  rootDir: string,
  input: NormalizedWorkflowKVStoreInput,
  value: unknown,
  source: WorkflowKVWriteSource | undefined,
): Promise<void> {
  const entryPath = resolveLocalKVEntryPath(rootDir, input);
  await withLocalKVPathLock(resolveLocalKVEntryLockPath(entryPath), () =>
    withLocalKVInspectionIndexLock(rootDir, () =>
      writeLocalKVEntry(rootDir, entryPath, input, value, source),
    ),
  );
}

async function deleteLocalKVValue(
  rootDir: string,
  input: NormalizedWorkflowKVStoreInput,
): Promise<boolean> {
  const entryPath = resolveLocalKVEntryPath(rootDir, input);
  return withLocalKVPathLock(resolveLocalKVEntryLockPath(entryPath), () =>
    withLocalKVInspectionIndexLock(rootDir, () => removeLocalKVEntries(rootDir, [input])),
  );
}

async function updateLocalKVValue(
  rootDir: string,
  input: NormalizedWorkflowKVStoreInput,
  source: WorkflowKVWriteSource | undefined,
  updater: (current: unknown | undefined) => unknown,
): Promise<unknown> {
  const entryPath = resolveLocalKVEntryPath(rootDir, input);
  return withLocalKVPathLock(resolveLocalKVEntryLockPath(entryPath), async () => {
    const current = (await readLocalKVEntry(entryPath, input))?.value;
    const value = updater(current);
    await withLocalKVInspectionIndexLock(rootDir, () =>
      writeLocalKVEntry(rootDir, entryPath, input, value, source),
    );
    return value;
  });
}

function toLocalKVNamespace(
  input: NormalizedWorkflowKVStoreInput,
): NormalizedWorkflowKVNamespaceLockInput {
  return input.scope === "project"
    ? {
        storageKind: input.storageKind,
        scope: "project",
        projectId: input.projectId,
      }
    : {
        storageKind: input.storageKind,
        scope: "conversation",
        projectId: input.projectId,
        conversationId: input.conversationId,
      };
}

function isLocalKVTransactionNamespace(
  transaction: LocalKVNamespaceTransaction,
  input: NormalizedWorkflowKVStoreInput,
): boolean {
  return isSameLocalKVNamespace(transaction.namespace, toLocalKVNamespace(input));
}

function assertLocalKVTransactionNamespace(
  transaction: LocalKVNamespaceTransaction,
  input: NormalizedWorkflowKVStoreInput,
): void {
  if (!isLocalKVTransactionNamespace(transaction, input)) {
    throw createLocalKVNestedNamespaceError(transaction.namespace, toLocalKVNamespace(input));
  }
}

function createLocalKVNestedNamespaceError(
  current: NormalizedWorkflowKVNamespaceLockInput,
  requested: NormalizedWorkflowKVNamespaceLockInput,
): WorkflowError {
  return new WorkflowError({
    type: "workflow_execution",
    message: "Local workflow KV namespace transactions cannot access a different namespace while holding a lock.",
    metadata: { currentNamespace: current, requestedNamespace: requested },
  });
}

function isSameLocalKVNamespace(
  left: NormalizedWorkflowKVNamespaceLockInput,
  right: NormalizedWorkflowKVNamespaceLockInput,
): boolean {
  return left.scope === right.scope &&
    left.storageKind === right.storageKind &&
    left.projectId === right.projectId &&
    readLocalKVNamespaceConversationId(left) === readLocalKVNamespaceConversationId(right);
}

function getLocalKVTransactionWriteKey(input: NormalizedWorkflowKVStoreInput): string {
  return getLocalKVEntryIdentity(input);
}

/**
 * Identity of one entry, shared by the transaction staging map and the
 * inspection index so a staged delete removes the same row a write upserts.
 */
function getLocalKVEntryIdentity(input: {
  storageKind: WorkflowStorageKind;
  scope: WorkflowKVScope;
  projectId: string;
  conversationId?: string;
  key: string;
}): string {
  return JSON.stringify([
    input.storageKind,
    input.scope,
    input.projectId,
    input.conversationId ?? null,
    input.key,
  ]);
}

function isLocalKVTransactionWriteDelete(
  write: LocalKVTransactionWrite,
): write is LocalKVTransactionWriteDelete {
  return "deleted" in write;
}

async function getLocalKVTransactionValue(
  rootDir: string,
  transaction: LocalKVNamespaceTransaction,
  input: NormalizedWorkflowKVStoreInput,
): Promise<unknown | undefined> {
  const staged = transaction.writes.get(getLocalKVTransactionWriteKey(input));
  if (staged === undefined) return readLocalKVValue(rootDir, input);
  // A staged delete reads as absent for the rest of the transaction, so a
  // later read or update in the same lock sees the namespace as it will commit.
  return isLocalKVTransactionWriteDelete(staged) ? undefined : staged.value;
}

function stageLocalKVTransactionValue(
  transaction: LocalKVNamespaceTransaction,
  input: NormalizedWorkflowKVStoreInput,
  value: unknown,
  source: WorkflowKVWriteSource | undefined,
): void {
  const serialized = serializeLocalKVValue(value);
  transaction.writes.set(getLocalKVTransactionWriteKey(input), {
    input,
    value: serialized.value,
    source: normalizeWorkflowKVWriteSource(source),
  });
}

async function stageLocalKVTransactionDelete(
  rootDir: string,
  transaction: LocalKVNamespaceTransaction,
  input: NormalizedWorkflowKVStoreInput,
): Promise<boolean> {
  // Staging replaces any earlier write for the same key, so a set-then-delete
  // inside one lock commits as a delete and reports the key as removed.
  const existed = (await getLocalKVTransactionValue(rootDir, transaction, input)) !== undefined;
  transaction.writes.set(getLocalKVTransactionWriteKey(input), { input, deleted: true });
  return existed;
}

async function commitLocalKVNamespaceTransaction(
  rootDir: string,
  transaction: LocalKVNamespaceTransaction,
): Promise<void> {
  const writes = [...transaction.writes.values()];
  if (writes.length === 0) return;

  const journalPath = resolveLocalKVTransactionJournalPath(rootDir, randomUUID());
  const journal: LocalKVTransactionJournal = {
    version: LOCAL_KV_TRANSACTION_JOURNAL_VERSION,
    namespace: transaction.namespace,
    writes,
  };
  await mkdir(path.dirname(journalPath), { recursive: true });
  await writeLocalKVFileAtomically(journalPath, `${JSON.stringify(journal)}\n`);

  try {
    await applyLocalKVTransactionWrites(rootDir, writes);
    await rm(journalPath, { force: true });
  } catch (error) {
    // The journal is intentionally retained so the next local read or write can
    // replay the complete namespace mutation after an interrupted commit.
    throw error;
  }
}

async function recoverLocalKVTransactions(rootDir: string): Promise<void> {
  const transactionDirectory = resolveLocalKVTransactionDirectory(rootDir);
  const initialEntries = await readLocalKVDirectory(transactionDirectory);
  if (!initialEntries.some((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
    return;
  }

  await withLocalKVPathLock(resolveLocalKVTransactionRecoveryLockPath(rootDir), async () => {
    const entries = await readLocalKVDirectory(transactionDirectory);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const journalPath = resolveLocalKVPath(rootDir, [".transactions", entry.name]);
      const journal = await readLocalKVTransactionJournal(journalPath);
      if (journal === undefined) {
        throw new WorkflowError({
          type: "workflow_execution",
          message: "Local workflow KV transaction journal is invalid and cannot be recovered.",
        });
      }

      await withLocalKVPathLock(
        resolveLocalKVNamespaceLockPath(rootDir, journal.namespace),
        async () => {
          const current = await readLocalKVTransactionJournal(journalPath);
          if (current === undefined) return;
          await applyLocalKVTransactionWrites(rootDir, current.writes);
          await rm(journalPath, { force: true });
        },
      );
    }
  });
}

/**
 * Replays journals for a namespace while its namespace lock is already held.
 *
 * Normal operations enter through this lock, so recovery happens before every
 * namespace read or mutation without globally scanning/replaying unrelated
 * namespaces.
 */
async function recoverLocalKVTransactionsForLockedNamespace(
  rootDir: string,
  namespace: NormalizedWorkflowKVNamespaceLockInput,
): Promise<void> {
  const transactionDirectory = resolveLocalKVTransactionDirectory(rootDir);
  const entries = await readLocalKVDirectory(transactionDirectory);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const journalPath = resolveLocalKVPath(rootDir, [".transactions", entry.name]);
    const file = await readLocalKVJsonFile(journalPath, { strict: true });
    if (file === undefined) continue;
    const journal = parseLocalKVTransactionJournal(file.value);
    if (journal === undefined) {
      throw new WorkflowError({
        type: "workflow_execution",
        message: "Local workflow KV transaction journal is invalid and cannot be recovered.",
      });
    }
    if (!isSameLocalKVNamespace(journal.namespace, namespace)) continue;
    await applyLocalKVTransactionWrites(rootDir, journal.writes);
    await rm(journalPath, { force: true });
  }
}

async function readLocalKVTransactionJournal(
  journalPath: string,
): Promise<LocalKVTransactionJournal | undefined> {
  const file = await readLocalKVJsonFile(journalPath);
  return file === undefined ? undefined : parseLocalKVTransactionJournal(file.value);
}

function parseLocalKVTransactionJournal(value: unknown): LocalKVTransactionJournal | undefined {
  if (!isRecord(value) || value["version"] !== LOCAL_KV_TRANSACTION_JOURNAL_VERSION ||
    !isRecord(value["namespace"]) || !Array.isArray(value["writes"])) {
    return undefined;
  }

  let namespace: NormalizedWorkflowKVNamespaceLockInput;
  try {
    namespace = normalizeWorkflowKVNamespaceLockInput(value["namespace"] as WorkflowKVNamespaceLockInput);
  } catch {
    return undefined;
  }

  const writes: LocalKVTransactionWrite[] = [];
  const identities = new Set<string>();
  for (const candidate of value["writes"]) {
    if (!isRecord(candidate) || !isRecord(candidate["input"])) {
      return undefined;
    }

    // A record is either a value write or a delete. Anything else — a stray
    // `deleted` value, or both fields at once — is corrupt, and recovery must
    // fail loudly rather than guess which half to apply.
    const deleted = candidate["deleted"];
    if (deleted !== undefined && deleted !== true) {
      return undefined;
    }
    if (deleted === undefined && !("value" in candidate)) {
      return undefined;
    }
    if (deleted === true && "value" in candidate) {
      return undefined;
    }

    let input: NormalizedWorkflowKVStoreInput;
    try {
      input = normalizeWorkflowKVStoreInput(candidate["input"] as unknown as WorkflowKVStoreGetInput);
    } catch {
      return undefined;
    }
    if (!isSameLocalKVNamespace(namespace, toLocalKVNamespace(input))) {
      return undefined;
    }

    const identity = getLocalKVTransactionWriteKey(input);
    if (identities.has(identity)) return undefined;
    identities.add(identity);

    if (deleted) {
      writes.push({ input, deleted: true });
      continue;
    }

    const source = candidate["source"];
    if (source !== undefined && !isWorkflowKVWriteSource(source)) {
      return undefined;
    }
    let serializedValue: { value: unknown };
    try {
      serializedValue = serializeLocalKVValue(candidate["value"]);
    } catch {
      return undefined;
    }
    writes.push({
      input,
      value: serializedValue.value,
      source: source === undefined ? undefined : normalizeWorkflowKVWriteSource(source),
    });
  }

  return { version: LOCAL_KV_TRANSACTION_JOURNAL_VERSION, namespace, writes };
}

export async function listLocalWorkflowKVEntries(
  options: ListLocalWorkflowKVEntriesOptions,
): Promise<LocalWorkflowKVEntryPage> {
  const normalizedOptions = normalizeLocalKVInspectionOptions(options);
  await ensureLocalWorkflowStorageFormat(
    normalizedOptions.rootDir,
    normalizedOptions.storageKind,
  );
  await recoverLocalKVTransactions(normalizedOptions.rootDir);
  const summaries = (await readLocalKVInspectionIndex(
    normalizedOptions.rootDir,
    normalizedOptions.storageKind,
  ))
    .filter((summary) => matchesLocalKVInspectionOptions(summary, normalizedOptions));

  const cursor = parseLocalKVPageCursor(normalizedOptions.cursor);
  const entriesAfterCursor = cursor === undefined
    ? summaries
    : summaries.filter((entry) => compareLocalKVEntryToCursor(entry, cursor) > 0);
  const items = entriesAfterCursor.slice(0, normalizedOptions.pageSize);
  const hasMore = entriesAfterCursor.length > items.length;

  return {
    items,
    ...(hasMore ? { nextCursor: createLocalKVPageCursor(items.at(-1)) } : {}),
    hasMore,
    total: summaries.length,
  };
}

export async function getLocalWorkflowKVEntry(
  options: GetLocalWorkflowKVEntryOptions,
): Promise<LocalWorkflowKVEntryDetail | undefined> {
  const rootDir = normalizeLocalKVRootDir(options.rootDir);
  await ensureLocalWorkflowStorageFormat(rootDir, options.storageKind);
  await recoverLocalKVTransactions(rootDir);
  const input = normalizeWorkflowKVStoreInput(options);
  const entryPath = resolveLocalKVEntryPath(rootDir, input);
  const entry = await readLocalKVEntry(entryPath, input);
  if (entry === undefined) {
    return undefined;
  }

  const entryStat = await readLocalKVEntryStat(entryPath);
  return createLocalKVEntryDetail(entry, entryStat?.mtime.toISOString() ?? new Date(0).toISOString());
}

/**
 * Removes one entry from a local store directory and reports whether it was
 * there. Inspection callers use this instead of holding a store instance.
 */
export async function deleteLocalWorkflowKVEntry(
  options: GetLocalWorkflowKVEntryOptions,
): Promise<boolean> {
  const input = normalizeWorkflowKVStoreInput(options);
  const store = createLocalWorkflowKVStore({
    rootDir: normalizeLocalKVRootDir(options.rootDir),
    storageKind: input.storageKind,
  });
  return store.deleteValue(input);
}

export function normalizeWorkflowKVStoreInput(
  input: WorkflowKVStoreGetInput,
): NormalizedWorkflowKVStoreInput {
  const storageKind = normalizeWorkflowStorageKind(input.storageKind);
  const projectId = normalizeWorkflowKVProjectId(input.projectId);
  const key = normalizeWorkflowKVKey(input.key);

  switch (input.scope) {
    case "project":
      return {
        storageKind,
        scope: "project",
        projectId,
        key,
      };
    case "conversation":
      return {
        storageKind,
        scope: "conversation",
        projectId,
        conversationId: normalizeWorkflowKVConversationId(input.conversationId),
        key,
      };
    default:
      throw new WorkflowError({
        type: "input_validation",
        message: `Unsupported workflow KV scope: ${String(input.scope)}.`,
        metadata: { scope: input.scope },
      });
  }
}

export function normalizeWorkflowKVKey(value: string): string {
  const key = value.trim();
  if (key === "") {
    throw new WorkflowError({
      type: "input_validation",
      message: "Workflow KV key must be a non-empty string.",
    });
  }
  return key;
}

export function normalizeWorkflowStorageKind(value: unknown): WorkflowStorageKind {
  if (value !== "kv" && value !== "persistent_value") {
    throw new WorkflowError({
      type: "input_validation",
      message: `Unsupported workflow storage kind: ${String(value)}.`,
    });
  }
  return value;
}

export function normalizeWorkflowKVProjectId(value: string | undefined): string {
  const projectId = value?.trim();
  if (projectId === undefined || projectId === "") {
    throw new WorkflowError({
      type: "input_validation",
      message: "Workflow project storage requires a project id.",
    });
  }
  return projectId;
}

export function normalizeWorkflowKVConversationId(value: string | undefined): string {
  const conversationId = value?.trim();
  if (conversationId === undefined || conversationId === "") {
    throw new WorkflowError({
      type: "input_validation",
      message: "Workflow KV conversation scope requires a conversation id.",
    });
  }
  return conversationId;
}

function createWorkflowKVNamespace(
  store: WorkflowKVStore,
  scope: Omit<WorkflowKVStoreGetInput, "key">,
  source: WorkflowKVWriteSource | undefined,
): WorkflowKVNamespace {
  const namespace: WorkflowKVNamespace = {
    async getValue(key) {
      return store.getValue(normalizeWorkflowKVStoreInput({ ...scope, key }));
    },
    async setValue(key, value) {
      assertKVValue(value);
      const normalized = normalizeWorkflowKVStoreInput({ ...scope, key });
      await store.setValue({ ...normalized, value, source });
    },
    async deleteValue(key) {
      return store.deleteValue(normalizeWorkflowKVStoreInput({ ...scope, key }));
    },
    async updateValue(key, updater) {
      const normalized = normalizeWorkflowKVStoreInput({ ...scope, key });
      if (store.updateValue !== undefined) {
        return store.updateValue({ ...normalized, source }, updater);
      }

      const current = await store.getValue(normalized);
      const value = updater(current);
      assertKVValue(value);
      await store.setValue({ ...normalized, value, source });
      return value;
    },
  };

  if (store.withNamespaceLock !== undefined) {
    namespace.withLock = async <T>(operation: () => Promise<T> | T): Promise<T> =>
      store.withNamespaceLock!(scope, operation);
  }

  if (store.withNamespaceReadLock !== undefined) {
    namespace.withReadLock = async <T>(operation: () => Promise<T> | T): Promise<T> =>
      store.withNamespaceReadLock!(scope, operation);
  }

  if (store.executeNamespaceMutation !== undefined) {
    namespace.executeMutation = async <T>(mutation: WorkflowKVNamespaceMutation): Promise<T> =>
      store.executeNamespaceMutation!(scope, mutation);
  }

  return namespace;
}

function createUnavailableWorkflowPersistentValueContext(): WorkflowPersistentValueContext {
  const namespace = createUnavailableWorkflowPersistentValueNamespace();

  return {
    getValue: namespace.getValue,
    setValue: namespace.setValue,
    deleteValue: namespace.deleteValue,
    updateValue: namespace.updateValue,
    withLock: namespace.withLock,
    conversation: createUnavailableWorkflowPersistentValueNamespace(),
  };
}

function createUnavailableWorkflowPersistentValueNamespace(): WorkflowKVNamespace {
  return {
    async getValue() {
      throw createUnavailableWorkflowPersistentValueError();
    },
    async setValue() {
      throw createUnavailableWorkflowPersistentValueError();
    },
    async deleteValue(): Promise<boolean> {
      throw createUnavailableWorkflowPersistentValueError();
    },
    async updateValue() {
      throw createUnavailableWorkflowPersistentValueError();
    },
    async withLock<T>() {
      throw createUnavailableWorkflowPersistentValueError();
    },
  };
}

function createUnavailableWorkflowPersistentValueError(): WorkflowError {
  return new WorkflowError({
    type: "input_validation",
    message: "Workflow PersistentValue requires a configured local store, server database storage, or an injected persistent value store. Set STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR for local CLI/App runs, or configure STEAMHARNESS_SERVER_URL and STEAMHARNESS_SERVER_ADMIN_KEY.",
  });
}

function assertKVValue(value: unknown): void {
  if (value === undefined) {
    throw new WorkflowError({
      type: "input_validation",
      message: "Workflow KV value cannot be undefined.",
    });
  }
}

interface LocalWorkflowKVEntry {
  storageKind: WorkflowStorageKind;
  scope: WorkflowKVScope;
  projectId: string;
  key: string;
  conversationId?: string;
  value: unknown;
  source?: WorkflowKVWriteSource;
  updatedAt?: string;
}

interface LocalWorkflowKVEntryMetadata extends Omit<LocalWorkflowKVEntry, "value"> {
  version: 1;
  entryMtimeMs?: number;
  valueType: WorkflowKVValueType;
  valueSizeBytes: number;
  valuePreview: string;
}

interface LocalKVInspectionIndex {
  version: 1;
  entries: LocalWorkflowKVEntrySummary[];
}

type NormalizedWorkflowKVNamespaceLockInput =
  | { storageKind: WorkflowStorageKind; scope: "project"; projectId: string }
  | {
      storageKind: WorkflowStorageKind;
      scope: "conversation";
      projectId: string;
      conversationId: string;
    };

interface LocalKVTransactionWriteValue {
  input: NormalizedWorkflowKVStoreInput;
  value: unknown;
  source?: WorkflowKVWriteSource;
}

interface LocalKVTransactionWriteDelete {
  input: NormalizedWorkflowKVStoreInput;
  deleted: true;
}

type LocalKVTransactionWrite = LocalKVTransactionWriteValue | LocalKVTransactionWriteDelete;

interface LocalKVNamespaceTransaction {
  namespace: NormalizedWorkflowKVNamespaceLockInput;
  writes: Map<string, LocalKVTransactionWrite>;
}

interface LocalKVTransactionJournal {
  version: 1;
  namespace: NormalizedWorkflowKVNamespaceLockInput;
  writes: LocalKVTransactionWrite[];
}

interface LocalKVLockRecord {
  token: string;
  pid: number;
  createdAt: string;
}

interface LocalKVObservedLock {
  token?: string;
  pid?: number;
  mtimeMs: number;
}

interface LocalKVEntryLocation {
  input: NormalizedWorkflowKVStoreInput;
  entryPath: string;
}

interface NormalizedLocalKVInspectionOptions {
  rootDir: string;
  storageKind: WorkflowStorageKind;
  pageSize: number;
  cursor?: string;
  scope?: WorkflowKVScope;
  projectId?: string;
  conversationId?: string;
  valueType?: WorkflowKVValueType;
  query?: string;
}

interface LocalKVPageCursor {
  updatedAt: string;
  storageKind: WorkflowStorageKind;
  scope: WorkflowKVScope;
  key: string;
  projectId: string;
  conversationId?: string;
}

const LOCAL_KV_LOCK_RETRY_MS = 10;
const LOCAL_KV_LOCK_TIMEOUT_MS = 30_000;
const LOCAL_KV_LOCK_STALE_MS = 120_000;
const LOCAL_KV_INSPECTION_INDEX_VERSION = 1;
const LOCAL_KV_TRANSACTION_JOURNAL_VERSION = 1;
const LOCAL_STEAMHARNESS_STORAGE_FORMAT_VERSION = 2;
const LOCAL_STEAMHARNESS_STORAGE_FORMAT_FILE = ".workflow-storage-format.json";
const LOCAL_STEAMHARNESS_STORAGE_DATA_ENTRIES = [
  ".inspection",
  ".locks",
  ".transactions",
  "conversation",
  "global",
  "project",
  "workflow",
] as const;
let localKVTemporaryFileSequence = 0;

function normalizeLocalKVRootDir(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkflowError({
      type: "input_validation",
      message: "Local workflow KV rootDir must be a non-empty path.",
    });
  }

  return path.resolve(value.trim());
}

async function ensureLocalWorkflowStorageFormat(
  rootDir: string,
  storageKind: WorkflowStorageKind,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  // Initialization can run concurrently in separate worker processes. Keep
  // the lock outside the legacy data directories because those directories
  // are removed while upgrading an unmarked root.
  const initializationLockPath = resolveLocalKVPath(rootDir, [
    `${LOCAL_STEAMHARNESS_STORAGE_FORMAT_FILE}.lock`,
  ]);
  await withLocalKVPathLock(initializationLockPath, async () => {
    const markerPath = resolveLocalKVPath(rootDir, [LOCAL_STEAMHARNESS_STORAGE_FORMAT_FILE]);
    const marker = await readLocalKVJsonFile(markerPath);
    if (
      marker !== undefined &&
      isRecord(marker.value) &&
      marker.value["version"] === LOCAL_STEAMHARNESS_STORAGE_FORMAT_VERSION &&
      marker.value["storageKind"] === storageKind
    ) {
      return;
    }
    if (
      marker !== undefined &&
      isRecord(marker.value) &&
      marker.value["version"] === LOCAL_STEAMHARNESS_STORAGE_FORMAT_VERSION &&
      isWorkflowStorageKind(marker.value["storageKind"])
    ) {
      throw new WorkflowError({
        type: "input_validation",
        message: `Local workflow storage root is already assigned to ${marker.value["storageKind"]}.`,
        metadata: { rootDir, storageKind, existingStorageKind: marker.value["storageKind"] },
      });
    }

    for (const entry of LOCAL_STEAMHARNESS_STORAGE_DATA_ENTRIES) {
      await rm(resolveLocalKVPath(rootDir, [entry]), { recursive: true, force: true });
    }
    await writeLocalKVFileAtomically(markerPath, `${JSON.stringify({
      version: LOCAL_STEAMHARNESS_STORAGE_FORMAT_VERSION,
      storageKind,
    })}\n`);
  });
}

function assertWorkflowStorageKindMatches(
  expected: WorkflowStorageKind,
  actual: WorkflowStorageKind,
): void {
  if (expected === actual) return;
  throw new WorkflowError({
    type: "input_validation",
    message: `Workflow storage kind ${actual} cannot be used with a ${expected} store.`,
    metadata: { expectedStorageKind: expected, actualStorageKind: actual },
  });
}

function normalizeWorkflowKVWriteSource(
  source: WorkflowKVWriteSource | undefined,
): WorkflowKVWriteSource | undefined {
  if (source === undefined) {
    return undefined;
  }

  const normalized: WorkflowKVWriteSource = {};
  for (const key of ["projectId", "runId", "conversationId"] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new WorkflowError({
        type: "input_validation",
        message: `Workflow KV source ${key} must be a string.`,
      });
    }
    normalized[key] = value;
  }

  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function serializeLocalKVValue(value: unknown): { value: unknown; serialized: string } {
  assertKVValue(value);

  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new WorkflowError({
        type: "input_validation",
        message: "Workflow KV value must be JSON serializable.",
      });
    }
    return { value: JSON.parse(serialized) as unknown, serialized };
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw new WorkflowError({
      type: "input_validation",
      message: "Workflow KV value must be JSON serializable.",
      metadata: {
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function createLocalKVEntryMetadata(
  entry: LocalWorkflowKVEntry,
  serializedValue: string,
  entryMtimeMs: number,
): LocalWorkflowKVEntryMetadata {
  return {
    version: 1,
    entryMtimeMs,
    storageKind: entry.storageKind,
    scope: entry.scope,
    projectId: entry.projectId,
    conversationId: entry.conversationId,
    key: entry.key,
    source: entry.source,
    updatedAt: entry.updatedAt,
    valueType: getWorkflowKVValueType(entry.value),
    valueSizeBytes: Buffer.byteLength(serializedValue, "utf8"),
    valuePreview: createWorkflowKVValuePreview(entry.value),
  };
}

function getWorkflowKVValueType(value: unknown): WorkflowKVValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

function createWorkflowKVValuePreview(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return serialized.length > 160 ? `${serialized.slice(0, 157)}...` : serialized;
}

async function writeLocalKVEntry(
  rootDir: string,
  entryPath: string,
  input: NormalizedWorkflowKVStoreInput,
  value: unknown,
  source: WorkflowKVWriteSource | undefined,
): Promise<void> {
  // The caller holds the inspection-index lock. A leftover dirty marker makes
  // the next reader rebuild from entry files after an interrupted write.
  await writeLocalKVEntries(rootDir, [{ input, value, source }]);
}

async function applyLocalKVTransactionWrites(
  rootDir: string,
  writes: LocalKVTransactionWrite[],
): Promise<void> {
  await withLocalKVInspectionIndexLock(rootDir, () => writeLocalKVEntries(rootDir, writes));
}

async function writeLocalKVEntries(
  rootDir: string,
  writes: LocalKVTransactionWrite[],
): Promise<void> {
  if (writes.length === 0) return;
  // The dirty marker goes down before any file changes, so an interrupted
  // commit makes the next reader rebuild the index from the entry files.
  const inspectionIndexWasDirty = await markLocalKVInspectionIndexDirty(rootDir);
  const deletions = writes.filter(isLocalKVTransactionWriteDelete);
  const values = writes.filter(
    (write): write is LocalKVTransactionWriteValue => !isLocalKVTransactionWriteDelete(write),
  );
  await Promise.all(deletions.map((write) => removeLocalKVEntryFiles(rootDir, write.input)));
  const metadata = await Promise.all(values.map((write) =>
    writeLocalKVEntryFiles(
      resolveLocalKVEntryPath(rootDir, write.input),
      write.input,
      write.value,
      write.source,
    ),
  ));
  await updateLocalKVInspectionIndexEntries(
    rootDir,
    metadata,
    writes[0]!.input.storageKind,
    deletions.map((write) => getLocalKVTransactionWriteKey(write.input)),
    inspectionIndexWasDirty,
  );
}

/**
 * Removes entry files and their metadata, then drops them from the inspection
 * index. Returns whether any entry file actually existed.
 */
async function removeLocalKVEntries(
  rootDir: string,
  inputs: NormalizedWorkflowKVStoreInput[],
): Promise<boolean> {
  if (inputs.length === 0) return false;
  const inspectionIndexWasDirty = await markLocalKVInspectionIndexDirty(rootDir);
  const existing = await Promise.all(inputs.map(async (input) =>
    (await readLocalKVEntryStat(resolveLocalKVEntryPath(rootDir, input))) !== undefined));
  await Promise.all(inputs.map((input) => removeLocalKVEntryFiles(rootDir, input)));
  await updateLocalKVInspectionIndexEntries(
    rootDir,
    [],
    inputs[0]!.storageKind,
    inputs.map(getLocalKVTransactionWriteKey),
    inspectionIndexWasDirty,
  );
  return existing.some(Boolean);
}

async function removeLocalKVEntryFiles(
  rootDir: string,
  input: NormalizedWorkflowKVStoreInput,
): Promise<void> {
  const entryPath = resolveLocalKVEntryPath(rootDir, input);
  await rm(entryPath, { force: true });
  await rm(resolveLocalKVEntryMetadataPath(entryPath), { force: true });
}

async function writeLocalKVEntryFiles(
  entryPath: string,
  input: NormalizedWorkflowKVStoreInput,
  value: unknown,
  source: WorkflowKVWriteSource | undefined,
): Promise<LocalWorkflowKVEntryMetadata> {
  const serializedValue = serializeLocalKVValue(value);
  const entry: LocalWorkflowKVEntry = {
    storageKind: input.storageKind,
    scope: input.scope,
    projectId: input.projectId,
    conversationId: readNormalizedConversationId(input),
    key: input.key,
    value: serializedValue.value,
    source: normalizeWorkflowKVWriteSource(source),
    updatedAt: new Date().toISOString(),
  };

  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeLocalKVFileAtomically(entryPath, `${JSON.stringify(entry, null, 2)}\n`);
  const entryStat = await readLocalKVEntryStat(entryPath);
  if (entryStat === undefined) {
    throw new WorkflowError({
      type: "workflow_execution",
      message: "Local workflow KV entry disappeared before metadata could be written.",
    });
  }

  const metadata = createLocalKVEntryMetadata(entry, serializedValue.serialized, entryStat.mtimeMs);
  await writeLocalKVFileAtomically(
    resolveLocalKVEntryMetadataPath(entryPath),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  return metadata;
}

async function writeLocalKVFileAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = createLocalKVTemporaryPath(filePath);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function createLocalKVTemporaryPath(filePath: string): string {
  localKVTemporaryFileSequence += 1;
  return `${filePath}.${process.pid}.${Date.now().toString(36)}.${localKVTemporaryFileSequence.toString(36)}.tmp`;
}

function normalizeWorkflowKVNamespaceLockInput(
  input: WorkflowKVNamespaceLockInput,
): NormalizedWorkflowKVNamespaceLockInput {
  const storageKind = normalizeWorkflowStorageKind(input.storageKind);
  const projectId = normalizeWorkflowKVProjectId(input.projectId);
  switch (input.scope) {
    case "project":
      return {
        storageKind,
        scope: "project",
        projectId,
      };
    case "conversation":
      return {
        storageKind,
        scope: "conversation",
        projectId,
        conversationId: normalizeWorkflowKVConversationId(input.conversationId),
      };
    default:
      throw new WorkflowError({
        type: "input_validation",
        message: `Unsupported workflow KV scope: ${String(input.scope)}.`,
        metadata: { scope: input.scope },
      });
  }
}

function readLocalKVNamespaceConversationId(
  input: NormalizedWorkflowKVNamespaceLockInput,
): string | undefined {
  return input.scope === "conversation" ? input.conversationId : undefined;
}

function resolveLocalKVEntryPath(
  rootDir: string,
  input: NormalizedWorkflowKVStoreInput,
): string {
  const parts: string[] = [input.scope, encodePathSegment(input.projectId)];

  if (input.scope === "conversation") {
    parts.push(encodePathSegment(input.conversationId));
  }

  parts.push(`${encodePathSegment(input.key)}.json`);
  return resolveLocalKVPath(rootDir, parts);
}

function resolveLocalKVEntryMetadataPath(entryPath: string): string {
  return `${entryPath.slice(0, -".json".length)}.meta.json`;
}

function resolveLocalKVEntryLockPath(entryPath: string): string {
  return `${entryPath}.lock`;
}

function resolveLocalKVInspectionIndexPath(rootDir: string): string {
  return resolveLocalKVPath(rootDir, [".inspection", "local-kv-index.v1.json"]);
}

function resolveLocalKVInspectionIndexDirtyPath(rootDir: string): string {
  return resolveLocalKVPath(rootDir, [".inspection", "local-kv-index.v1.dirty"]);
}

function resolveLocalKVInspectionIndexLockPath(rootDir: string): string {
  return resolveLocalKVPath(rootDir, [".locks", "inspection", "local-kv-index.v1.lock"]);
}

function resolveLocalKVTransactionDirectory(rootDir: string): string {
  return resolveLocalKVPath(rootDir, [".transactions"]);
}

function resolveLocalKVTransactionJournalPath(rootDir: string, transactionId: string): string {
  return resolveLocalKVPath(rootDir, [".transactions", `${transactionId}.json`]);
}

function resolveLocalKVTransactionRecoveryLockPath(rootDir: string): string {
  return resolveLocalKVPath(rootDir, [".locks", "transactions", "recovery.lock"]);
}

function resolveLocalKVNamespaceLockPath(
  rootDir: string,
  input: NormalizedWorkflowKVNamespaceLockInput,
): string {
  const parts = [
    ".locks",
    "namespaces",
    input.storageKind,
    input.scope,
    encodePathSegment(input.projectId),
  ];
  if (input.scope === "conversation") {
    parts.push(encodePathSegment(input.conversationId));
  }
  parts.push("lock");
  return resolveLocalKVPath(rootDir, parts);
}

function resolveLocalKVPath(rootDir: string, parts: string[]): string {
  const candidate = path.resolve(rootDir, ...parts);
  const relative = path.relative(rootDir, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new WorkflowError({
      type: "input_validation",
      message: "Local workflow KV path must remain inside rootDir.",
    });
  }
  return candidate;
}

async function withLocalKVInspectionIndexLock<T>(
  rootDir: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  return withLocalKVPathLock(resolveLocalKVInspectionIndexLockPath(rootDir), operation);
}

async function withRecoveredLocalKVNamespaceLock<T>(
  rootDir: string,
  namespace: NormalizedWorkflowKVNamespaceLockInput,
  operation: () => Promise<T> | T,
): Promise<T> {
  return withLocalKVPathLock(
    resolveLocalKVNamespaceLockPath(rootDir, namespace),
    async () => {
      await recoverLocalKVTransactionsForLockedNamespace(rootDir, namespace);
      return operation();
    },
  );
}

async function withLocalKVPathLock<T>(
  lockPath: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const release = await acquireLocalKVPathLock(lockPath);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function acquireLocalKVPathLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  const token = `${process.pid}-${startedAt.toString(36)}-${(++localKVTemporaryFileSequence).toString(36)}`;
  const candidate = `${lockPath}.${randomUUID()}.tmp`;
  const record: LocalKVLockRecord = { token, pid: process.pid, createdAt: new Date().toISOString() };
  try {
    await writeFile(candidate, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    while (true) {
      try {
        // Publish only a complete record. A crash before link leaves no lock;
        // a crash after it always leaves the PID needed for immediate recovery.
        await link(candidate, lockPath);
        return async () => releaseLocalKVPathLock(lockPath, token);
      } catch (error) {
        const lockAlreadyExists = isLocalKVAlreadyExistsError(error);
        if (!lockAlreadyExists && !isLocalKVTransientLockContentionError(error)) {
          throw error;
        }
        if (lockAlreadyExists && await removeStaleLocalKVPathLock(lockPath)) {
          continue;
        }
        if (Date.now() - startedAt >= LOCAL_KV_LOCK_TIMEOUT_MS) {
          throw new WorkflowError({
            type: "workflow_execution",
            message: "Timed out waiting for a local workflow KV operation.",
          });
        }
        await waitForLocalKVLockRetry();
      }
    }
  } finally {
    await rm(candidate, { force: true });
  }
}

async function releaseLocalKVPathLock(lockPath: string, token: string): Promise<void> {
  const lock = await readLocalKVPathLock(lockPath);
  if (lock?.token !== token) {
    return;
  }
  await rm(lockPath, { force: true });
}

async function removeStaleLocalKVPathLock(lockPath: string): Promise<boolean> {
  const observed = await readLocalKVPathLock(lockPath);
  if (observed === undefined) return false;
  // A known dead owner cannot finish its write. Recover it immediately after
  // a worker crash; only incomplete lock records need the age grace period.
  if (observed.pid !== undefined ? isLocalKVLockOwnerAlive(observed.pid)
    : Date.now() - observed.mtimeMs < LOCAL_KV_LOCK_STALE_MS) {
    return false;
  }

  // Only one reclaimer may recheck and unlink. The OS releases this guard on
  // exit, including if a process dies while reclaiming a stale file lock.
  const guard = new DatabaseSync(`${lockPath}.recovery.sqlite`);
  try {
    guard.exec("PRAGMA busy_timeout = 0");
    try { guard.exec("BEGIN EXCLUSIVE"); }
    catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (code === 5 || code === 6) return false; // SQLITE_BUSY / SQLITE_LOCKED
      throw error;
    }
    const confirmed = await readLocalKVPathLock(lockPath);
    if (
      confirmed === undefined ||
      confirmed.token !== observed.token ||
      confirmed.pid !== observed.pid ||
      confirmed.mtimeMs !== observed.mtimeMs
    ) {
      return false;
    }
    await rm(lockPath, { force: true });
    return true;
  } finally { guard.close(); }
}

async function readLocalKVPathLock(lockPath: string): Promise<LocalKVObservedLock | undefined> {
  let lockStat;
  try {
    lockStat = await lstat(lockPath);
  } catch (error) {
    if (isMissingLocalKVPath(error)) {
      return undefined;
    }
    throw error;
  }
  if (!lockStat.isFile()) {
    return undefined;
  }

  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
    if (isLocalKVLockRecord(value)) {
      return { token: value.token, pid: value.pid, mtimeMs: lockStat.mtimeMs };
    }
  } catch {
    // A process can exit after creating the exclusive lock file but before its
    // record is flushed. Keep the stat so stale-lock recovery can reclaim it.
  }
  return { mtimeMs: lockStat.mtimeMs };
}

function isLocalKVLockRecord(value: unknown): value is LocalKVLockRecord {
  return isRecord(value) &&
    typeof value["token"] === "string" &&
    value["token"] !== "" &&
    typeof value["pid"] === "number" &&
    Number.isInteger(value["pid"]) &&
    value["pid"] > 0 &&
    typeof value["createdAt"] === "string";
}

function isLocalKVLockOwnerAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isLocalKVPermissionError(error);
  }
}

function isLocalKVAlreadyExistsError(error: unknown): boolean {
  return isLocalKVErrorCode(error, "EEXIST");
}

function isLocalKVPermissionError(error: unknown): boolean {
  return isLocalKVErrorCode(error, "EPERM") || isLocalKVErrorCode(error, "EACCES");
}

function isLocalKVTransientLockContentionError(error: unknown): boolean {
  // Windows can briefly report permission errors while another process releases the lock.
  return process.platform === "win32" && isLocalKVPermissionError(error);
}

function isLocalKVErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === code;
}

function waitForLocalKVLockRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, LOCAL_KV_LOCK_RETRY_MS));
}

async function readLocalKVInspectionIndex(
  rootDir: string,
  storageKind: WorkflowStorageKind,
): Promise<LocalWorkflowKVEntrySummary[]> {
  const existing = await readCleanLocalKVInspectionIndex(rootDir);
  if (existing !== undefined) {
    return existing.entries;
  }

  return withLocalKVInspectionIndexLock(rootDir, async () => {
    const current = await readCleanLocalKVInspectionIndex(rootDir);
    if (current !== undefined) {
      return current.entries;
    }

    const entries = await buildLocalKVInspectionIndex(rootDir, storageKind);
    await writeLocalKVInspectionIndex(rootDir, entries);
    await clearLocalKVInspectionIndexDirty(rootDir);
    return entries;
  });
}

async function readCleanLocalKVInspectionIndex(
  rootDir: string,
): Promise<LocalKVInspectionIndex | undefined> {
  if (await isLocalKVInspectionIndexDirty(rootDir)) {
    return undefined;
  }
  return readLocalKVInspectionIndexFile(rootDir);
}

async function readLocalKVInspectionIndexFile(
  rootDir: string,
): Promise<LocalKVInspectionIndex | undefined> {
  const file = await readLocalKVJsonFile(resolveLocalKVInspectionIndexPath(rootDir));
  return file !== undefined && isLocalKVInspectionIndex(file.value) ? file.value : undefined;
}

async function buildLocalKVInspectionIndex(
  rootDir: string,
  storageKind: WorkflowStorageKind,
): Promise<LocalWorkflowKVEntrySummary[]> {
  const locations = await listLocalKVEntryLocations({
    rootDir,
    storageKind,
    pageSize: 50,
    scope: undefined,
    projectId: undefined,
    conversationId: undefined,
    valueType: undefined,
    query: undefined,
  });
  const entries = (await mapWithConcurrency(
    locations,
    16,
    (location) => readLocalKVEntrySummary(location),
  )).filter((summary): summary is LocalWorkflowKVEntrySummary => summary !== undefined);
  entries.sort(compareLocalKVEntries);
  return entries;
}

async function markLocalKVInspectionIndexDirty(rootDir: string): Promise<boolean> {
  const dirtyPath = resolveLocalKVInspectionIndexDirtyPath(rootDir);
  const wasDirty = await isLocalKVInspectionIndexDirty(rootDir);
  await mkdir(path.dirname(dirtyPath), { recursive: true });
  await writeLocalKVFileAtomically(dirtyPath, `${new Date().toISOString()}\n`);
  return wasDirty;
}

async function isLocalKVInspectionIndexDirty(rootDir: string): Promise<boolean> {
  try {
    await lstat(resolveLocalKVInspectionIndexDirtyPath(rootDir));
    return true;
  } catch (error) {
    if (isMissingLocalKVPath(error)) {
      return false;
    }
    throw error;
  }
}

async function clearLocalKVInspectionIndexDirty(rootDir: string): Promise<void> {
  await rm(resolveLocalKVInspectionIndexDirtyPath(rootDir), { force: true });
}

async function updateLocalKVInspectionIndexEntries(
  rootDir: string,
  metadataEntries: LocalWorkflowKVEntryMetadata[],
  storageKind: WorkflowStorageKind,
  removedIdentities: string[],
  inspectionIndexWasDirty: boolean,
): Promise<void> {
  const current = inspectionIndexWasDirty
    ? undefined
    : await readLocalKVInspectionIndexFile(rootDir);
  const currentEntries = current === undefined
    ? await buildLocalKVInspectionIndex(rootDir, storageKind)
    : [...current.entries];
  const summaries = metadataEntries.map(createLocalKVEntrySummaryFromMetadata);
  // Upserts and removals rewrite the same rows, so both drop the current entry
  // for their identity before the upserts are appended.
  const stale = new Set([
    ...removedIdentities,
    ...summaries.map(getLocalKVInspectionEntryIdentity),
  ]);
  const nextEntries = currentEntries.filter((entry) => !stale.has(getLocalKVInspectionEntryIdentity(entry)));
  nextEntries.push(...summaries);
  nextEntries.sort(compareLocalKVEntries);

  await writeLocalKVInspectionIndex(rootDir, nextEntries);
  await clearLocalKVInspectionIndexDirty(rootDir);
}

async function writeLocalKVInspectionIndex(
  rootDir: string,
  entries: LocalWorkflowKVEntrySummary[],
): Promise<void> {
  const indexPath = resolveLocalKVInspectionIndexPath(rootDir);
  const index: LocalKVInspectionIndex = {
    version: LOCAL_KV_INSPECTION_INDEX_VERSION,
    entries,
  };
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeLocalKVFileAtomically(indexPath, `${JSON.stringify(index)}\n`);
}

function isLocalKVInspectionIndex(value: unknown): value is LocalKVInspectionIndex {
  if (
    !isRecord(value) ||
    value["version"] !== LOCAL_KV_INSPECTION_INDEX_VERSION ||
    !Array.isArray(value["entries"])
  ) {
    return false;
  }

  const identities = new Set<string>();
  let previous: LocalWorkflowKVEntrySummary | undefined;
  for (const entry of value["entries"]) {
    if (!isLocalKVEntrySummary(entry)) {
      return false;
    }
    const identity = getLocalKVInspectionEntryIdentity(entry);
    if (identities.has(identity) || (previous !== undefined && compareLocalKVEntries(previous, entry) > 0)) {
      return false;
    }
    identities.add(identity);
    previous = entry;
  }
  return true;
}

function isLocalKVEntrySummary(value: unknown): value is LocalWorkflowKVEntrySummary {
  if (
    !isRecord(value) ||
    !isWorkflowStorageKind(value["storageKind"]) ||
    !isWorkflowKVScope(value["scope"]) ||
    typeof value["projectId"] !== "string" ||
    value["projectId"].trim() === "" ||
    typeof value["key"] !== "string" ||
    value["key"].trim() === "" ||
    !isWorkflowKVValueType(value["valueType"]) ||
    typeof value["valueSizeBytes"] !== "number" ||
    !Number.isInteger(value["valueSizeBytes"]) ||
    value["valueSizeBytes"] < 0 ||
    typeof value["valuePreview"] !== "string" ||
    typeof value["updatedAt"] !== "string" ||
    Number.isNaN(Date.parse(value["updatedAt"])) ||
    (value["source"] !== undefined && !isWorkflowKVWriteSource(value["source"]))
  ) {
    return false;
  }

  const conversationId = value["conversationId"];
  if (conversationId !== undefined && (typeof conversationId !== "string" || conversationId.trim() === "")) {
    return false;
  }

  return value["scope"] === "project"
    ? conversationId === undefined
    : typeof conversationId === "string";
}

function getLocalKVInspectionEntryIdentity(entry: LocalWorkflowKVEntrySummary): string {
  return getLocalKVEntryIdentity(entry);
}

async function listLocalKVEntryLocations(
  options: NormalizedLocalKVInspectionOptions,
): Promise<LocalKVEntryLocation[]> {
  const locations: LocalKVEntryLocation[] = [];
  const scopes = options.scope === undefined
    ? (["project", "conversation"] as const)
    : [options.scope];

  for (const scope of scopes) {
    const projectIds = options.projectId === undefined
      ? await readEncodedLocalKVDirectory(options.rootDir, [scope])
      : [options.projectId];
    for (const projectId of projectIds) {
      if (scope === "project") {
        locations.push(...await listLocalKVEntriesInDirectory({
          rootDir: options.rootDir,
          parts: [scope, encodePathSegment(projectId)],
          input: { storageKind: options.storageKind, scope, projectId },
        }));
        continue;
      }

      const conversationIds = options.conversationId === undefined
        ? await readEncodedLocalKVDirectory(
            options.rootDir,
            [scope, encodePathSegment(projectId)],
          )
        : [options.conversationId];
      for (const conversationId of conversationIds) {
        locations.push(...await listLocalKVEntriesInDirectory({
          rootDir: options.rootDir,
          parts: [scope, encodePathSegment(projectId), encodePathSegment(conversationId)],
          input: { storageKind: options.storageKind, scope, projectId, conversationId },
        }));
      }
    }
  }

  return locations;
}

async function readEncodedLocalKVDirectory(rootDir: string, parts: string[]): Promise<string[]> {
  const directory = resolveLocalKVPath(rootDir, parts);
  const entries = await readLocalKVDirectory(directory);
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const value = decodePathSegment(entry.name);
    return value === undefined ? [] : [value];
  });
}

async function listLocalKVEntriesInDirectory(options: {
  rootDir: string;
  parts: string[];
  input: Omit<WorkflowKVStoreGetInput, "key">;
}): Promise<LocalKVEntryLocation[]> {
  const directory = resolveLocalKVPath(options.rootDir, options.parts);
  const entries = await readLocalKVDirectory(directory);
  const locations: LocalKVEntryLocation[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const key = decodeLocalKVEntryFilename(entry.name);
    if (key === undefined) continue;
    const input = normalizeWorkflowKVStoreInput({ ...options.input, key });
    locations.push({
      input,
      entryPath: resolveLocalKVEntryPath(options.rootDir, input),
    });
  }

  return locations;
}

async function readLocalKVDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingLocalKVPath(error)) {
      return [];
    }
    throw error;
  }
}

async function readLocalKVEntrySummary(
  location: LocalKVEntryLocation,
): Promise<LocalWorkflowKVEntrySummary | undefined> {
  const [entryStat, metadata] = await Promise.all([
    readLocalKVEntryStat(location.entryPath),
    readLocalKVJsonFile(resolveLocalKVEntryMetadataPath(location.entryPath)),
  ]);
  if (entryStat === undefined) {
    return undefined;
  }

  if (
    metadata !== undefined &&
    metadata.mtimeMs >= entryStat.mtimeMs &&
    isLocalKVEntryMetadata(metadata.value, location.input) &&
    (metadata.value.entryMtimeMs === undefined || metadata.value.entryMtimeMs === entryStat.mtimeMs)
  ) {
    return createLocalKVEntrySummaryFromMetadata(metadata.value);
  }

  const entry = await readLocalKVEntry(location.entryPath, location.input);
  return entry === undefined
    ? undefined
    : createLocalKVEntrySummary(entry, entryStat.mtime.toISOString());
}

async function readLocalKVEntry(
  entryPath: string,
  expected: NormalizedWorkflowKVStoreInput,
): Promise<LocalWorkflowKVEntry | undefined> {
  const entry = await readLocalKVJsonFile(entryPath, { strict: true });
  if (entry === undefined) return undefined;
  if (!isLocalKVEntry(entry.value, expected)) {
    throw new WorkflowError({
      type: "workflow_execution",
      message: "Local workflow KV entry is invalid and cannot be read safely.",
    });
  }
  return entry.value;
}

async function readLocalKVEntryStat(entryPath: string) {
  try {
    const entryStat = await lstat(entryPath);
    return entryStat.isFile() ? entryStat : undefined;
  } catch (error) {
    if (isMissingLocalKVPath(error)) return undefined;
    throw error;
  }
}

async function readLocalKVJsonFile(
  filePath: string,
  options: { strict?: boolean } = {},
): Promise<{ value: unknown; mtimeMs: number } | undefined> {
  const fileStat = await readLocalKVEntryStat(filePath);
  if (fileStat === undefined) {
    return undefined;
  }

  try {
    const content = await readFile(filePath, "utf8");
    return { value: JSON.parse(content) as unknown, mtimeMs: fileStat.mtimeMs };
  } catch (error) {
    if (isMissingLocalKVPath(error)) return undefined;
    if (options.strict) {
      throw new WorkflowError({
        type: "workflow_execution",
        message: "Local workflow KV entry is unreadable and cannot be overwritten safely.",
      });
    }
    return undefined;
  }
}

function createLocalKVEntrySummaryFromMetadata(
  metadata: LocalWorkflowKVEntryMetadata,
): LocalWorkflowKVEntrySummary {
  return {
    storageKind: metadata.storageKind,
    scope: metadata.scope,
    projectId: metadata.projectId,
    key: metadata.key,
    conversationId: metadata.conversationId,
    valueType: metadata.valueType,
    valueSizeBytes: metadata.valueSizeBytes,
    valuePreview: metadata.valuePreview,
    updatedAt: readLocalKVUpdatedAt(metadata.updatedAt, new Date(0).toISOString()),
    source: metadata.source,
  };
}

function createLocalKVEntrySummary(
  entry: LocalWorkflowKVEntry,
  fallbackUpdatedAt: string,
): LocalWorkflowKVEntrySummary {
  const serializedValue = JSON.stringify(entry.value) ?? "";
  return {
    storageKind: entry.storageKind,
    scope: entry.scope,
    projectId: entry.projectId,
    key: entry.key,
    conversationId: entry.conversationId,
    valueType: getWorkflowKVValueType(entry.value),
    valueSizeBytes: Buffer.byteLength(serializedValue, "utf8"),
    valuePreview: createWorkflowKVValuePreview(entry.value),
    updatedAt: readLocalKVUpdatedAt(entry.updatedAt, fallbackUpdatedAt),
    source: entry.source,
  };
}

function createLocalKVEntryDetail(
  entry: LocalWorkflowKVEntry,
  fallbackUpdatedAt: string,
): LocalWorkflowKVEntryDetail {
  return {
    ...createLocalKVEntrySummary(entry, fallbackUpdatedAt),
    value: entry.value,
  };
}

function isLocalKVEntry(
  value: unknown,
  expected: NormalizedWorkflowKVStoreInput,
): value is LocalWorkflowKVEntry {
  if (
    !isRecord(value) ||
    !("value" in value) ||
    !isWorkflowStorageKind(value["storageKind"]) ||
    !isWorkflowKVScope(value["scope"])
  ) {
    return false;
  }

  const entry = value as unknown as LocalWorkflowKVEntry;
  return entry.storageKind === expected.storageKind &&
    entry.scope === expected.scope &&
    entry.projectId === expected.projectId &&
    entry.key === expected.key &&
    entry.conversationId === readNormalizedConversationId(expected) &&
    (entry.source === undefined || isWorkflowKVWriteSource(entry.source));
}

function isLocalKVEntryMetadata(
  value: unknown,
  expected: NormalizedWorkflowKVStoreInput,
): value is LocalWorkflowKVEntryMetadata {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !isWorkflowStorageKind(value["storageKind"]) ||
    !isWorkflowKVValueType(value["valueType"])
  ) {
    return false;
  }
  if (
    typeof value["key"] !== "string" ||
    typeof value["valueSizeBytes"] !== "number" ||
    !Number.isInteger(value["valueSizeBytes"]) ||
    value["valueSizeBytes"] < 0 ||
    typeof value["valuePreview"] !== "string" ||
    (value["entryMtimeMs"] !== undefined &&
      (typeof value["entryMtimeMs"] !== "number" || !Number.isFinite(value["entryMtimeMs"]))) ||
    (value["updatedAt"] !== undefined && typeof value["updatedAt"] !== "string") ||
    (value["source"] !== undefined && !isWorkflowKVWriteSource(value["source"]))
  ) {
    return false;
  }

  return value["storageKind"] === expected.storageKind &&
    value["scope"] === expected.scope &&
    value["projectId"] === expected.projectId &&
    value["key"] === expected.key &&
    value["conversationId"] === readNormalizedConversationId(expected);
}

function isWorkflowKVWriteSource(value: unknown): value is WorkflowKVWriteSource {
  if (!isRecord(value)) return false;
  return ["projectId", "runId", "conversationId"].every((key) =>
    value[key] === undefined || typeof value[key] === "string",
  );
}

function isWorkflowKVScope(value: unknown): value is WorkflowKVScope {
  return value === "project" || value === "conversation";
}

function isWorkflowStorageKind(value: unknown): value is WorkflowStorageKind {
  return value === "kv" || value === "persistent_value";
}

function isWorkflowKVValueType(value: unknown): value is WorkflowKVValueType {
  return value === "null" ||
    value === "array" ||
    value === "object" ||
    value === "string" ||
    value === "number" ||
    value === "boolean";
}

function readLocalKVUpdatedAt(value: string | undefined, fallback: string): string {
  return value !== undefined && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function normalizeLocalKVInspectionOptions(
  options: ListLocalWorkflowKVEntriesOptions,
): NormalizedLocalKVInspectionOptions {
  const rootDir = normalizeLocalKVRootDir(options.rootDir);
  const storageKind = normalizeWorkflowStorageKind(options.storageKind);
  const scope = options.scope;
  if (scope !== undefined && !isWorkflowKVScope(scope)) {
    throw new WorkflowError({
      type: "input_validation",
      message: `Unsupported workflow KV scope: ${String(scope)}.`,
    });
  }
  const projectId = options.projectId === undefined
    ? undefined
    : normalizeWorkflowKVProjectId(options.projectId);
  const conversationId = options.conversationId === undefined
    ? undefined
    : normalizeWorkflowKVConversationId(options.conversationId);
  if (conversationId !== undefined && projectId === undefined) {
    throw new WorkflowError({
      type: "input_validation",
      message: "Local workflow storage conversation filters require a project id.",
    });
  }
  if (scope === "project" && conversationId !== undefined) {
    throw new WorkflowError({
      type: "input_validation",
      message: "Local workflow storage project scope cannot filter by conversation.",
    });
  }
  if (options.valueType !== undefined && !isWorkflowKVValueType(options.valueType)) {
    throw new WorkflowError({
      type: "input_validation",
      message: `Unsupported workflow KV value type: ${String(options.valueType)}.`,
    });
  }

  const pageSize = options.pageSize ?? 50;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new WorkflowError({
      type: "input_validation",
      message: "Local workflow KV pageSize must be an integer from 1 to 100.",
    });
  }

  const query = options.query?.trim().toLowerCase();
  return {
    rootDir,
    storageKind,
    pageSize,
    cursor: options.cursor,
    scope,
    projectId,
    conversationId,
    valueType: options.valueType,
    query: query === "" ? undefined : query,
  };
}

function matchesLocalKVInspectionOptions(
  entry: LocalWorkflowKVEntrySummary,
  options: NormalizedLocalKVInspectionOptions,
): boolean {
  if (options.scope !== undefined && entry.scope !== options.scope) return false;
  if (entry.storageKind !== options.storageKind) return false;
  if (options.projectId !== undefined && entry.projectId !== options.projectId) return false;
  if (options.conversationId !== undefined && entry.conversationId !== options.conversationId) return false;
  if (options.valueType !== undefined && entry.valueType !== options.valueType) return false;
  if (options.query === undefined) return true;

  return [
    entry.key,
    entry.valuePreview,
    entry.projectId,
    entry.conversationId,
    entry.source?.projectId,
    entry.source?.runId,
    entry.source?.conversationId,
  ].some((value) => value?.toLowerCase().includes(options.query!));
}

function compareLocalKVEntries(
  left: LocalWorkflowKVEntrySummary,
  right: LocalWorkflowKVEntrySummary,
): number {
  return compareLocalKVEntryValues(left, right);
}

function compareLocalKVEntryToCursor(
  entry: LocalWorkflowKVEntrySummary,
  cursor: LocalKVPageCursor,
): number {
  return compareLocalKVEntryValues(entry, cursor);
}

function compareLocalKVEntryValues(
  left: Pick<LocalWorkflowKVEntrySummary, "updatedAt" | "storageKind" | "scope" | "key" | "projectId" | "conversationId">,
  right: Pick<LocalWorkflowKVEntrySummary, "updatedAt" | "storageKind" | "scope" | "key" | "projectId" | "conversationId">,
): number {
  return compareDescendingLocalKVValue(left.updatedAt, right.updatedAt) ||
    compareDescendingLocalKVValue(left.storageKind, right.storageKind) ||
    compareDescendingLocalKVValue(left.scope, right.scope) ||
    compareDescendingLocalKVValue(left.projectId, right.projectId) ||
    compareDescendingLocalKVValue(left.conversationId ?? "", right.conversationId ?? "") ||
    compareDescendingLocalKVValue(left.key, right.key);
}

function compareDescendingLocalKVValue(left: string, right: string): number {
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

function createLocalKVPageCursor(entry: LocalWorkflowKVEntrySummary | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return Buffer.from(JSON.stringify({
    updatedAt: entry.updatedAt,
    storageKind: entry.storageKind,
    scope: entry.scope,
    key: entry.key,
    projectId: entry.projectId,
    conversationId: entry.conversationId,
  }), "utf8").toString("base64url");
}

function parseLocalKVPageCursor(value: string | undefined): LocalKVPageCursor | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed["updatedAt"] === "string" &&
      isWorkflowStorageKind(parsed["storageKind"]) &&
      isWorkflowKVScope(parsed["scope"]) &&
      typeof parsed["key"] === "string" &&
      typeof parsed["projectId"] === "string" &&
      (parsed["conversationId"] === undefined || typeof parsed["conversationId"] === "string")
    ) {
      return {
        updatedAt: parsed["updatedAt"],
        storageKind: parsed["storageKind"],
        scope: parsed["scope"],
        key: parsed["key"],
        projectId: parsed["projectId"],
        conversationId: parsed["conversationId"],
      };
    }
  } catch {
    // Invalid cursors intentionally restart at the first page.
  }
  return undefined;
}

async function mapWithConcurrency<Input, Output>(
  items: Input[],
  limit: number,
  worker: (item: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

function decodeLocalKVEntryFilename(value: string): string | undefined {
  if (!value.endsWith(".json") || value.endsWith(".meta.json")) {
    return undefined;
  }
  return decodePathSegment(value.slice(0, -".json".length));
}

function encodePathSegment(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function decodePathSegment(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return encodePathSegment(decoded) === value ? decoded : undefined;
}

function readNormalizedConversationId(
  input: NormalizedWorkflowKVStoreInput,
): string | undefined {
  return input.scope === "conversation" ? input.conversationId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingLocalKVPath(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
