import {
  STEAMHARNESS_RELATED_PROJECT_ALIAS_PATTERN,
  isWorkflowProjectAccessAllowed,
  resolveWorkflowRelatedProjectAccess,
  type WorkflowProjectAccessRule,
  type WorkflowProjectInfo,
  type WorkflowRelatedProjectGrant,
} from "@steamharness/project-info";
import {
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  describeKnowledgeMutationKeys,
  editKnowledgeDocument,
  getKnowledgeDocument,
  isKnowledgeDocumentStorageKey,
  listKnowledgeDocumentPage,
  readKnowledgeDocumentLines,
  searchKnowledgeDocuments,
  type CreateKnowledgeDocumentInput,
  type EditKnowledgeDocumentInput,
  type ListKnowledgeDocumentsInput,
  type ReadKnowledgeDocumentLinesInput,
  type SearchKnowledgeDocumentsInput,
  type WorkflowKnowledgeContext,
  type WorkflowKnowledgeDocument,
  type WorkflowKnowledgeDocumentLinesResult,
  type WorkflowKnowledgeDocumentPage,
  type WorkflowKnowledgeSearchResult,
} from "../knowledge/index";
import {
  normalizeWorkflowKVKey,
  type WorkflowKVNamespace,
  type WorkflowKVNamespaceMutation,
} from "./index";
import { WorkflowError } from "../workflow/errors";

/** One entrypoint of the target project a consumer may call. */
export interface WorkflowRelatedProjectEntrypoint {
  id: string;
  title?: string;
  description?: string;
}

/**
 * Runs one entrypoint of the target project on its behalf.
 *
 * Supplied by the local host, which loads the target project's folder. Data
 * storage may be local or remote. Core owns the grant check and hands the call
 * over only when the target's manifest allows it.
 *
 * A run built from this must not carry a related-project resolver of its own:
 * relations are direct, so a project reached this way cannot reach a third one
 * through itself.
 */
export interface WorkflowRelatedProjectRunner {
  listEntrypoints(): Promise<WorkflowRelatedProjectEntrypoint[]>;
  /**
   * Runs the entrypoint with the argument list its own `createInput` parses,
   * and resolves with the payload it produced — `readEntrypointOutput` is how
   * a host unwraps it from the result the run returns.
   */
  run(entrypointId: string, args: readonly string[]): Promise<unknown>;
}

export interface WorkflowResolvedRelatedProject {
  projectId: string;
  grant: WorkflowRelatedProjectGrant;
  kv: WorkflowKVNamespace;
  /** The target's project-scoped persistent values; omitted when unreachable. */
  persistentValue?: WorkflowKVNamespace;
  /** Omitted when the host cannot run the target project. */
  runner?: WorkflowRelatedProjectRunner;
}

export interface WorkflowRelatedProjectKVResolver {
  resolve(alias: string):
    | Promise<WorkflowResolvedRelatedProject | undefined>
    | WorkflowResolvedRelatedProject
    | undefined;
}

/** @deprecated Renamed to {@link WorkflowResolvedRelatedProject}. */
export type WorkflowResolvedRelatedProjectKV = WorkflowResolvedRelatedProject;

/**
 * The target project's knowledge base, addressed by alias.
 *
 * These are the knowledge helpers Core already exposes, bound to the target
 * rather than to this run's own storage, and each call re-reads the target's
 * grant before it touches anything.
 */
export interface WorkflowRelatedProjectKnowledgeContext {
  listDocuments(input?: ListKnowledgeDocumentsInput): Promise<WorkflowKnowledgeDocumentPage>;
  getDocument(documentId: string): Promise<WorkflowKnowledgeDocument | undefined>;
  createDocument(input: CreateKnowledgeDocumentInput): Promise<WorkflowKnowledgeDocument>;
  editDocument(input: EditKnowledgeDocumentInput): Promise<WorkflowKnowledgeDocument>;
  deleteDocument(documentId: string): Promise<{ id: string; deleted: boolean }>;
  searchDocuments(input: SearchKnowledgeDocumentsInput): Promise<WorkflowKnowledgeSearchResult>;
  readDocumentLines(input: ReadKnowledgeDocumentLinesInput): Promise<WorkflowKnowledgeDocumentLinesResult>;
}

