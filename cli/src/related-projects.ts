import os from "node:os";
import path from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import * as steamHarness from "steamharness";
import {
  STEAMHARNESS_RELATED_PROJECT_ALIAS_PATTERN,
  isWorkflowProjectDataStorageLocationAllowed,
  readWorkflowProjectInfo,
  resolveWorkflowRelatedProjectAccess,
  type WorkflowProjectDataStorageLocation,
  type WorkflowProjectInfo,
  type WorkflowRelatedProjectKVGrant,
} from "@steamharness/project-info";
import { assertWorkflowUuid } from "@steamharness/workflow-ids";

export interface CliRelatedProjectSpec {
  alias: string;
  projectDir: string;
}

export interface CliRelatedProjectRuntime {
  localKvStore?: CliWorkflowKVStore;
  localResolver?: CliWorkflowRelatedProjectKVResolver;
  serverResolver?: CliWorkflowRelatedProjectKVResolver;
}

export interface CliWorkflowKVStore {
  getValue(input: CliWorkflowKVStoreInput): Promise<unknown | undefined>;
  setValue(input: CliWorkflowKVStoreInput & { value: unknown }): Promise<void>;
}

interface CliWorkflowKVStoreInput {
  storageKind: "kv" | "persistent_value";
  scope: "project" | "conversation";
  projectId: string;
  conversationId?: string;
  key: string;
}

interface CliWorkflowKVNamespace {
  getValue(key: string): Promise<unknown | undefined>;
  setValue(key: string, value: unknown): Promise<void>;
  updateValue<T>(key: string, updater: (current: unknown | undefined) => T | Promise<T>): Promise<T>;
}

interface CliWorkflowResolvedRelatedProjectKV {
  projectId: string;
  grant: WorkflowRelatedProjectKVGrant;
  kv: CliWorkflowKVNamespace;
  persistentValue?: CliWorkflowKVNamespace;
  runner?: CliWorkflowRelatedProjectRunner;
}

/**
 * Runs one of the target project's entrypoints in this process.
 *
 * The target is loaded from its own directory and run as itself: the storage
 * handed to it is its own, and no related-project resolver travels into it, so
 * a relation stays direct — the project this call reaches cannot reach a third
 * one through itself.
 */
export interface CliWorkflowRelatedProjectRunner {
  listEntrypoints(): Promise<Array<{ id: string; title?: string; description?: string }>>;
  run(entrypointId: string, args: readonly string[]): Promise<unknown>;
}

export interface CliWorkflowRelatedProjectKVResolver {
  resolve(alias: string): CliWorkflowResolvedRelatedProjectKV | undefined;
}

interface TargetSteamHarnessStorageApi {
  createLocalWorkflowKVStore(options: {
    rootDir: string;
    storageKind: "kv" | "persistent_value";
  }): CliWorkflowKVStore;
  createRemoteWorkflowRelatedProjectKVStoreFromEnv(options: {
    consumerProjectId: string;
    targetProjectId: string;
    alias: string;
    env?: NodeJS.ProcessEnv;
  }): CliWorkflowKVStore | undefined;
  createWorkflowKVContext(options: {
    store: CliWorkflowKVStore;
    projectId: string;
    source?: { projectId?: string; runId?: string; conversationId?: string };
  }): CliWorkflowKVNamespace;
  createWorkflowPersistentValueContext?(options: {
    store: CliWorkflowKVStore;
    projectId: string;
    source?: { projectId?: string; runId?: string; conversationId?: string };
  }): CliWorkflowKVNamespace;
  inspectLocalWorkflowStructure?(options: {
    workflowDir?: string;
    workflowName?: string;
  }): { entrypoints?: Array<{ id: string; title?: string; description?: string }> };
  readEntrypointOutput?(data: unknown): unknown;
  runLocalWorkflowWithReport?(options: {
    workflowDir?: string;
    workflowName?: string;
    entrypointId?: string;
    args?: string[];
    storage?: unknown;
  }): Promise<{
    status: string;
    result?: { ok?: boolean; data?: unknown; error?: unknown };
  }>;
}