export interface WorkflowRelatedProjectStorageContext {
  kv: WorkflowKVNamespace;
  knowledge: WorkflowRelatedProjectKnowledgeContext;
  /** The entrypoints of the target this consumer is allowed to call. */
  listEntrypoints(): Promise<WorkflowRelatedProjectEntrypoint[]>;
  /**
   * Calls one of them with the arguments its own input reader parses — the
   * same shape every host uses to start a project, so what a consumer sends is
   * what the target's author already designed for.
   */
  runEntrypoint(entrypointId: string, args?: readonly string[]): Promise<unknown>;
}

export interface WorkflowRelatedProjectsContext {
  get(alias: string): WorkflowRelatedProjectStorageContext;
}

export interface WorkflowRelatedProjectResolverProject {
  projectId: string;
  projectInfo: WorkflowProjectInfo;
  kv: WorkflowKVNamespace;
  persistentValue?: WorkflowKVNamespace;
  runner?: WorkflowRelatedProjectRunner;
}

export function createWorkflowRelatedProjectsContext(
  resolver?: WorkflowRelatedProjectKVResolver,
): WorkflowRelatedProjectsContext {
  const contexts = new Map<string, WorkflowRelatedProjectStorageContext>();
  return {
    get(rawAlias) {
      const alias = normalizeRelatedProjectAlias(rawAlias);
      const existing = contexts.get(alias);
      if (existing !== undefined) return existing;
      const context = Object.freeze({
        kv: createRelatedProjectKVNamespace(alias, resolver),
        knowledge: createRelatedProjectKnowledgeContext(alias, resolver),
        listEntrypoints: () => listRelatedProjectEntrypoints(alias, resolver),
        runEntrypoint: (entrypointId: string, args?: readonly string[]) =>
          runRelatedProjectEntrypoint(alias, resolver, entrypointId, args ?? []),
      });
      contexts.set(alias, context);
      return context;
    },
  };
}

export function createDeclaredWorkflowRelatedProjectKVResolver(options: {
  getConsumerProject():
    | Promise<Omit<WorkflowRelatedProjectResolverProject, "kv">>
    | Omit<WorkflowRelatedProjectResolverProject, "kv">;
  getTargetProject(projectId: string):
    | Promise<WorkflowRelatedProjectResolverProject | undefined>
    | WorkflowRelatedProjectResolverProject
    | undefined;
}): WorkflowRelatedProjectKVResolver {
  return {
    async resolve(alias) {
      const consumer = await options.getConsumerProject();
      const relation = consumer.projectInfo.relatedProjects.find((item) => item.alias === alias);
      if (relation === undefined) return undefined;
      const target = await options.getTargetProject(relation.projectId);
      if (target === undefined || target.projectId.toLowerCase() !== relation.projectId.toLowerCase()) {
        return undefined;
      }
      const access = resolveWorkflowRelatedProjectAccess({
        consumerProjectId: consumer.projectId,
        consumerProjectInfo: consumer.projectInfo,
        targetProjectId: target.projectId,
        targetProjectInfo: target.projectInfo,
        alias,
      });
      return access === undefined
        ? undefined
        : {
            projectId: target.projectId,
            grant: access.grant,
            kv: target.kv,
            ...(target.persistentValue === undefined ? {} : { persistentValue: target.persistentValue }),
            ...(target.runner === undefined ? {} : { runner: target.runner }),
          };
    },
  };
}

function createRelatedProjectKVNamespace(
  alias: string,
  resolver: WorkflowRelatedProjectKVResolver | undefined,
): WorkflowKVNamespace {
  return {
    async getValue(rawKey) {
      const key = normalizeWorkflowKVKey(rawKey);
      const resolved = await resolveRelatedProject(alias, resolver);
      assertRelatedProjectAccess(resolved.grant.read, alias, key, "read");
      return resolved.kv.getValue(key);
    },
    async setValue(rawKey, value) {
      const key = normalizeWorkflowKVKey(rawKey);
      const resolved = await resolveRelatedProject(alias, resolver);
      assertRelatedProjectAccess(resolved.grant.write, alias, key, "write");
      await resolved.kv.setValue(key, value);
    },
    async deleteValue(rawKey) {
      const key = normalizeWorkflowKVKey(rawKey);
      const resolved = await resolveRelatedProject(alias, resolver);
      // Deleting is a mutation of the target project's entry, so it needs the
      // same write grant that writing one does.
      assertRelatedProjectAccess(resolved.grant.write, alias, key, "write");
      return resolved.kv.deleteValue(key);
    },
    async updateValue(rawKey, updater) {
      const key = normalizeWorkflowKVKey(rawKey);
      const resolved = await resolveRelatedProject(alias, resolver);
      assertRelatedProjectAccess(resolved.grant.read, alias, key, "read");
      assertRelatedProjectAccess(resolved.grant.write, alias, key, "write");
      return resolved.kv.updateValue(key, updater);
    },
  };
}

async function resolveRelatedProject(
  alias: string,
  resolver: WorkflowRelatedProjectKVResolver | undefined,
): Promise<WorkflowResolvedRelatedProject> {
  const resolved = await resolver?.resolve(alias);
  if (resolved !== undefined) return resolved;
  throw new WorkflowError({
    type: "input_validation",
    message: `Related project "${alias}" is unavailable or awaiting confirmation.`,
    metadata: { alias, code: "RELATED_PROJECT_UNAVAILABLE" },
  });
}

/**
 * The target's knowledge base, as the helpers this package already ships.
 *
 * Every call resolves the relation again and rebuilds the namespace it writes
 * through. That is not wasted work: the grant is read from both manifests on
 * every access, so a relation that was withdrawn or narrowed between two calls
 * is refused by the second one rather than served from a handle opened before
 * it changed. It is also what lets the namespace mirror the target's store —
 * a local target mutates under a lock, a server target through its mutation
 * executor, and the knowledge helpers pick their path by asking.
 */
function createRelatedProjectKnowledgeContext(
  alias: string,
  resolver: WorkflowRelatedProjectKVResolver | undefined,
): WorkflowRelatedProjectKnowledgeContext {
  // The gate here is only "is this side open at all"; which documents it opens
  // is decided per key below, so a prefix rule that names one document works
  // for reading that document and says which key it was refused on everywhere
  // else. Every document also shares one index key, which is why listing and
  // creating need a rule that covers it and reading a named document does not.
  const open = async (side: "read" | "write"): Promise<WorkflowKnowledgeContext> => {
    const resolved = await resolveRelatedProject(alias, resolver);
    const rule: WorkflowProjectAccessRule | undefined = side === "read"
      ? resolved.grant.knowledge?.read
      : resolved.grant.knowledge?.write;
    // "Cannot reach it here" and "was never granted" are different answers:
    // the first is the host's to fix, the second the manifest's.
    if (resolved.persistentValue === undefined) {
      throw new WorkflowError({
        type: "input_validation",
        message: `Related project "${alias}" knowledge base cannot be reached from here: this host provided no persistent-value store for it.`,
        metadata: { alias, operation: side, code: "RELATED_PROJECT_UNAVAILABLE" },
      });
    }
    if (rule === undefined || rule.mode === "none") {
      throw new WorkflowError({
        type: "input_validation",
        message: `Related project "${alias}" does not share its knowledge base with this project.`,
        metadata: { alias, operation: side, code: "RELATED_PROJECT_KNOWLEDGE_ACCESS_DENIED" },
      });
    }
    return { persistentValue: createRestrictedKnowledgeNamespace(alias, resolved) };
  };

  const openForRead = () => open("read");
  const openForWrite = () => open("write");

  return {
    async listDocuments(input) {
      return listKnowledgeDocumentPage(await openForRead(), input ?? {});
    },
    async getDocument(documentId) {
      return getKnowledgeDocument(await openForRead(), documentId);
    },
    async createDocument(input) {
      return createKnowledgeDocument(await openForWrite(), input);
    },
    async editDocument(input) {
      return editKnowledgeDocument(await openForWrite(), input);
    },
    async deleteDocument(documentId) {
      return deleteKnowledgeDocument(await openForWrite(), documentId);
    },
    async searchDocuments(input) {
      return searchKnowledgeDocuments(await openForRead(), input);
    },
    async readDocumentLines(input) {
      return readKnowledgeDocumentLines(await openForRead(), input);
    },
  };
}