const defaultStorageApi = steamHarness as unknown as TargetSteamHarnessStorageApi;

interface ProjectSnapshot {
  projectDir: string;
  projectId: string;
  projectInfo: WorkflowProjectInfo;
}

export function parseCliRelatedProjectSpec(value: string): CliRelatedProjectSpec {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error('--related-project must use the form "alias=/absolute/project/path".');
  }
  const alias = value.slice(0, separatorIndex).trim();
  const projectDir = value.slice(separatorIndex + 1).trim();
  if (!STEAMHARNESS_RELATED_PROJECT_ALIAS_PATTERN.test(alias)) {
    throw new Error(`Invalid related project alias "${alias}".`);
  }
  if (!path.isAbsolute(projectDir)) {
    throw new Error(`Related project "${alias}" must use an absolute directory path.`);
  }
  return { alias, projectDir };
}

export function createCliRelatedProjectRuntime(options: {
  consumerProjectDir: string;
  relatedProjects: readonly CliRelatedProjectSpec[];
  localKvStoreDir?: string;
  localPersistentValueStoreDir?: string;
  runId?: string;
  conversationId?: string;
  env?: NodeJS.ProcessEnv;
  storageApi?: TargetSteamHarnessStorageApi;
  localStorageForProject?: (projectDir: string) => { kvStoreDir: string; persistentValueStoreDir?: string };
}): CliRelatedProjectRuntime {
  if (options.relatedProjects.length === 0) return {};
  const targetStorageApi = options.storageApi ?? defaultStorageApi;

  const consumer = readProjectSnapshot(options.consumerProjectDir, "Current project");
  const configuredByAlias = new Map<string, ProjectSnapshot>();
  const configuredProjectIds = new Set<string>();
  const configuredPaths = new Set<string>();

  for (const spec of options.relatedProjects) {
    if (configuredByAlias.has(spec.alias)) {
      throw new Error(`Related project alias "${spec.alias}" was specified more than once.`);
    }
    const target = readProjectSnapshot(spec.projectDir, `Related project "${spec.alias}"`);
    const targetProjectId = target.projectId.toLowerCase();
    if (configuredProjectIds.has(targetProjectId)) {
      throw new Error(`Related project UUID "${target.projectId}" was specified more than once.`);
    }
    if (configuredPaths.has(target.projectDir)) {
      throw new Error(`Related project directory "${target.projectDir}" was specified more than once.`);
    }
    assertConfirmedRelationship(consumer, target, spec.alias);
    configuredByAlias.set(spec.alias, target);
    configuredProjectIds.add(targetProjectId);
    configuredPaths.add(target.projectDir);
  }

  // The roots are settled once, here, and both the relation and the target's
  // own child run are given these values: a local relation whose store sat
  // somewhere else than the run's would read and write a knowledge base the
  // target itself never sees. KV keeps the shared temp root Core defaults to;
  // persistent values have no such default — that is where a project's
  // knowledge lives — so without a configured root this run simply has none,
  // and the relation reports Knowledge as unavailable rather than inventing one.
  const localKvStoreDir = options.localKvStoreDir ?? path.join(os.tmpdir(), "steamharness-kv");
  const localPersistentValueStoreDir = options.localPersistentValueStoreDir;
  const localKvStore = targetStorageApi.createLocalWorkflowKVStore({
    rootDir: localKvStoreDir,
    storageKind: "kv",
  });
  const localPersistentValueStore =
    typeof targetStorageApi.createWorkflowPersistentValueContext === "function"
      && localPersistentValueStoreDir !== undefined
      ? targetStorageApi.createLocalWorkflowKVStore({
          rootDir: localPersistentValueStoreDir,
          storageKind: "persistent_value",
        })
      : undefined;

  return {
    localKvStore,
    localResolver: createResolver("local", localKvStore, localPersistentValueStore),
    serverResolver: createResolver("server"),
  };

  function createResolver(
    location: WorkflowProjectDataStorageLocation,
    fixedStore?: CliWorkflowKVStore,
    fixedPersistentValueStore?: CliWorkflowKVStore,
  ): CliWorkflowRelatedProjectKVResolver {
    return {
      resolve(alias) {
        const configured = configuredByAlias.get(alias);
        if (configured === undefined) return undefined;

        const currentConsumer = readProjectSnapshot(consumer.projectDir, "Current project");
        const currentTarget = readProjectSnapshot(
          configured.projectDir,
          `Related project "${alias}"`,
        );
        if (currentConsumer.projectId.toLowerCase() !== consumer.projectId.toLowerCase()
          || currentTarget.projectId.toLowerCase() !== configured.projectId.toLowerCase()) {
          return undefined;
        }
        const access = resolveWorkflowRelatedProjectAccess({
          consumerProjectId: currentConsumer.projectId,
          consumerProjectInfo: currentConsumer.projectInfo,
          targetProjectId: currentTarget.projectId,
          targetProjectInfo: currentTarget.projectInfo,
          alias,
        });
        if (
          access === undefined ||
          !isWorkflowProjectDataStorageLocationAllowed(currentTarget.projectInfo, location)
        ) {
          return undefined;
        }

        const createRemoteStore = targetStorageApi.createRemoteWorkflowRelatedProjectKVStoreFromEnv;
        if (fixedStore === undefined && typeof createRemoteStore !== "function") {
          throw new Error("Installed steamharness does not support related project storage.");
        }
        const roots = options.localStorageForProject?.(currentTarget.projectDir)
          ?? { kvStoreDir: localKvStoreDir, persistentValueStoreDir: localPersistentValueStoreDir };
        const store = location === "local" && options.localStorageForProject
          ? targetStorageApi.createLocalWorkflowKVStore({ rootDir: roots.kvStoreDir, storageKind: "kv" })
          : fixedStore ?? createRemoteStore({
          consumerProjectId: currentConsumer.projectId,
          targetProjectId: currentTarget.projectId,
          alias,
          env: options.env,
        });
        if (store === undefined) return undefined;

        const source = {
          projectId: currentConsumer.projectId,
          runId: options.runId,
          conversationId: options.conversationId,
        };
        const persistentStore = location === "server" ? store
          : options.localStorageForProject && roots.persistentValueStoreDir !== undefined
            ? targetStorageApi.createLocalWorkflowKVStore({ rootDir: roots.persistentValueStoreDir, storageKind: "persistent_value" })
            : fixedPersistentValueStore;
        const persistentValue = persistentStore === undefined
          ? undefined
          : targetStorageApi.createWorkflowPersistentValueContext?.({
              store: persistentStore,
              projectId: currentTarget.projectId,
              source,
            });
        const runner = createLocalProjectRunner({
          projectDir: currentTarget.projectDir,
          // Related entrypoints execute locally and use the selected data store.
          location,
          // The roots settled above, not the raw options: the relation and the
          // target's own run have to land on the same store, defaults
          // included, or one side writes what the other cannot see.
          kvStoreDir: roots.kvStoreDir,
          persistentValueStoreDir: roots.persistentValueStoreDir,
          storageApi: targetStorageApi,
        });

        return {
          projectId: currentTarget.projectId,
          grant: access.grant,
          kv: targetStorageApi.createWorkflowKVContext({
            store,
            projectId: currentTarget.projectId,
            source,
          }),
          ...(persistentValue === undefined ? {} : { persistentValue }),
          ...(runner === undefined ? {} : { runner }),
        };
      },
    };
  }
}