/**
 * The target's persistent values, narrowed to its knowledge documents.
 *
 * The grant is written as `knowledge`, so the knowledge key space is all it
 * opens: the target's other persistent values — its schedules, its drafts,
 * whatever else it keeps — stay where they were. The namespace mirrors the
 * target's store rather than substituting for it, because the knowledge
 * helpers choose between a namespace lock and a mutation executor by asking
 * which one exists, and answering that wrongly turns a working target into a
 * failing one.
 */
function createRestrictedKnowledgeNamespace(
  alias: string,
  resolved: WorkflowResolvedRelatedProject,
): WorkflowKVNamespace {
  const persistentValue = resolved.persistentValue!;
  const assertAccess = (key: string, operation: "read" | "write"): void => {
    const rule = operation === "read" ? resolved.grant.knowledge?.read : resolved.grant.knowledge?.write;
    if (isKnowledgeDocumentStorageKey(key) && isWorkflowProjectAccessAllowed(rule, key)) return;
    throw new WorkflowError({
      type: "input_validation",
      message: `Related project "${alias}" does not grant ${operation} access to this knowledge document.`,
      metadata: { alias, operation, key, code: "RELATED_PROJECT_KNOWLEDGE_ACCESS_DENIED" },
    });
  };

  const namespace: WorkflowKVNamespace = {
    async getValue(rawKey) {
      const key = normalizeWorkflowKVKey(rawKey);
      assertAccess(key, "read");
      return persistentValue.getValue(key);
    },
    async setValue(rawKey, value) {
      const key = normalizeWorkflowKVKey(rawKey);
      assertAccess(key, "write");
      await persistentValue.setValue(key, value);
    },
    async deleteValue(rawKey) {
      const key = normalizeWorkflowKVKey(rawKey);
      assertAccess(key, "write");
      return persistentValue.deleteValue(key);
    },
    async updateValue(rawKey, updater) {
      const key = normalizeWorkflowKVKey(rawKey);
      assertAccess(key, "read");
      assertAccess(key, "write");
      return persistentValue.updateValue(key, updater);
    },
  };

  // The namespace mirrors the target's store rather than substituting for it:
  // the knowledge helpers choose between a namespace lock and a mutation
  // executor by asking which exists, so a view that claims one it cannot take
  // turns a working target into a failing one. Every method here is only
  // reachable through `open`, which has already checked the grant.
  if (persistentValue.withLock !== undefined) {
    namespace.withLock = <T>(operation: () => Promise<T> | T): Promise<T> =>
      persistentValue.withLock!<T>(operation);
  }
  if (persistentValue.withReadLock !== undefined) {
    namespace.withReadLock = <T>(operation: () => Promise<T> | T): Promise<T> =>
      persistentValue.withReadLock!<T>(operation);
  }
  if (persistentValue.executeMutation !== undefined) {
    namespace.executeMutation = <T>(mutation: WorkflowKVNamespaceMutation): Promise<T> => {
      // The store runs this one whole, index writes included, so `assertAccess`
      // never sees the keys it touches. Check the ones it declares first: they
      // are the same keys the lock route checks one call at a time, and a
      // mutation that will not name them is refused rather than trusted.
      const keys = describeKnowledgeMutationKeys(mutation);
      if (keys === undefined) {
        throw new WorkflowError({
          type: "input_validation",
          message: `Related project "${alias}" only applies knowledge mutations whose documents it can name.`,
          metadata: {
            alias,
            mutationType: mutation.type,
            code: "RELATED_PROJECT_KNOWLEDGE_MUTATION_DENIED",
          },
        });
      }
      for (const key of keys.read) assertAccess(key, "read");
      for (const key of keys.write) assertAccess(key, "write");
      return persistentValue.executeMutation!<T>(mutation);
    };
  }

  return namespace;
}

async function listRelatedProjectEntrypoints(
  alias: string,
  resolver: WorkflowRelatedProjectKVResolver | undefined,
): Promise<WorkflowRelatedProjectEntrypoint[]> {
  const resolved = await resolveRelatedProject(alias, resolver);
  const runner = requireRelatedProjectRunner(alias, resolved);
  const entrypoints = await runner.listEntrypoints();
  // Only what the grant covers: a list that includes calls which would be
  // refused reads as "you may call these", and the model acts on that.
  return entrypoints.filter((entrypoint) =>
    isWorkflowProjectAccessAllowed(resolved.grant.entrypoints, entrypoint.id));
}

async function runRelatedProjectEntrypoint(
  alias: string,
  resolver: WorkflowRelatedProjectKVResolver | undefined,
  rawEntrypointId: string,
  args: readonly string[],
): Promise<unknown> {
  const entrypointId = normalizeRelatedProjectEntrypointId(rawEntrypointId);
  const resolved = await resolveRelatedProject(alias, resolver);
  if (!isWorkflowProjectAccessAllowed(resolved.grant.entrypoints, entrypointId)) {
    throw new WorkflowError({
      type: "input_validation",
      message: `Related project "${alias}" does not grant this project access to entrypoint "${entrypointId}".`,
      metadata: { alias, entrypointId, code: "RELATED_PROJECT_ENTRYPOINT_ACCESS_DENIED" },
    });
  }
  return requireRelatedProjectRunner(alias, resolved).run(entrypointId, args);
}

function requireRelatedProjectRunner(
  alias: string,
  resolved: WorkflowResolvedRelatedProject,
): WorkflowRelatedProjectRunner {
  if (resolved.runner !== undefined) return resolved.runner;
  throw new WorkflowError({
    type: "input_validation",
    message: `Related project "${alias}" cannot be run from here.`,
    metadata: { alias, code: "RELATED_PROJECT_UNAVAILABLE" },
  });
}

function normalizeRelatedProjectEntrypointId(value: string): string {
  const entrypointId = value.trim();
  if (entrypointId === "") {
    throw new WorkflowError({
      type: "input_validation",
      message: "Related project entrypoint id must be a non-empty string.",
    });
  }
  return entrypointId;
}

function assertRelatedProjectAccess(
  rule: WorkflowProjectAccessRule,
  alias: string,
  key: string,
  operation: "read" | "write",
): void {
  if (isWorkflowProjectAccessAllowed(rule, key)) return;
  throw new WorkflowError({
    type: "input_validation",
    message: `Related project "${alias}" does not grant ${operation} access to this KV key.`,
    metadata: { alias, operation, code: "RELATED_PROJECT_KV_ACCESS_DENIED" },
  });
}

function normalizeRelatedProjectAlias(value: string): string {
  const alias = value.trim();
  if (!STEAMHARNESS_RELATED_PROJECT_ALIAS_PATTERN.test(alias)) {
    throw new WorkflowError({
      type: "input_validation",
      message: "Related project alias is invalid.",
    });
  }
  return alias;
}