/**
 * Runs the target project from its own directory, as itself.
 *
 * Both halves are the installed Core's own entry points — the same ones a
 * `steamharness run` in that directory would use — so an entrypoint called
 * this way sees exactly what it sees when its author runs it, and its data
 * lands in the same place. The child run carries no related-project resolver,
 * which is what keeps a relation direct.
 */
function createLocalProjectRunner(options: {
  projectDir: string;
  /** Where the target project keeps its data, which is where its run reads and writes. */
  location: WorkflowProjectDataStorageLocation;
  kvStoreDir?: string;
  persistentValueStoreDir?: string;
  storageApi: TargetSteamHarnessStorageApi;
}): CliWorkflowRelatedProjectRunner | undefined {
  const projectDir = options.projectDir;
  const targetStorageApi = options.storageApi;
  const inspect = targetStorageApi.inspectLocalWorkflowStructure;
  const run = targetStorageApi.runLocalWorkflowWithReport;
  // The unwrapper is what makes the answer a payload rather than this
  // package's node envelope, so an installed Core without it is no runner at
  // all — better no entrypoint runner than one that answers in the wrong shape.
  const unwrap = targetStorageApi.readEntrypointOutput;
  if (typeof inspect !== "function" || typeof run !== "function" || typeof unwrap !== "function") {
    return undefined;
  }

  return {
    async listEntrypoints() {
      const structure = inspect({ workflowDir: projectDir });
      return (structure.entrypoints ?? []).map((entrypoint) => ({
        id: entrypoint.id,
        ...(entrypoint.title === undefined ? {} : { title: entrypoint.title }),
        ...(entrypoint.description === undefined ? {} : { description: entrypoint.description }),
      }));
    },
    async run(entrypointId, args) {
      // The target runs here, on its own storage: a project that declares
      // `server` storage keeps reading and writing the server, which is what
      // makes calling its entrypoints the same thing as running it itself.
      const report = await run({
        workflowDir: projectDir,
        entrypointId,
        args: [...args],
        storage: options.location === "server"
          ? { host: "server" }
          : {
              host: "local",
              local: {
                kvStoreDir: options.kvStoreDir,
                persistentValueStoreDir: options.persistentValueStoreDir,
              },
            },
      });
      // The payload, not this package's envelope around it: what a caller asked
      // another project to do is the answer it wants back. A failed entrypoint
      // is reported by the envelope, which the unwrapper raises as its own
      // error — carrying the target's own message rather than a `null` the
      // caller cannot tell from an empty answer.
      if (report.result === undefined) {
        throw new Error(`Related project entrypoint "${entrypointId}" returned no result.`);
      }
      return unwrap(report.result.data);
    },
  };
}

function assertConfirmedRelationship(
  consumer: ProjectSnapshot,
  target: ProjectSnapshot,
  alias: string,
): void {
  const consumerRelation = consumer.projectInfo.relatedProjects.find(
    (relation) => relation.alias === alias,
  );
  if (consumerRelation?.projectId.toLowerCase() !== target.projectId.toLowerCase()) {
    throw new Error(
      `Current project does not declare related project "${alias}" with UUID "${target.projectId}".`,
    );
  }
  if (resolveWorkflowRelatedProjectAccess({
    consumerProjectId: consumer.projectId,
    consumerProjectInfo: consumer.projectInfo,
    targetProjectId: target.projectId,
    targetProjectInfo: target.projectInfo,
    alias,
  }) === undefined) {
    throw new Error(`Related project "${alias}" is not confirmed by both project manifests.`);
  }
}

function readProjectSnapshot(projectDir: string, label: string): ProjectSnapshot {
  let canonicalDir: string;
  try {
    canonicalDir = realpathSync(projectDir);
    if (!statSync(canonicalDir).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    throw new Error(`${label} directory is unavailable: ${projectDir}`, { cause: error });
  }

  const packagePath = path.join(canonicalDir, "package.json");
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} must contain a readable package.json: ${canonicalDir}`, {
      cause: error,
    });
  }
  if (!isRecord(packageJson) || typeof packageJson["id"] !== "string") {
    throw new Error(`${label} package.json.id must be a UUID.`);
  }
  const projectId = assertWorkflowUuid(packageJson["id"], `${label} package.json.id`);
  const projectInfo = readWorkflowProjectInfo(packageJson);
  if (projectInfo.dataStorage === null) {
    throw new Error(`${label} must declare steamHarness.projectInfo.dataStorage.mode.`);
  }
  return { projectDir: canonicalDir, projectId, projectInfo };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
