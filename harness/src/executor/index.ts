import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createWorkflowFailure,
  safeRunWorkflow,
  runNode,
  runStreamNode,
  HarnessError,
  type RunResult,
} from "../workflow/index";
import type {
  NodeExecutionHooks,
  NodeDefinition,
  ProviderRegistry,
  StreamNodeDefinition,
  RunContext,
  StorageContext,
  StorageLocationContext,
  Definition,
  NodeMetadata,
  UserInputContext,
} from "../types/index";
import {
  assertWorkflowProjectDataStorageLocationAllowed,
  readWorkflowProjectInfo,
  type ProjectDataStorageLocation,
  type ProjectInfoContract,
} from "@steamharness/project-info";
import { loadWorkflowEnv } from "./env";
import {
  combineNodeExecutionHooks,
  createNodeExecutionReporter,
  createWorkflowExecutionReport,
  resolveWorkflowResultStatus,
  type DefinitionEvent,
  type ExecutionReport,
  type RuntimeEvent,
  type StructureReport,
} from "./report";
import {
  formatWorkflowExecutionJson,
} from "./format";
import {
  inspectWorkflowScripts,
  inspectWorkflowStructure,
  type DefinedNode,
} from "./rules";
import { parseWorkflowParamValues, validateWorkflowParamResolveResult } from "./params";
import { STEAMHARNESS_ENTRYPOINT_ID_PATTERN } from "./definition";
import { assertWorkflowParamDeclarations, normalizeWorkflowParamDeclarations } from "./param-definition";
import { assertConversationFooter } from "./conversation-footer";
import { assertConversationUserInput } from "./conversation-input";
import { assertConversationCommands } from "./conversation-commands";
import type {
  NodeRegistryEntry,
  NodeRegistryItem,
  ExecutorContext,
  ExecutorDefinition,
  ExecutorModule,
  ExecutionDefinition,
  EntrypointDefinition,
  EntrypointGroupDefinition,
  ParamResolveRequest,
  ParamResolveResult,
} from "./types";
import {
  createAbortedWorkflowResult,
  createExecutionLimitLayer,
  createWorkflowRunId,
  createWorkflowRuntime,
  type Runtime,
  type RuntimeLayer,
} from "./runtime";
import { isOutputItemStreamChunk } from "../node/output/index";
import { installWorkflowRuntimeGlobal } from "../runtime-api";
import {
  createLocalWorkflowFileStore,
  createServerWorkflowFileStore,
  createWorkflowFileStore,
  type FileStore,
} from "../files/index";
import { createRemoteWorkflowFileStoreFromEnv } from "../files/remote";
import { createWorkflowNodeMetadata } from "../types/index";
import {
  createDisabledWorkflowConversationContext,
  createWorkflowConversationContext,
  type ConversationContext,
} from "../conversation/index";
import {
  createLocalWorkflowKVStore,
  createWorkflowPersistentValueContext,
  createWorkflowKVContext,
  type KVContext,
  type KVStore,
  type PersistentValueContext,
} from "../kv/index";
import { createRemoteWorkflowStorageStoreFromEnv } from "../kv/remote";
import {
  createWorkflowRelatedProjectsContext,
  type RelatedProjectKVResolver,
} from "../kv/related-projects";
import {
  createWorkflowTokenUsageContext,
  type TokenUsageContext,
} from "../token-usage/index";
import {
  createWorkflowTimerContext,
} from "../timer/index";
import {
  createWorkflowToolPermissionContext,
  type ToolPermissionPolicyMap,
} from "../tool-permissions/index";
import {
  STEAMHARNESS_PROJECT_TYPE_MIGRATION_EXAMPLE,
  assertNeverWorkflowExecutorProjectType,
  isWorkflowExecutorProjectType,
  type ExecutorProjectType,
  type ProjectKind,
} from "../project-types";
import {
  KANBAN_MANIFEST_FILE,
  createKanbanArtifactEntryPath,
  createKanbanExecutionUnsupportedMessage,
  parseKanbanManifestText,
  readKanbanArtifactConfig,
  readPackageProjectType,
} from "@steamharness/kanban-project";
import {
  parseWorkflowSchedulePresets,
  validateWorkflowScheduleParamValues,
  type SchedulePreset,
} from "@steamharness/workflow-schedules";

export interface RunWorkspaceWorkflowOptions {
  cwd?: string;
  workflowName: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  providers?: ProviderRegistry;
  nodeHooks?: NodeExecutionHooks;
  abortSignal?: AbortSignal;
  hostInput?: unknown;
  timeoutMs?: number;
  maxNodeExecutions?: number;
  runId?: string;
  entrypointId?: string;
  conversationId?: string;
  storage?: ExecutionStorageOptions;
  fileStore?: FileStore;
  fileStoreDir?: string;
  fileCreateStoreDir?: string;
  layers?: RuntimeLayer[];
  userInput?: UserInputContext;
  toolPermissionPolicies?: ToolPermissionPolicyMap;
  onRuntimeEvent?(event: RuntimeEvent): Promise<void> | void;
  onDefinedNodes?(event: DefinitionEvent): Promise<void> | void;
}

export interface RunLocalWorkflowOptions {
  workflowDir?: string;
  workflowName?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  providers?: ProviderRegistry;
  nodeHooks?: NodeExecutionHooks;
  abortSignal?: AbortSignal;
  hostInput?: unknown;
  runId?: string;
  entrypointId?: string;
  conversationId?: string;
  storage?: ExecutionStorageOptions;
  fileStore?: FileStore;
  fileStoreDir?: string;
  fileCreateStoreDir?: string;
  userInput?: UserInputContext;
  toolPermissionPolicies?: ToolPermissionPolicyMap;
  onRuntimeEvent?(event: RuntimeEvent): Promise<void> | void;
  onDefinedNodes?(event: DefinitionEvent): Promise<void> | void;
}

export interface ExecutionStorageBackendOptions {
  /** Persistent, private directory for agent Harness databases and ownership locks. */
  agentStoreDir?: string;
  kvStore?: KVStore;
  kvStoreDir?: string;
  persistentValueStore?: KVStore;
  persistentValueStoreDir?: string;
  relatedProjectResolver?: RelatedProjectKVResolver;
}

export interface ExecutionStorageOptions {
  host: ProjectDataStorageLocation;
  local?: ExecutionStorageBackendOptions;
  server?: ExecutionStorageBackendOptions;
}

interface ProjectStorageDeclaration {
  projectId: string;
  projectInfo: ProjectInfoContract;
}

interface ExecutorStorageContexts {
  storage: StorageContext;
  host: StorageLocationContext;
}

const STEAMHARNESS_PROJECT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID = "__workflowResumeRuntimeEventAfterRequestId";

type UserInputContextWithResumeBarrier = UserInputContext & {
  [RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID]?: string;
};

export async function runWorkspaceWorkflow(
  options: RunWorkspaceWorkflowOptions,
): Promise<RunResult<unknown>> {
  const report = await runWorkspaceWorkflowWithReport(options);

  return report.result;
}

export async function runWorkspaceWorkflowWithReport(
  options: RunWorkspaceWorkflowOptions,
): Promise<ExecutionReport<unknown>> {
  const cwd = options.cwd ?? process.cwd();
  const args = options.args ?? [];
  const env = options.env ?? process.env;
  const onRuntimeEvent = createResumeAwareRuntimeEventHandler(
    options.onRuntimeEvent,
    readResumeRuntimeEventAfterRequestId(options.userInput),
  );
  const runtime = createWorkflowRuntime({
    runId: options.runId,
    workflowName: options.workflowName,
    onRuntimeEvent,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    nodeHooks: options.nodeHooks,
    layers: [
      createExecutionLimitLayer({ maxNodeExecutions: options.maxNodeExecutions }),
      ...(options.layers ?? []),
    ],
  });
  let definedNodes: DefinedNode[] = [];
  let registry: NodeRegistryItem[] = [];
  let workflowDir = "";
  let activeEntrypointId: string | undefined;
  let activeEntrypointTitle: string | undefined;
  let activeConversationId: string | undefined;
  let tokenUsage: TokenUsageContext | undefined;
  let result: RunResult<unknown>;

  try {
    await runtime.prepare();
    runtime.throwIfAborted();
    const location = resolveWorkflowLocation(cwd, options.workflowName);
    workflowDir = location.workflowDir;
    const { modulePath } = location;
    const projectStorageDeclaration = readWorkflowProjectStorageDeclaration(workflowDir);

    const scriptInspection = inspectWorkflowScripts({
      cwd,
      workflowName: options.workflowName,
      workflowDir,
    });
    definedNodes = scriptInspection.definedNodes;

    await options.onDefinedNodes?.({
      workflowName: options.workflowName,
      workflowDir,
      nodes: definedNodes,
    });

    if (scriptInspection.violations.length > 0) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow "${options.workflowName}" script validation failed.`,
        metadata: {
          workflow: options.workflowName,
          violations: scriptInspection.violations,
        },
      });
    }

    runtime.throwIfAborted();
    loadWorkflowEnv(path.join(workflowDir, ".env"));
    assertWorkflowProjectStorageHostAvailable({
      declaration: projectStorageDeclaration,
      env,
      workflowName: options.workflowName,
      options: options.storage,
    });

    installWorkflowRuntimeGlobal();
    const module = await import(pathToFileURL(modulePath).href);
    const definition = resolveExecutorDefinition(
      module as ExecutorModule,
      options.workflowName,
    );
    const selected = resolveExecutorExecution(
      definition,
      options.entrypointId,
      options.workflowName,
    );
    const execution = selected.execution;
    activeEntrypointId = selected.entrypointId;
    activeEntrypointTitle = selected.entrypointTitle;
    await runtime.start({ id: selected.entrypointId, title: selected.entrypointTitle });
    const executorContext: ExecutorContext = {
      workflowName: options.workflowName,
      workflowDir,
      entrypointId: selected.entrypointId,
      entrypointTitle: selected.entrypointTitle,
      args,
      paramValues: parseWorkflowParamValues(execution.params, args),
      env,
      abortSignal: runtime.abortSignal,
      hostInput: options.hostInput,
      conversationId: options.conversationId,
      toolPermissionPolicies: options.toolPermissionPolicies,
    };
    runtime.throwIfAborted();
    const input = await execution.createInput(executorContext);
    const extraContext = execution.createContext
      ? await execution.createContext(executorContext)
      : {};
    registry = resolveWorkflowNodeRegistry(execution.registry, executorContext);
    const resolvedConversationId = resolveExecutorConversationId(
      definition,
      options.conversationId,
      readInputConversationId(input),
    );
    const executorStorage = createExecutorStorageContexts({
      declaration: projectStorageDeclaration,
      env,
      workflowName: options.workflowName,
      runId: runtime.runId,
      conversationId: resolvedConversationId,
      options: options.storage,
    });
    const kv = executorStorage.host.kv;
    const conversation = createExecutorConversationContext({
      definition,
      workflowName: options.workflowName,
      conversationId: resolvedConversationId,
      kv,
      onTitleChange: (event) =>
        runtime.emitConversationTitleUpdated({
          conversationId: event.conversationId,
          title: event.title,
          updatedAt: new Date(event.updatedAt),
        }),
    });
    activeConversationId = conversation.conversationId;
    tokenUsage = createWorkflowTokenUsageContext({
      definition: execution.tokenUsage,
      kv,
      projectId: projectStorageDeclaration.projectId,
      runId: runtime.runId,
      conversationId: conversation.conversationId,
      onUpdate: (usage) =>
        runtime.emitTokenUsageUpdated({
          conversationId: conversation.conversationId,
          usage,
          updatedAt: new Date(usage.updatedAt ?? new Date().toISOString()),
        }),
    });
    const userInput = createExecutorUserInputContext({
      workflowName: options.workflowName,
      runtime,
      userInput: options.userInput,
    });
    const context: RunContext = {
      ...extraContext,
      providers: mergeProviderRegistries(extraContext.providers, options.providers),
      storage: executorStorage.storage,
      conversation,
      tokenUsage,
      userInput,
      toolPermissions: createWorkflowToolPermissionContext({
        definitions: execution.tools,
        policies: options.toolPermissionPolicies,
        userInput,
        workflowName: options.workflowName,
        runId: runtime.runId,
      }),
      timers: runtime.timers,
      files: createExecutorFileStore({
        env,
        workflowName: options.workflowName,
        conversationId: conversation.conversationId,
        fileStore: options.fileStore,
        fileStoreDir: options.fileStoreDir,
        fileCreateStoreDir: options.fileCreateStoreDir,
      }),
      metadata: {
        workflow: options.workflowName,
        runId: runtime.runId,
        conversationId: conversation.conversationId,
        ...extraContext.metadata,
        ...(selected.entrypointId === undefined
          ? {}
          : {
              entrypointId: selected.entrypointId,
              entrypointTitle: selected.entrypointTitle,
            }),
      },
      abortSignal: runtime.abortSignal,
      nodeHooks: combineNodeExecutionHooks(
        runtime.runtimeNodeHooks,
        extraContext.nodeHooks,
      ),
    };

    runtime.throwIfAborted();
    result = await safeRunWorkflow(execution.workflow, input, context);
  } catch (error) {
    await runtime.start({ id: activeEntrypointId, title: activeEntrypointTitle });
    const diagnosedError = diagnoseModuleImportError(error, workflowDir, options.workflowName) ?? error;
    result = runtime.abortSignal.aborted
      ? createAbortedWorkflowResult(runtime.abortSignal, options.workflowName)
      : createWorkflowFailure(diagnosedError);
  }

  return runtime.finish({
    definedNodes,
    registry,
    entrypointId: activeEntrypointId,
    entrypointTitle: activeEntrypointTitle,
    conversationId:
      activeConversationId ?? readReportConversationId(options.conversationId, result),
    tokenUsage: createReportTokenUsage(tokenUsage),
    result,
  });
}

export async function debugWorkspaceWorkflowNodeWithReport(
  options: RunWorkspaceWorkflowOptions & {
    nodeName: string;
  },
): Promise<ExecutionReport<unknown>> {
  const cwd = options.cwd ?? process.cwd();
  const args = options.args ?? [];
  const env = options.env ?? process.env;
  const runtime = createWorkflowRuntime({
    runId: options.runId,
    workflowName: options.workflowName,
    onRuntimeEvent: options.onRuntimeEvent,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    nodeHooks: options.nodeHooks,
    layers: [
      createExecutionLimitLayer({ maxNodeExecutions: options.maxNodeExecutions }),
      ...(options.layers ?? []),
    ],
  });
  let definedNodes: DefinedNode[] = [];
  let registry: NodeRegistryItem[] = [];
  let workflowDir = "";
  let activeEntrypointId: string | undefined;
  let activeEntrypointTitle: string | undefined;
  let activeConversationId: string | undefined;
  let tokenUsage: TokenUsageContext | undefined;
  let result: RunResult<unknown>;

  try {
    await runtime.prepare();
    runtime.throwIfAborted();
    const location = resolveWorkflowLocation(cwd, options.workflowName);
    workflowDir = location.workflowDir;
    const { modulePath } = location;
    const projectStorageDeclaration = readWorkflowProjectStorageDeclaration(workflowDir);

    const scriptInspection = inspectWorkflowScripts({
      cwd,
      workflowName: options.workflowName,
      workflowDir,
    });
    definedNodes = scriptInspection.definedNodes;

    if (scriptInspection.violations.length > 0) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow "${options.workflowName}" script validation failed.`,
        metadata: {
          workflow: options.workflowName,
          violations: scriptInspection.violations,
        },
      });
    }

    runtime.throwIfAborted();
    loadWorkflowEnv(path.join(workflowDir, ".env"));
    assertWorkflowProjectStorageHostAvailable({
      declaration: projectStorageDeclaration,
      env,
      workflowName: options.workflowName,
      options: options.storage,
    });

    installWorkflowRuntimeGlobal();
    const module = await import(pathToFileURL(modulePath).href);
    const definition = resolveExecutorDefinition(
      module as ExecutorModule,
      options.workflowName,
    );
    const selected = resolveExecutorExecution(
      definition,
      options.entrypointId,
      options.workflowName,
    );
    const execution = selected.execution;
    activeEntrypointId = selected.entrypointId;
    activeEntrypointTitle = selected.entrypointTitle;
    await runtime.start({ id: selected.entrypointId, title: selected.entrypointTitle });
    const executorContext: ExecutorContext = {
      workflowName: options.workflowName,
      workflowDir,
      entrypointId: selected.entrypointId,
      entrypointTitle: selected.entrypointTitle,
      args,
      paramValues: parseWorkflowParamValues(execution.params, args),
      env,
      abortSignal: runtime.abortSignal,
      hostInput: options.hostInput,
      conversationId: options.conversationId,
      toolPermissionPolicies: options.toolPermissionPolicies,
    };
    registry = resolveWorkflowNodeRegistry(execution.registry, executorContext);
    const entry = resolveDebugNodeEntry(execution.registry, options.nodeName);
    const extraContext = execution.createContext
      ? await execution.createContext(executorContext)
      : {};
    const input = entry.createInput
      ? await entry.createInput(executorContext)
      : await execution.createInput(executorContext);
    const resolvedConversationId = resolveExecutorConversationId(
      definition,
      options.conversationId,
      readInputConversationId(input),
    );
    const executorStorage = createExecutorStorageContexts({
      declaration: projectStorageDeclaration,
      env,
      workflowName: options.workflowName,
      runId: runtime.runId,
      conversationId: resolvedConversationId,
      options: options.storage,
    });
    const kv = executorStorage.host.kv;
    const conversation = createExecutorConversationContext({
      definition,
      workflowName: options.workflowName,
      conversationId: resolvedConversationId,
      kv,
      onTitleChange: (event) =>
        runtime.emitConversationTitleUpdated({
          conversationId: event.conversationId,
          title: event.title,
          updatedAt: new Date(event.updatedAt),
        }),
    });
    activeConversationId = conversation.conversationId;
    tokenUsage = createWorkflowTokenUsageContext({
      definition: execution.tokenUsage,
      kv,
      projectId: projectStorageDeclaration.projectId,
      runId: runtime.runId,
      conversationId: conversation.conversationId,
      onUpdate: (usage) =>
        runtime.emitTokenUsageUpdated({
          conversationId: conversation.conversationId,
          usage,
          updatedAt: new Date(usage.updatedAt ?? new Date().toISOString()),
        }),
    });
    const userInput = createExecutorUserInputContext({
      workflowName: options.workflowName,
      runtime,
      userInput: options.userInput,
    });
    const context: RunContext = {
      ...extraContext,
      providers: mergeProviderRegistries(extraContext.providers, options.providers),
      storage: executorStorage.storage,
      conversation,
      tokenUsage,
      userInput,
      toolPermissions: createWorkflowToolPermissionContext({
        definitions: execution.tools,
        policies: options.toolPermissionPolicies,
        userInput,
        workflowName: options.workflowName,
        runId: runtime.runId,
      }),
      timers: runtime.timers,
      files: createExecutorFileStore({
        env,
        workflowName: options.workflowName,
        conversationId: conversation.conversationId,
        fileStore: options.fileStore,
        fileStoreDir: options.fileStoreDir,
        fileCreateStoreDir: options.fileCreateStoreDir,
      }),
      metadata: {
        workflow: options.workflowName,
        runId: runtime.runId,
        debugNode: options.nodeName,
        conversationId: conversation.conversationId,
        ...extraContext.metadata,
        ...(selected.entrypointId === undefined
          ? {}
          : {
              entrypointId: selected.entrypointId,
              entrypointTitle: selected.entrypointTitle,
            }),
      },
      abortSignal: runtime.abortSignal,
      nodeHooks: combineNodeExecutionHooks(
        runtime.runtimeNodeHooks,
        extraContext.nodeHooks,
      ),
    };

    runtime.throwIfAborted();
    const debugOutput = entry.stream
      ? (await runStreamNode(requireStreamDebugNode(entry), input, context)).output
      : await runNode(requireDebugNode(entry), input, context);
    result = {
      ok: true,
      data: debugOutput,
    };
  } catch (error) {
    await runtime.start({ id: activeEntrypointId, title: activeEntrypointTitle });
    const diagnosedError = diagnoseModuleImportError(error, workflowDir, options.workflowName) ?? error;
    result = runtime.abortSignal.aborted
      ? createAbortedWorkflowResult(runtime.abortSignal, options.workflowName)
      : createWorkflowFailure(diagnosedError);
  }

  return runtime.finish({
    definedNodes,
    registry,
    entrypointId: activeEntrypointId,
    entrypointTitle: activeEntrypointTitle,
    conversationId:
      activeConversationId ?? readReportConversationId(options.conversationId, result),
    tokenUsage: createReportTokenUsage(tokenUsage),
    result,
  });
}

function createExecutorUserInputContext(options: {
  workflowName: string;
  runtime: Runtime;
  userInput?: UserInputContext;
}): UserInputContext | undefined {
  if (options.userInput === undefined) {
    return undefined;
  }

  const nextContext: UserInputContextWithResumeBarrier = {
    [RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID]: readResumeRuntimeEventAfterRequestId(options.userInput),
    async getResolvedInput(requestId, request) {
      const resolved = await options.userInput?.getResolvedInput(requestId, request);
      if (resolved !== undefined) {
        await options.runtime.emitUserInputResolved({
          ...resolved,
          request: resolved.request ?? request,
        });
      }
      return resolved;
    },
    async requestInput(request) {
      await options.runtime.emitUserInputRequested(request);
      try {
        await options.userInput?.requestInput(request);
      } catch (error) {
        if (error instanceof HarnessError && error.type === "user_input_required") {
          throw error;
        }
      }
      throw new HarnessError({
        type: "user_input_required",
        message: `Workflow "${options.workflowName}" is waiting for user input "${request.requestId}".`,
        nodeName: request.nodeName,
        metadata: { request },
      });
    },
  };

  return nextContext;
}

function createLocalUserInputContext(options: {
  workflowName: string;
  runId: string;
  reporter: ReturnType<typeof createNodeExecutionReporter>;
  userInput?: UserInputContext;
}): UserInputContext | undefined {
  if (options.userInput === undefined) {
    return undefined;
  }

  const nextContext: UserInputContextWithResumeBarrier = {
    [RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID]: readResumeRuntimeEventAfterRequestId(options.userInput),
    async getResolvedInput(requestId, request) {
      const resolved = await options.userInput?.getResolvedInput(requestId, request);
      if (resolved !== undefined) {
        await options.reporter.emitUserInputResolved({
          ...resolved,
          request: resolved.request ?? request,
        });
      }
      return resolved;
    },
    async requestInput(request) {
      await options.reporter.emitUserInputRequested(request);
      try {
        await options.userInput?.requestInput(request);
      } catch (error) {
        if (error instanceof HarnessError && error.type === "user_input_required") {
          throw error;
        }
      }
      // Save the pause marker so a local report can be resumed by runId.
      throw new HarnessError({
        type: "user_input_required",
        message: `Workflow "${options.workflowName}" is waiting for user input "${request.requestId}".`,
        nodeName: request.nodeName,
        metadata: {
          runId: options.runId,
          request,
        },
      });
    },
  };

  return nextContext;
}

export async function runLocalWorkflow(
  options: RunLocalWorkflowOptions = {},
): Promise<RunResult<unknown>> {
  const report = await runLocalWorkflowWithReport(options);

  return report.result;
}

export async function runLocalWorkflowWithReport(
  options: RunLocalWorkflowOptions = {},
): Promise<ExecutionReport<unknown>> {
  const workflowDir = resolveLocalWorkflowDir(options.workflowDir);
  let workflowName = options.workflowName ?? readLocalWorkflowName(workflowDir);
  assertLocalProjectIsExecutable(workflowDir, workflowName);
  const projectStorageDeclaration = readWorkflowProjectStorageDeclaration(workflowDir);
  const args = options.args ?? [];
  const env = options.env ?? process.env;
  const startedAt = new Date();
  const runId = options.runId ?? createWorkflowRunId();
  const abortController = createChainedAbortController(options.abortSignal);
  const onRuntimeEvent = createResumeAwareRuntimeEventHandler(
    options.onRuntimeEvent,
    readResumeRuntimeEventAfterRequestId(options.userInput),
  );
  const reporter = createNodeExecutionReporter({
    runId,
    workflowName,
    onRuntimeEvent,
  });
  const timers = createWorkflowTimerContext({
    onTimerStart: (event) =>
      reporter.emitTimerStarted({
        runId,
        workflowName,
        timer: event.timer,
      }),
    onTimerFinish: (event) =>
      reporter.emitTimerFinished({
        runId,
        workflowName,
        timer: event.timer,
      }),
  });
  let definedNodes: DefinedNode[] = [];
  let registry: NodeRegistryItem[] = [];
  let activeEntrypointId: string | undefined;
  let activeEntrypointTitle: string | undefined;
  let activeConversationId: string | undefined;
  let startedEventEmitted = false;
  let tokenUsage: TokenUsageContext | undefined;
  let result: RunResult<unknown>;

  try {
    const modulePath = resolveLocalWorkflowModulePath(workflowDir, workflowName);
    const scriptInspection = inspectWorkflowScripts({
      cwd: workflowDir,
      workflowName,
      workflowDir,
    });
    definedNodes = scriptInspection.definedNodes;

    await options.onDefinedNodes?.({
      workflowName,
      workflowDir,
      nodes: definedNodes,
    });

    if (scriptInspection.violations.length > 0) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow "${workflowName}" script validation failed.`,
        metadata: {
          workflow: workflowName,
          violations: scriptInspection.violations,
        },
      });
    }

    loadWorkflowEnv(path.join(workflowDir, ".env"));
    assertWorkflowProjectStorageHostAvailable({
      declaration: projectStorageDeclaration,
      env,
      workflowName,
      options: options.storage,
    });

    installWorkflowRuntimeGlobal();
    const module = await import(pathToFileURL(modulePath).href);
    const definition = resolveExecutorDefinition(
      module as ExecutorModule,
      workflowName,
    );
    const selected = resolveExecutorExecution(
      definition,
      options.entrypointId,
      workflowName,
    );
    const execution = selected.execution;
    if (definition.projectType === "conversation") {
      workflowName = execution.workflow.name || workflowName;
    }
    activeEntrypointId = selected.entrypointId;
    activeEntrypointTitle = selected.entrypointTitle;
    await reporter.emitWorkflowStarted({
      runId,
      workflowName,
      entrypointId: selected.entrypointId,
      entrypointTitle: selected.entrypointTitle,
      startedAt,
    });
    startedEventEmitted = true;

    const executorContext: ExecutorContext = {
      workflowName,
      workflowDir,
      entrypointId: selected.entrypointId,
      entrypointTitle: selected.entrypointTitle,
      args,
      paramValues: parseWorkflowParamValues(execution.params, args),
      env,
      abortSignal: abortController.signal,
      hostInput: options.hostInput,
      conversationId: options.conversationId,
      toolPermissionPolicies: options.toolPermissionPolicies,
    };
    const input = await execution.createInput(executorContext);
    const extraContext = execution.createContext
      ? await execution.createContext(executorContext)
      : {};
    registry = resolveWorkflowNodeRegistry(execution.registry, executorContext);
    const resolvedConversationId = resolveExecutorConversationId(
      definition,
      options.conversationId,
      readInputConversationId(input),
    );
    const executorStorage = createExecutorStorageContexts({
      declaration: projectStorageDeclaration,
      env,
      workflowName,
      runId,
      conversationId: resolvedConversationId,
      options: options.storage,
    });
    const kv = executorStorage.host.kv;
    const conversation = createExecutorConversationContext({
      definition,
      workflowName,
      conversationId: resolvedConversationId,
      kv,
      onTitleChange: (event) =>
        reporter.emitConversationTitleUpdated({
          runId,
          workflowName,
          conversationId: event.conversationId,
          title: event.title,
          updatedAt: new Date(event.updatedAt),
        }),
    });
    activeConversationId = conversation.conversationId;
    tokenUsage = createWorkflowTokenUsageContext({
      definition: execution.tokenUsage,
      kv,
      projectId: projectStorageDeclaration.projectId,
      runId,
      conversationId: conversation.conversationId,
      onUpdate: (usage) =>
        reporter.emitTokenUsageUpdated({
          runId,
          workflowName,
          conversationId: conversation.conversationId,
          usage,
          updatedAt: new Date(usage.updatedAt ?? new Date().toISOString()),
        }),
    });
    const userInput = createLocalUserInputContext({
      workflowName,
      runId,
      reporter,
      userInput: options.userInput,
    });
    const context: RunContext = {
      ...extraContext,
      providers: mergeProviderRegistries(extraContext.providers, options.providers),
      storage: executorStorage.storage,
      conversation,
      tokenUsage,
      userInput,
      toolPermissions: createWorkflowToolPermissionContext({
        definitions: execution.tools,
        policies: options.toolPermissionPolicies,
        userInput,
        workflowName,
        runId,
      }),
      timers,
      files: createExecutorFileStore({
        env,
        workflowName,
        conversationId: conversation.conversationId,
        fileStore: options.fileStore,
        fileStoreDir: options.fileStoreDir,
        fileCreateStoreDir: options.fileCreateStoreDir,
      }),
      abortSignal: abortController.signal,
      metadata: {
        workflow: workflowName,
        runId,
        conversationId: conversation.conversationId,
        agentStoreDir: options.storage?.[options.storage.host]?.agentStoreDir
          ?? env.STEAMHARNESS_AGENT_STORE_DIR ?? path.join(workflowDir, ".workflow", "agents"),
        ...extraContext.metadata,
        ...(selected.entrypointId === undefined
          ? {}
          : {
              entrypointId: selected.entrypointId,
              entrypointTitle: selected.entrypointTitle,
            }),
      },
      nodeHooks: combineNodeExecutionHooks(
        reporter.hooks,
        extraContext.nodeHooks,
        options.nodeHooks,
      ),
    };

    throwIfRunLocalWorkflowAborted(abortController.signal, workflowName);
    result = await safeRunWorkflow(execution.workflow, input, context);
    if (abortController.signal.aborted) {
      result = createAbortedWorkflowResult(abortController.signal, workflowName);
    }
  } catch (error) {
    if (!startedEventEmitted) {
      await reporter.emitWorkflowStarted({
        runId,
        workflowName,
        entrypointId: activeEntrypointId,
        entrypointTitle: activeEntrypointTitle,
        startedAt,
      });
      startedEventEmitted = true;
    }
    result = abortController.signal.aborted
      ? createAbortedWorkflowResult(abortController.signal, workflowName)
      : createWorkflowFailure(
          diagnoseModuleImportError(error, workflowDir, workflowName) ?? error,
        );
  }

  const endedAt = new Date();
  const pendingUserInput = reporter.getPendingUserInput();
  // Local workflow runs share the same timer cleanup contract as the
  // workspace runtime, so App live views never keep stale running timer cards.
  await timers.clearRunningTimers();
  const outputs = reporter.getOutputs();
  const status = pendingUserInput !== undefined
    ? "waiting_for_input"
    : abortController.signal.aborted
      ? "aborted"
      : undefined;
  await reporter.emitWorkflowFinished({
    runId,
    workflowName,
    entrypointId: activeEntrypointId,
    entrypointTitle: activeEntrypointTitle,
    conversationId: activeConversationId,
    status: status ?? resolveWorkflowResultStatus(result, outputs),
    startedAt,
    endedAt,
    result,
    outputs,
  });

  return createWorkflowExecutionReport({
    runId,
    workflowName,
    entrypointId: activeEntrypointId,
    entrypointTitle: activeEntrypointTitle,
    // Local project execution must preserve cancellation as an
    // aborted report instead of inferring failed from the 499 result payload.
    status,
    startedAt,
    endedAt,
    definedNodes,
    registry,
    conversationId:
      activeConversationId ?? readReportConversationId(options.conversationId, result),
    conversationTitle: reporter.getConversationTitle(),
    pendingUserInput,
    resolvedUserInputs: reporter.getResolvedUserInputs(),
    tokenUsage: createReportTokenUsage(tokenUsage),
    result,
    nodes: reporter.getReports(),
    outputs,
    timers: timers.getTimers(),
  });
}

function readResumeRuntimeEventAfterRequestId(
  userInput: UserInputContext | undefined,
): string | undefined {
  if (userInput === undefined || typeof userInput !== "object" || userInput === null) {
    return undefined;
  }

  const value = (userInput as unknown as UserInputContextWithResumeBarrier)[RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function createResumeAwareRuntimeEventHandler(
  onRuntimeEvent: ((event: RuntimeEvent) => Promise<void> | void) | undefined,
  resumeAfterRequestId: string | undefined,
): ((event: RuntimeEvent) => Promise<void>) | undefined {
  if (onRuntimeEvent === undefined) {
    return undefined;
  }

  if (resumeAfterRequestId === undefined) {
    return async (event) => {
      await onRuntimeEvent(event);
    };
  }

  let released = false;
  return async (event) => {
    if (released) {
      await onRuntimeEvent(event);
      return;
    }

    if (event.type === "user_input_resolved" && event.requestId === resumeAfterRequestId) {
      released = true;
      await onRuntimeEvent(event);
      return;
    }

    if (
      event.type === "workflow_succeeded" ||
      event.type === "workflow_failed" ||
      event.type === "workflow_aborted" ||
      event.type === "workflow_timed_out"
    ) {
      released = true;
      await onRuntimeEvent(event);
    }
  };
}

export function inspectWorkspaceWorkflowStructure(options: {
  cwd?: string;
  workflowName: string;
}): StructureReport {
  const cwd = options.cwd ?? process.cwd();
  const { workflowDir } = resolveWorkflowLocation(cwd, options.workflowName);

  const scriptInspection = inspectWorkflowStructure({
    cwd,
    workflowName: options.workflowName,
    workflowDir,
  });

  if (scriptInspection.diagnostics.violations.length > 0) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${options.workflowName}" script validation failed.`,
      metadata: {
        workflow: options.workflowName,
        violations: scriptInspection.diagnostics.violations,
      },
    });
  }

  const projectType = resolveInspectedProjectType(scriptInspection);
  const schedulePresets = readWorkflowSchedulePresets(
    workflowDir,
    projectType,
    scriptInspection.entrypoints,
  );
  return {
    projectType,
    workflow: scriptInspection.workflow,
    definitions: scriptInspection.definitions,
    diagnostics: scriptInspection.diagnostics,
    ...(projectType === "workflow"
      ? {
          defaultEntrypoint: scriptInspection.defaultEntrypoint,
          entrypoints: scriptInspection.entrypoints,
          schedulePresets,
        }
      : {
          execution: scriptInspection.execution,
          params: scriptInspection.params,
          paramLayout: scriptInspection.paramLayout,
          paramResolver: scriptInspection.paramResolver,
          conversation: scriptInspection.conversation,
          tokenUsage: scriptInspection.tokenUsage,
          tools: scriptInspection.tools,
          registry: scriptInspection.registry,
        }),
  };
}

export function inspectLocalWorkflowStructure(options: {
  workflowDir?: string;
  workflowName?: string;
} = {}): StructureReport {
  const workflowDir = resolveLocalWorkflowDir(options.workflowDir);
  const workflowName = options.workflowName ?? readLocalWorkflowName(workflowDir);

  if (readLocalPackageProjectType(workflowDir) === "kanban") {
    const packageJson = readLocalPackageJson(workflowDir);
    readSchedulePresetValue(packageJson, "kanban", []);
    const artifact = readKanbanArtifactConfig(packageJson);
    const artifactEntryPath = createKanbanArtifactEntryPath(artifact);
    const entryPath = path.join(workflowDir, ...artifactEntryPath.split("/"));
    if (!existsSync(entryPath) || !isRegularKanbanArtifactEntry(workflowDir, artifactEntryPath)) {
      throw new HarnessError({
        type: "input_validation",
        message: `Kanban project "${workflowName}" must contain regular artifact entry ${artifactEntryPath}.`,
        metadata: { workflow: workflowName, workflowDir, artifact },
      });
    }
    const manifestPath = path.join(workflowDir, KANBAN_MANIFEST_FILE);
    const manifest = existsSync(manifestPath)
      ? parseKanbanManifestText(readFileSync(manifestPath, "utf8"))
      : undefined;
    return {
      projectType: "kanban",
      workflow: {
        name: workflowName,
        dir: workflowDir,
        files: readKanbanStructureFiles(workflowDir),
      },
      definitions: { nodes: {}, apiCalls: [], variables: {}, registry: {} },
      execution: { kind: "sequence", children: [] },
      diagnostics: { warnings: [], violations: [] },
      params: manifest?.params,
      kanban: { ...artifact, manifest },
    };
  }

  const scriptInspection = inspectWorkflowStructure({
    cwd: workflowDir,
    workflowName,
    workflowDir,
  });

  if (scriptInspection.diagnostics.violations.length > 0) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${workflowName}" script validation failed.`,
      metadata: {
        workflow: workflowName,
        violations: scriptInspection.diagnostics.violations,
      },
    });
  }

  const projectType = resolveInspectedProjectType(scriptInspection);
  const schedulePresets = readWorkflowSchedulePresets(
    workflowDir,
    projectType,
    scriptInspection.entrypoints,
  );
  return {
    projectType,
    workflow: scriptInspection.workflow,
    definitions: scriptInspection.definitions,
    diagnostics: scriptInspection.diagnostics,
    ...(projectType === "workflow"
      ? {
          defaultEntrypoint: scriptInspection.defaultEntrypoint,
          entrypoints: scriptInspection.entrypoints,
          schedulePresets,
        }
      : {
          execution: scriptInspection.execution,
          params: scriptInspection.params,
          paramLayout: scriptInspection.paramLayout,
          paramResolver: scriptInspection.paramResolver,
          conversation: scriptInspection.conversation,
          tokenUsage: scriptInspection.tokenUsage,
          tools: scriptInspection.tools,
          registry: scriptInspection.registry,
        }),
  };
}

function resolveInspectedProjectType(
  inspection: {
    projectType?: ExecutorProjectType;
    entrypoints?: unknown[];
    defaultEntrypoint?: string;
  },
): ExecutorProjectType {
  if (inspection.projectType !== undefined) return inspection.projectType;
  return inspection.entrypoints !== undefined || inspection.defaultEntrypoint !== undefined
    ? "workflow"
    : "conversation";
}

export async function resolveWorkspaceWorkflowParams(options: {
  cwd?: string;
  workflowName: string;
  entrypointId?: string;
  request: ParamResolveRequest;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  hostInput?: unknown;
  storage?: ExecutionStorageOptions;
}): Promise<ParamResolveResult> {
  const cwd = options.cwd ?? process.cwd();
  const location = resolveWorkflowLocation(cwd, options.workflowName);
  const declaration = readWorkflowProjectStorageDeclaration(location.workflowDir);
  return resolveWorkflowParamsFromModule({
    workflowName: options.workflowName,
    workflowDir: location.workflowDir,
    modulePath: location.modulePath,
    declaration,
    storage: options.storage,
    entrypointId: options.entrypointId,
    request: options.request,
    env: options.env,
    abortSignal: options.abortSignal,
    hostInput: options.hostInput,
  });
}

export async function resolveLocalWorkflowParams(options: {
  workflowDir?: string;
  workflowName?: string;
  entrypointId?: string;
  request: ParamResolveRequest;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  hostInput?: unknown;
  storage?: ExecutionStorageOptions;
}): Promise<ParamResolveResult> {
  const workflowDir = resolveLocalWorkflowDir(options.workflowDir);
  const workflowName = options.workflowName ?? readLocalWorkflowName(workflowDir);
  assertLocalProjectIsExecutable(workflowDir, workflowName);
  const declaration = readWorkflowProjectStorageDeclaration(workflowDir);
  return resolveWorkflowParamsFromModule({
    workflowName,
    workflowDir,
    modulePath: resolveLocalWorkflowModulePath(workflowDir, workflowName),
    declaration,
    storage: options.storage,
    entrypointId: options.entrypointId,
    request: options.request,
    env: options.env,
    abortSignal: options.abortSignal,
    hostInput: options.hostInput,
  });
}

async function resolveWorkflowParamsFromModule(options: {
  workflowName: string;
  workflowDir: string;
  modulePath: string;
  declaration: ProjectStorageDeclaration;
  storage?: ExecutionStorageOptions;
  entrypointId?: string;
  request: ParamResolveRequest;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  hostInput?: unknown;
}): Promise<ParamResolveResult> {
  const abortSignal = options.abortSignal ?? new AbortController().signal;
  if (abortSignal.aborted) throw abortSignal.reason;
  loadWorkflowEnv(path.join(options.workflowDir, ".env"));
  assertWorkflowProjectStorageHostAvailable({
    declaration: options.declaration,
    env: options.env,
    workflowName: options.workflowName,
    options: options.storage,
  });
  installWorkflowRuntimeGlobal();
  const module = await import(pathToFileURL(options.modulePath).href);
  const definition = resolveExecutorDefinition(module as ExecutorModule, options.workflowName);
  const selected = resolveExecutorExecution(
    definition,
    options.entrypointId,
    options.workflowName,
  );
  const execution = selected.execution;
  if (!execution.resolveParams) return { params: {} };
  const args = options.request.args.map(String);
  const result = await execution.resolveParams({
    workflowName: options.workflowName,
    workflowDir: options.workflowDir,
    entrypointId: selected.entrypointId,
    entrypointTitle: selected.entrypointTitle,
    args,
    paramValues: parseWorkflowParamValues(execution.params, args),
    env: options.env ?? process.env,
    abortSignal,
    hostInput: options.hostInput,
    draftText: options.request.draftText,
    inputMode: options.request.inputMode,
    trigger: options.request.trigger,
  });
  if (abortSignal.aborted) throw abortSignal.reason;
  const validated = validateWorkflowParamResolveResult(execution.params, result);
  if (definition.projectType === "conversation") {
    const params = normalizeWorkflowParamDeclarations(execution.params).params.map(param => {
      const options = validated.params?.[param.name]?.resolvedOptions;
      return param.panel !== "slash" || !options ? param : { ...param, options: options.map(option => ({ ...option,
        command: option.command ?? param.options?.find(original => original.value === option.value)?.command })) };
    });
    assertConversationCommands(definition.conversation?.commands, params);
  }
  return validated;
}

function createExecutorConversationContext(options: {
  definition: ExecutorDefinition<unknown, unknown>;
  workflowName: string;
  conversationId?: string;
  kv: KVContext;
  onTitleChange?: (event: {
    conversationId: string;
    title?: string;
    updatedAt: string;
  }) => Promise<void> | void;
}): ConversationContext {
  if (!isConversationProjectType(options.definition.projectType)) {
    return createDisabledWorkflowConversationContext();
  }

  // Conversation state uses the selected local or remote KV store.
  return createWorkflowConversationContext({
    enabled: true,
    workflowName: options.workflowName,
    conversationId: options.conversationId,
    kv: options.kv,
    onTitleChange: options.onTitleChange,
  });
}

function createReportTokenUsage(tokenUsage?: TokenUsageContext) {
  return tokenUsage?.enabled === true
    ? {
        enabled: true as const,
        display: tokenUsage.display,
        run: tokenUsage.getRunUsage(),
      }
    : undefined;
}

function resolveExecutorConversationId(
  definition: ExecutorDefinition<unknown, unknown>,
  requestedConversationId: string | undefined,
  inputConversationId?: string,
): string | undefined {
  if (!isConversationProjectType(definition.projectType)) {
    return undefined;
  }

  const normalized = requestedConversationId?.trim();
  if (normalized !== undefined && normalized !== "") {
    return normalized;
  }

  // createInput may supply the stable conversation ID after parsing input.
  const inputNormalized = inputConversationId?.trim();
  return inputNormalized === undefined || inputNormalized === "" ? randomUUID() : inputNormalized;
}

function readInputConversationId(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const value = input["conversationId"] ?? input["conversation_id"];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function createExecutorStorageContexts(options: {
  declaration: ProjectStorageDeclaration;
  env?: NodeJS.ProcessEnv;
  workflowName: string;
  runId?: string;
  conversationId?: string;
  options?: ExecutionStorageOptions;
}): ExecutorStorageContexts {
  const executionStorage = resolveWorkflowExecutionStorageOptions(options.options, options.env);
  const local = createExecutorStorageLocationContext({
    location: "local",
    declaration: options.declaration,
    backend: executionStorage.local,
    env: options.env,
    workflowName: options.workflowName,
    runId: options.runId,
    conversationId: options.conversationId,
  });
  const server = createExecutorStorageLocationContext({
    location: "server",
    declaration: options.declaration,
    backend: executionStorage.server,
    env: options.env,
    workflowName: options.workflowName,
    runId: options.runId,
    conversationId: options.conversationId,
  });
  const hostLocation = resolveWorkflowExecutionHostLocation(
    options.declaration.projectInfo,
    executionStorage.host,
  );
  const host = hostLocation === "local" ? local : server;
  if (!host.available) {
    throw createWorkflowStorageUnavailableError(hostLocation, host.unavailableReason);
  }
  return {
    storage: { local: local.context, server: server.context },
    host: host.context,
  };
}

function createExecutorStorageLocationContext(options: {
  location: ProjectDataStorageLocation;
  declaration: ProjectStorageDeclaration;
  backend?: ExecutionStorageBackendOptions;
  env?: NodeJS.ProcessEnv;
  workflowName: string;
  runId?: string;
  conversationId?: string;
}): {
  context: StorageLocationContext;
  available: boolean;
  unavailableReason?: string;
} {
  try {
    assertWorkflowProjectDataStorageLocationAllowed(
      options.declaration.projectInfo,
      options.location,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      context: createUnavailableWorkflowStorageLocationContext(
        options.location,
        options.declaration.projectId,
        options.conversationId,
        message,
      ),
      available: false,
      unavailableReason: message,
    };
  }

  const localSource = {
    projectId: options.declaration.projectId,
    runId: options.runId,
    conversationId: options.conversationId,
  };
  if (options.location === "local") {
    if (options.backend === undefined) {
      const message = "This execution host does not provide local project storage.";
      return {
        context: createUnavailableWorkflowStorageLocationContext(
          "local",
          options.declaration.projectId,
          options.conversationId,
          message,
        ),
        available: false,
        unavailableReason: message,
      };
    }
    const kvStore = options.backend.kvStore ?? createLocalWorkflowKVStore({
      rootDir: options.backend.kvStoreDir ?? path.join(os.tmpdir(), "steamharness-kv"),
      storageKind: "kv",
    });
    const persistentValueStoreDir = options.backend.persistentValueStoreDir?.trim();
    const persistentValueStore = options.backend.persistentValueStore ??
      (persistentValueStoreDir === undefined || persistentValueStoreDir === ""
        ? undefined
        : createLocalWorkflowKVStore({
            rootDir: persistentValueStoreDir,
            storageKind: "persistent_value",
          }));
    return {
      context: {
        kv: createWorkflowKVContext({
          store: kvStore,
          projectId: options.declaration.projectId,
          conversationId: options.conversationId,
          source: localSource,
        }),
        persistentValue: createWorkflowPersistentValueContext({
          store: persistentValueStore,
          projectId: options.declaration.projectId,
          conversationId: options.conversationId,
          source: localSource,
        }),
        relatedProjects: createWorkflowRelatedProjectsContext(
          options.backend.relatedProjectResolver,
        ),
      },
      available: true,
    };
  }

  const projectId = options.declaration.projectId;
  const kvStore = options.backend?.kvStore ??
    createRemoteWorkflowStorageStoreFromEnv(projectId, "kv", options.env);
  const persistentValueStore = options.backend?.persistentValueStore ??
    createRemoteWorkflowStorageStoreFromEnv(projectId, "persistent_value", options.env);
  if (kvStore === undefined) {
    const message = "Server storage requires an authenticated server connection for this project.";
    return {
      context: createUnavailableWorkflowStorageLocationContext(
        "server",
        projectId,
        options.conversationId,
        message,
      ),
      available: false,
      unavailableReason: message,
    };
  }
  const serverSource = {
    projectId,
    runId: options.runId,
    conversationId: options.conversationId,
  };
  return {
    context: {
      kv: createWorkflowKVContext({
        store: kvStore,
        projectId,
        conversationId: options.conversationId,
        source: serverSource,
      }),
      persistentValue: createWorkflowPersistentValueContext({
        store: persistentValueStore,
        projectId,
        conversationId: options.conversationId,
        source: serverSource,
      }),
      relatedProjects: createWorkflowRelatedProjectsContext(
        options.backend?.relatedProjectResolver,
      ),
    },
    available: true,
  };
}

function createUnavailableWorkflowStorageLocationContext(
  location: ProjectDataStorageLocation,
  projectId: string,
  conversationId: string | undefined,
  reason: string,
): StorageLocationContext {
  const store = createUnavailableWorkflowStorageStore(location, reason);
  return {
    kv: createWorkflowKVContext({ store, projectId, conversationId }),
    persistentValue: createWorkflowPersistentValueContext({ store, projectId, conversationId }),
    relatedProjects: createWorkflowRelatedProjectsContext(),
  };
}

function createUnavailableWorkflowStorageStore(
  location: ProjectDataStorageLocation,
  reason: string,
): KVStore {
  const fail = (): never => {
    throw createWorkflowStorageUnavailableError(location, reason);
  };
  return {
    async getValue() { return fail(); },
    async setValue() { fail(); },
    async deleteValue() { return fail(); },
    async updateValue() { return fail(); },
    async withNamespaceLock() { return fail(); },
    async withNamespaceReadLock() { return fail(); },
    async executeNamespaceMutation() { return fail(); },
  };
}

function createWorkflowStorageUnavailableError(
  location: ProjectDataStorageLocation,
  reason?: string,
): HarnessError {
  return new HarnessError({
    type: "input_validation",
    message: reason ?? `Workflow ${location} storage is unavailable.`,
    metadata: { storageLocation: location },
  });
}

function resolveWorkflowExecutionStorageOptions(
  options: ExecutionStorageOptions | undefined,
  env: NodeJS.ProcessEnv | undefined,
): ExecutionStorageOptions {
  if (options !== undefined) return options;
  return {
    host: "local",
    local: {
      kvStoreDir: env?.STEAMHARNESS_KV_STORE_DIR,
      persistentValueStoreDir: env?.STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR,
    },
  };
}

function resolveWorkflowExecutionHostLocation(
  projectInfo: ProjectInfoContract,
  preferredHost: ProjectDataStorageLocation,
): ProjectDataStorageLocation {
  const mode = projectInfo.dataStorage?.mode;
  if (mode === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: "steamHarness.projectInfo.dataStorage.mode must be declared before this project can run.",
    });
  }
  return mode === "both" ? preferredHost : mode;
}

function assertWorkflowProjectStorageHostAvailable(options: {
  declaration: ProjectStorageDeclaration;
  env?: NodeJS.ProcessEnv;
  workflowName: string;
  options?: ExecutionStorageOptions;
}): void {
  createExecutorStorageContexts({
    declaration: options.declaration,
    env: options.env,
    workflowName: options.workflowName,
    options: options.options,
  });
}

function readWorkflowProjectStorageDeclaration(
  workflowDir: string,
): ProjectStorageDeclaration {
  const packagePath = path.join(workflowDir, "package.json");
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow package.json could not be read at ${packagePath}.`,
      metadata: {
        packagePath,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  let projectInfo: ProjectInfoContract;
  try {
    projectInfo = readWorkflowProjectInfo(packageJson);
  } catch (error) {
    throw new HarnessError({
      type: "input_validation",
      message: error instanceof Error ? error.message : "steamHarness.projectInfo is invalid.",
    });
  }
  if (projectInfo.dataStorage === null) {
    throw new HarnessError({
      type: "input_validation",
      message: "steamHarness.projectInfo.dataStorage.mode must be declared before this project can run or access data.",
      metadata: { packagePath },
    });
  }
  const projectId = isRecord(packageJson) && typeof packageJson["id"] === "string"
    ? packageJson["id"].trim() || undefined
    : undefined;
  if (projectId === undefined || !STEAMHARNESS_PROJECT_UUID_PATTERN.test(projectId)) {
    throw new HarnessError({
      type: "input_validation",
      message: "package.json.id must be a UUID before this project can run or access data.",
      metadata: { packagePath },
    });
  }
  return { projectId, projectInfo };
}

function readReportConversationId(
  requestedConversationId: string | undefined,
  result: RunResult<unknown>,
): string | undefined {
  if (requestedConversationId !== undefined) {
    return requestedConversationId;
  }

  if (!result.ok || !isRecord(result.data)) {
    return undefined;
  }

  const value = result.data["conversationId"] ?? result.data["conversation_id"];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function mergeProviderRegistries(
  base: ProviderRegistry | undefined,
  override: ProviderRegistry | undefined,
): ProviderRegistry {
  return {
    ...base,
    ...override,
    llmProviders: {
      ...base?.llmProviders,
      ...override?.llmProviders,
    },
    llmProviderBindings: {
      ...base?.llmProviderBindings,
      ...override?.llmProviderBindings,
    },
  };
}

function resolveWorkflowNodeRegistry(
  entries: NodeRegistryEntry[] | undefined,
  context: ExecutorContext,
): NodeRegistryItem[] {
  return (entries ?? []).map((entry) => {
    const standardName = readNodeStandardName(entry.node);
    const fallbackType = standardName ?? entry.name;
    const fallbackTitle = readNodeName(entry.node) ?? entry.name;

    return {
      name: entry.name,
      standardName,
      metadata: createWorkflowNodeMetadata(
        entry.metadata ?? readNodeMetadata(entry.node),
        {
          type: fallbackType,
          title: fallbackTitle,
        },
      ),
    };
  });
}

function resolveDebugNodeEntry(
  entries: NodeRegistryEntry[] | undefined,
  nodeName: string,
): NodeRegistryEntry {
  const normalizedName = nodeName.trim();
  const entry = (entries ?? []).find((item) => item.name === normalizedName);

  if (entry === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Debug node "${normalizedName}" is not registered. Add it to executor.registry before using single-node debug.`,
      nodeName: normalizedName,
      metadata: {
        debugNode: normalizedName,
        registeredNodes: (entries ?? []).map((item) => item.name),
      },
    });
  }

  return entry;
}

function requireDebugNode(
  entry: NodeRegistryEntry,
): NodeDefinition<unknown, unknown> {
  if ("run" in entry.node && typeof entry.node.run === "function") {
    return entry.node;
  }

  throw new HarnessError({
    type: "input_validation",
    message: `Debug node "${entry.name}" is a stream node. Mark its registry entry with stream: true.`,
    nodeName: entry.name,
  });
}

function requireStreamDebugNode(
  entry: NodeRegistryEntry,
): StreamNodeDefinition<unknown, unknown, unknown> {
  if ("stream" in entry.node && typeof entry.node.stream === "function") {
    return entry.node;
  }

  throw new HarnessError({
    type: "input_validation",
    message: `Debug node "${entry.name}" is not a stream node. Remove stream: true from its registry entry.`,
    nodeName: entry.name,
  });
}

function readNodeName(node: NodeRegistryEntry["node"]): string | undefined {
  return typeof node.name === "string" && node.name.trim() !== "" ? node.name : undefined;
}

function readNodeStandardName(node: NodeRegistryEntry["node"]): string | undefined {
  return typeof node.standardName === "string" && node.standardName.trim() !== ""
    ? node.standardName
    : undefined;
}

function readNodeMetadata(node: NodeRegistryEntry["node"]): NodeMetadata | undefined {
  return node.metadata === undefined ? undefined : { ...node.metadata };
}

export async function runWorkspaceWorkflowFromCli(
  argv: string[],
): Promise<RunResult<unknown>> {
  const { workflowName, args, entrypointId } = parseWorkspaceWorkflowCliArgs(argv);

  if (workflowName === undefined || workflowName.trim() === "") {
    return createWorkflowFailure(
      new HarnessError({
        type: "input_validation",
        message: "Missing workflow name. Usage: pnpm workflow <workflow-name> [...args]",
      }),
    );
  }

  return runWorkspaceWorkflow({
    workflowName,
    args,
    entrypointId,
    storage: {
      host: "local",
      local: {
        kvStoreDir: process.env.STEAMHARNESS_KV_STORE_DIR,
        persistentValueStoreDir: process.env.STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR,
      },
    },
  });
}

export async function runWorkspaceWorkflowReportFromCli(
  argv: string[],
  options: Pick<RunWorkspaceWorkflowOptions, "nodeHooks" | "onDefinedNodes" | "entrypointId"> = {},
): Promise<ExecutionReport<unknown>> {
  const parsed = parseWorkspaceWorkflowCliArgs(argv);
  const { workflowName, args } = parsed;

  if (workflowName === undefined || workflowName.trim() === "") {
    const startedAt = new Date();
    const result = createWorkflowFailure(
      new HarnessError({
        type: "input_validation",
        message: "Missing workflow name. Usage: pnpm workflow <workflow-name> [...args]",
      }),
    );
    const endedAt = new Date();

    return createWorkflowExecutionReport({
      runId: createWorkflowRunId(),
      workflowName: "",
      startedAt,
      endedAt,
      status: "failed",
      definedNodes: [],
      result,
      nodes: [],
      outputs: [],
    });
  }

  return runWorkspaceWorkflowWithReport({
    workflowName,
    args,
    entrypointId: options.entrypointId ?? parsed.entrypointId,
    storage: {
      host: "local",
      local: {
        kvStoreDir: process.env.STEAMHARNESS_KV_STORE_DIR,
        persistentValueStoreDir: process.env.STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR,
      },
    },
    nodeHooks: options.nodeHooks,
    onDefinedNodes: options.onDefinedNodes,
  });
}

function parseWorkspaceWorkflowCliArgs(argv: string[]): {
  workflowName?: string;
  args: string[];
  entrypointId?: string;
} {
  const [workflowName, ...rest] = argv;
  const args: string[] = [];
  let entrypointId: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--") {
      args.push(...rest.slice(index + 1));
      break;
    }
    if (arg === "--entrypoint") {
      const value = rest[++index];
      if (value === undefined || value.trim() === "") {
        throw new HarnessError({
          type: "input_validation",
          message: "Missing value for --entrypoint.",
        });
      }
      entrypointId = value;
      continue;
    }
    args.push(arg);
  }
  return { workflowName, args, entrypointId };
}

export function inspectWorkspaceWorkflowStructureFromCli(
  argv: string[],
): StructureReport {
  const [workflowName] = argv;

  if (workflowName === undefined || workflowName.trim() === "") {
    throw new HarnessError({
      type: "input_validation",
      message: "Missing workflow directory. Usage: steamharness structure <workflow-dir>",
    });
  }

  return inspectWorkspaceWorkflowStructure({
    workflowName,
  });
}

function resolveExecutorDefinition(
  module: ExecutorModule,
  workflowName: string,
): ExecutorDefinition<unknown, unknown> {
  if (isWorkflowExecutorShape(module.executor)) {
    return validateExecutorDefinition(module.executor, workflowName);
  }

  if (isWorkflowExecutorShape(module.default)) {
    return validateExecutorDefinition(module.default, workflowName);
  }

  throw new HarnessError({
    type: "input_validation",
    message: createProjectTypeValidationMessage(
      `Workflow "${workflowName}" must export an executor created by workflow.defineExecutor(...).`,
    ),
    metadata: {
      workflow: workflowName,
    },
  });
}

interface ExecutorDefinitionShape extends Record<string, unknown> {
  projectType?: unknown;
  conversation?: unknown;
  workflow?: unknown;
  createInput?: unknown;
  defaultEntrypoint?: unknown;
  entrypoints?: unknown;
}

function isWorkflowExecutorShape(
  value: unknown,
): value is ExecutorDefinitionShape {
  return (
    typeof value === "object" &&
    value !== null &&
    (
      Object.hasOwn(value, "projectType") ||
      Object.hasOwn(value, "workflow") ||
      Object.hasOwn(value, "entrypoints")
    )
  );
}

function validateExecutorDefinition(
  definition: ExecutorDefinitionShape,
  workflowName: string,
): ExecutorDefinition<unknown, unknown> {
  const projectType = resolveRuntimeExecutorProjectType(definition);
  if (projectType === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${workflowName}" executor shape is not runnable.`,
      metadata: { workflow: workflowName },
    });
  }
  const normalizedDefinition = definition.projectType === projectType
    ? definition
    : { ...definition, projectType };

  switch (projectType) {
    case "conversation": {
      if (!isWorkflowDefinition(normalizedDefinition.workflow) || typeof normalizedDefinition.createInput !== "function") {
        throw new HarnessError({
          type: "input_validation",
          message: `Conversation "${workflowName}" must declare workflow and createInput on its executor.`,
          metadata: { workflow: workflowName, projectType },
        });
      }
      if (normalizedDefinition.entrypoints !== undefined || normalizedDefinition.defaultEntrypoint !== undefined) {
        throw new HarnessError({
          type: "input_validation",
          message: `Conversation "${workflowName}" does not support entrypoints. Keep its executor as a single workflow.`,
          metadata: { workflow: workflowName, projectType },
        });
      }
      validateConversationOpenAIAdapter(normalizedDefinition.conversation, workflowName);
      assertWorkflowParamDeclarations((normalizedDefinition as ExecutionDefinition<unknown, unknown>).params, "conversation");
      assertConversationFooter(isRecord(normalizedDefinition.conversation) ? normalizedDefinition.conversation.footer : undefined,
        normalizeWorkflowParamDeclarations((normalizedDefinition as ExecutionDefinition<unknown, unknown>).params).params);
      assertConversationCommands(isRecord(normalizedDefinition.conversation) ? normalizedDefinition.conversation.commands : undefined,
        normalizeWorkflowParamDeclarations((normalizedDefinition as ExecutionDefinition<unknown, unknown>).params).params);
      assertConversationUserInput(isRecord(normalizedDefinition.conversation) ? normalizedDefinition.conversation.userInput : undefined,
        normalizeWorkflowParamDeclarations((normalizedDefinition as ExecutionDefinition<unknown, unknown>).params).params);
      break;
    }
    case "workflow": {
      assertWorkflowEntrypointsShape(normalizedDefinition, workflowName);
      break;
    }
    default:
      assertNeverWorkflowExecutorProjectType(projectType);
  }

  return normalizedDefinition as ExecutorDefinition<unknown, unknown>;
}

function validateConversationOpenAIAdapter(value: unknown, workflowName: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new HarnessError({
      type: "input_validation",
      message: `Conversation "${workflowName}" settings must be an object.`,
      metadata: { workflow: workflowName, projectType: "conversation" },
    });
  }
  if (Object.hasOwn(value, "defaultInput")) {
    throw new HarnessError({
      type: "input_validation",
      message: "conversation.defaultInput was removed. Conversation always uses the standard message input; declare attachment capabilities in conversation.attachments.",
    });
  }
  if (value.openai === undefined) return;
  if (
    !isRecord(value.openai)
    || value.openai.enabled !== true
    || typeof value.openai.outputItemId !== "string"
    || value.openai.outputItemId.trim() === ""
  ) {
    throw new HarnessError({
      type: "input_validation",
      message: `Conversation "${workflowName}" openai adapter must declare enabled: true and a non-empty outputItemId.`,
      metadata: { workflow: workflowName, projectType: "conversation" },
    });
  }
}

function resolveRuntimeExecutorProjectType(
  definition: ExecutorDefinitionShape,
): ExecutorProjectType | undefined {
  if (isWorkflowExecutorProjectType(definition.projectType)) return definition.projectType;
  if (Array.isArray(definition.entrypoints) || definition.defaultEntrypoint !== undefined) return "workflow";
  if (isWorkflowDefinition(definition.workflow)
      || typeof definition.createInput === "function"
      || definition.conversation !== undefined) {
    return "conversation";
  }
  return undefined;
}

function assertWorkflowEntrypointsShape(
  definition: ExecutorDefinitionShape,
  workflowName: string,
): asserts definition is ExecutorDefinitionShape & {
  projectType: "workflow";
  defaultEntrypoint: string;
  entrypoints: EntrypointDefinition<unknown, unknown>[];
} {
  const legacyKeys = [
    "workflow",
    "params",
    "createInput",
    "resolveParams",
    "requiredProviders",
    "tools",
    "tokenUsage",
    "registry",
    "createContext",
  ].filter((key) => Object.hasOwn(definition, key));
  if (legacyKeys.length > 0) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${workflowName}" uses removed top-level executor fields (${legacyKeys.join(", ")}). Move each execution configuration into workflow.defineEntrypoint(...).`,
      metadata: { workflow: workflowName, legacyKeys },
    });
  }
  if (
    typeof definition.defaultEntrypoint !== "string" ||
    definition.defaultEntrypoint.trim() === ""
  ) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${workflowName}" must declare a static defaultEntrypoint string.`,
      metadata: { workflow: workflowName },
    });
  }
  if (!Array.isArray(definition.entrypoints) || definition.entrypoints.length === 0) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${workflowName}" must declare at least one entrypoint.`,
      metadata: { workflow: workflowName },
    });
  }

  const ids = new Set<string>();
  const groups = new Map<string, EntrypointGroupDefinition>();
  for (const value of definition.entrypoints) {
    if (!isWorkflowEntrypointDefinition(value)) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow "${workflowName}" contains an invalid entrypoint definition.`,
        metadata: { workflow: workflowName },
      });
    }
    if (ids.has(value.id)) {
      throw new HarnessError({
        type: "input_validation",
        message: `Workflow "${workflowName}" declares duplicate entrypoint id "${value.id}".`,
        metadata: { workflow: workflowName, entrypointId: value.id },
      });
    }
    ids.add(value.id);
    if (value.group !== undefined) {
      const existing = groups.get(value.group.id);
      if (
        existing !== undefined &&
        (existing.title !== value.group.title || existing.order !== value.group.order)
      ) {
        throw new HarnessError({
          type: "input_validation",
          message: `Workflow "${workflowName}" entrypoint group "${value.group.id}" must use identical title and order in every entrypoint.`,
          metadata: { workflow: workflowName, groupId: value.group.id },
        });
      }
      groups.set(value.group.id, value.group);
    }
  }
  if (!ids.has(definition.defaultEntrypoint)) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${workflowName}" defaultEntrypoint "${definition.defaultEntrypoint}" does not match a declared entrypoint.`,
      metadata: {
        workflow: workflowName,
        defaultEntrypoint: definition.defaultEntrypoint,
        allowedEntrypoints: [...ids],
      },
    });
  }
}

function isWorkflowEntrypointDefinition(
  value: unknown,
): value is EntrypointDefinition<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const entrypoint = value as Record<string, unknown>;
  return (
    typeof entrypoint["id"] === "string" &&
    STEAMHARNESS_ENTRYPOINT_ID_PATTERN.test(entrypoint["id"]) &&
    typeof entrypoint["title"] === "string" &&
    entrypoint["title"].trim() !== "" &&
    isWorkflowEntrypointGroupDefinition(entrypoint["group"]) &&
    isWorkflowDefinition(entrypoint["workflow"]) &&
    typeof entrypoint["createInput"] === "function"
  );
}

function isWorkflowEntrypointGroupDefinition(
  value: unknown,
): value is EntrypointGroupDefinition | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    value["id"].trim() !== "" &&
    typeof value["title"] === "string" &&
    value["title"].trim() !== "" &&
    (
      !Object.hasOwn(value, "order") ||
      (
        typeof value["order"] === "number" &&
        Number.isInteger(value["order"]) &&
        value["order"] >= 0
      )
    )
  );
}

interface ResolvedExecutorExecution {
  execution: ExecutionDefinition<unknown, unknown>;
  entrypointId?: string;
  entrypointTitle?: string;
}

function resolveExecutorExecution(
  definition: ExecutorDefinition<unknown, unknown>,
  requestedEntrypointId: string | undefined,
  workflowName: string,
): ResolvedExecutorExecution {
  const requested = requestedEntrypointId?.trim();
  if (definition.projectType === "conversation") {
    if (requested !== undefined && requested !== "") {
      throw new HarnessError({
        type: "input_validation",
        message: `Conversation "${workflowName}" does not accept an entrypoint.`,
        metadata: { workflow: workflowName, entrypointId: requested },
      });
    }
    return { execution: definition };
  }

  const entrypointId = requested === undefined || requested === ""
    ? definition.defaultEntrypoint
    : requested;
  const entrypoint = definition.entrypoints.find((item) => item.id === entrypointId);
  if (entrypoint === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Unknown entrypoint "${entrypointId}" for workflow "${workflowName}".`,
      metadata: {
        workflow: workflowName,
        entrypointId,
        defaultEntrypoint: definition.defaultEntrypoint,
        allowedEntrypoints: definition.entrypoints.map((item) => item.id),
      },
    });
  }
  return {
    execution: entrypoint as ExecutionDefinition<unknown, unknown>,
    entrypointId: entrypoint.id,
    entrypointTitle: entrypoint.title,
  };
}

function createProjectTypeValidationMessage(reason: string): string {
  return `${reason}\n\nMigration example:\n${STEAMHARNESS_PROJECT_TYPE_MIGRATION_EXAMPLE}`;
}

function isConversationProjectType(projectType: ExecutorProjectType): boolean {
  switch (projectType) {
    case "conversation":
      return true;
    case "workflow":
      return false;
    default:
      return assertNeverWorkflowExecutorProjectType(projectType);
  }
}

function isWorkflowDefinition(
  value: unknown,
): value is Definition<unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Definition<unknown, unknown>).name === "string" &&
    typeof (value as Definition<unknown, unknown>).run === "function"
  );
}

interface ModuleNotFoundError extends Error {
  code: string;
}

function isModuleNotFoundError(error: unknown): error is ModuleNotFoundError {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
  );
}

function diagnoseModuleImportError(
  error: unknown,
  workflowDir: string,
  workflowName: string,
): HarnessError | null {
  if (!isModuleNotFoundError(error)) {
    return null;
  }

  const missingModule = parseMissingModuleName(error.message);
  if (missingModule === undefined) {
    return null;
  }

  const declaredDeps = readWorkflowDeclaredDependencies(workflowDir);

  if (declaredDeps.size > 0 && declaredDeps.has(missingModule)) {
    return new HarnessError({
      type: "workflow_execution",
      message: `Workflow "${workflowName}" depends on "${missingModule}" which is not installed. Run "pnpm install" in the workflow directory to install dependencies.`,
      metadata: { workflow: workflowName, missingModule },
    });
  }

  if (declaredDeps.size > 0) {
    return new HarnessError({
      type: "workflow_execution",
      message: `Module "${missingModule}" is required by workflow "${workflowName}" but was not found. Dependencies may not be installed. Run "pnpm install" in the workflow directory to install dependencies.`,
      metadata: { workflow: workflowName, missingModule },
    });
  }

  return null;
}

const MISSING_MODULE_PATTERN = /Cannot find (?:package|module) '([^']+)'/;

function parseMissingModuleName(message: string): string | undefined {
  const match = message.match(MISSING_MODULE_PATTERN);
  if (match === null) {
    return undefined;
  }

  const raw = match[1];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  return raw;
}

function readWorkflowDeclaredDependencies(workflowDir: string): Set<string> {
  const result = new Set<string>();
  let packageJson: unknown;

  try {
    packageJson = JSON.parse(
      readFileSync(path.join(workflowDir, "package.json"), "utf8"),
    );
  } catch {
    return result;
  }

  if (typeof packageJson !== "object" || packageJson === null) {
    return result;
  }

  const deps = packageJson as Record<string, unknown>;

  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const value = deps[key];
    if (typeof value !== "object" || value === null) {
      continue;
    }

    for (const packageName of Object.keys(value as Record<string, unknown>)) {
      result.add(packageName);
    }
  }

  return result;
}

function resolveWorkflowLocation(
  cwd: string,
  workflowName: string,
): { workflowDir: string; modulePath: string } {
  const workflowDir = path.resolve(cwd, "workspace", "workflow", workflowName);
  const modulePath = resolveWorkflowModulePath(cwd, workflowDir, workflowName);

  if (!existsSync(modulePath)) {
    throw new HarnessError({
      type: "input_validation",
      message: `Workflow "${workflowName}" does not exist.`,
      metadata: {
        workflow: workflowName,
        modulePath,
      },
    });
  }

  return { workflowDir, modulePath };
}

function resolveWorkflowModulePath(
  cwd: string,
  workflowDir: string,
  workflowName: string,
): string {
  const sourceModulePath = path.join(workflowDir, "index.ts");
  const workflowCompiledModulePath = path.join(workflowDir, "dist", "index.js");
  const compiledModulePath = path.resolve(
    cwd,
    "dist",
    "workspace",
    "workflow",
    workflowName,
    "index.js",
  );

  if (
    existsSync(sourceModulePath) &&
    isRunningCompiledExecutor() &&
    existsSync(workflowCompiledModulePath)
  ) {
    return workflowCompiledModulePath;
  }

  if (
    existsSync(sourceModulePath) &&
    isRunningCompiledExecutor() &&
    existsSync(compiledModulePath)
  ) {
    return compiledModulePath;
  }

  return sourceModulePath;
}

function resolveLocalWorkflowDir(workflowDir = "."): string {
  return path.resolve(process.cwd(), workflowDir);
}

function resolveLocalWorkflowModulePath(
  workflowDir: string,
  workflowName: string,
): string {
  const sourceModulePath = path.join(workflowDir, "index.ts");
  const modulePath = path.join(workflowDir, "index.js");
  const compiledModulePath = path.join(workflowDir, "dist", "index.js");

  for (const candidate of [sourceModulePath, modulePath, compiledModulePath]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new HarnessError({
    type: "input_validation",
    message: `Workflow "${workflowName}" does not have an index.ts or index.js entry.`,
    metadata: {
      workflow: workflowName,
      workflowDir,
    },
  });
}

function readLocalWorkflowName(workflowDir: string): string {
  const packageJsonPath = path.join(workflowDir, "package.json");

  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        name?: unknown;
      };

      if (typeof packageJson.name === "string" && packageJson.name.trim() !== "") {
        return packageJson.name.split("/").pop()?.replace(/-workflow$/, "") ?? packageJson.name;
      }
    } catch {
      return path.basename(workflowDir);
    }
  }

  return path.basename(workflowDir);
}

function readLocalPackageProjectType(workflowDir: string): "kanban" | undefined {
  const packageJsonPath = path.join(workflowDir, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    return readPackageProjectType(JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function isRegularKanbanArtifactEntry(workflowDir: string, artifactEntryPath: string): boolean {
  let currentPath = workflowDir;
  for (const segment of artifactEntryPath.split("/")) {
    currentPath = path.join(currentPath, segment);
    const entryStat = lstatSync(currentPath);
    if (entryStat.isSymbolicLink()) return false;
  }
  return lstatSync(currentPath).isFile();
}

function readLocalPackageJson(workflowDir: string): unknown {
  const packageJsonPath = path.join(workflowDir, "package.json");
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
  } catch {
    throw new HarnessError({
      type: "input_validation",
      message: `Project package.json is invalid JSON.`,
      metadata: { workflowDir },
    });
  }
}

function readWorkflowSchedulePresets(
  workflowDir: string,
  projectType: ExecutorProjectType,
  entrypoints: StructureReport["entrypoints"],
): SchedulePreset[] {
  return readSchedulePresetValue(readLocalPackageJson(workflowDir), projectType, entrypoints ?? []);
}

function readSchedulePresetValue(
  packageJson: unknown,
  projectType: ProjectKind,
  entrypoints: NonNullable<StructureReport["entrypoints"]>,
): SchedulePreset[] {
  const steamHarness = readOptionalRecordField(packageJson, "steamHarness");
  const value = steamHarness?.["schedulePresets"];
  if (value === undefined) return [];
  try {
    const presets = parseWorkflowSchedulePresets(value, projectType);
    const entrypointsById = new Map(entrypoints.map((entrypoint) => [entrypoint.id, entrypoint]));
    for (const preset of presets) {
      const entrypoint = entrypointsById.get(preset.entrypointId);
      if (entrypoint === undefined) {
        throw new Error(
          `steamHarness.schedulePresets entry "${preset.id}" references unknown entrypoint "${preset.entrypointId}".`,
        );
      }
      validateWorkflowScheduleParamValues(
        preset.paramValues,
        entrypoint.params ?? [],
        `steamHarness.schedulePresets entry "${preset.id}".paramValues`,
      );
    }
    return presets;
  } catch (error) {
    throw new HarnessError({
      type: "input_validation",
      message: `Project schedule preset validation failed: ${readErrorMessage(error)}`,
      metadata: { projectType },
    });
  }
}

function readOptionalRecordField(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  if (fieldValue === undefined) return undefined;
  if (fieldValue === null || typeof fieldValue !== "object" || Array.isArray(fieldValue)) {
    throw new HarnessError({
      type: "input_validation",
      message: `Project package.json ${field} must be an object.`,
    });
  }
  return fieldValue as Record<string, unknown>;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readKanbanStructureFiles(workflowDir: string, currentDir = workflowDir): string[] {
  return readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
      return readKanbanStructureFiles(workflowDir, absolutePath);
    }
    if (!entry.isFile()) return [];
    return [path.relative(workflowDir, absolutePath).split(path.sep).join("/")];
  }).sort((left, right) => left.localeCompare(right));
}

function assertLocalProjectIsExecutable(workflowDir: string, workflowName: string): void {
  if (readLocalPackageProjectType(workflowDir) !== "kanban") return;
  throw new HarnessError({
    type: "input_validation",
    message: createKanbanExecutionUnsupportedMessage(workflowName),
    metadata: { workflow: workflowName, projectType: "kanban" },
  });
}

function isRunningCompiledExecutor(): boolean {
  return fileURLToPath(import.meta.url).includes(`${path.sep}dist${path.sep}`);
}

function isExecutorCliEntrypoint(): boolean {
  const entryPath = process.argv[1];

  if (entryPath === undefined) {
    return false;
  }

  const resolvedEntryPath = path.resolve(entryPath);

  return resolvedEntryPath === fileURLToPath(import.meta.url);
}

if (isExecutorCliEntrypoint()) {
  disableAiSdkWarningLogs();
  void runExecutorCli();
}

function disableAiSdkWarningLogs(): void {
  (globalThis as typeof globalThis & {
    AI_SDK_LOG_WARNINGS?: false;
  }).AI_SDK_LOG_WARNINGS = false;
}

async function runExecutorCli(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "--structure") {
    runStructureCli(removeCliFlags(argv.slice(1), ["--json"]));
    return;
  }

  const parsed = parseExecutorCliArgs(argv);
  const report = await runWorkspaceWorkflowReportFromCli(parsed.argv, {
    nodeHooks: parsed.json ? undefined : createCliOutputStreamHooks(),
  });

  if (parsed.json) {
    console.log(formatWorkflowExecutionJson(report));
  } else if (report.status === "failed") {
    console.error(formatWorkflowExecutionJson(report));
  }

  process.exitCode = report.status === "success" ? 0 : 1;
}

function parseExecutorCliArgs(argv: string[]): {
  argv: string[];
  json: boolean;
} {
  let json = false;
  const filteredArgv: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      filteredArgv.push(...argv.slice(index));
      break;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    filteredArgv.push(arg);
  }

  return {
    argv: removePnpmRunSeparator(filteredArgv),
    json,
  };
}

function removePnpmRunSeparator(argv: string[]): string[] {
  const separatorIndex = argv.indexOf("--");

  if (separatorIndex <= 0) {
    return argv;
  }

  return [
    ...argv.slice(0, separatorIndex),
    ...argv.slice(separatorIndex + 1),
  ];
}

function removeCliFlags(argv: string[], flags: string[]): string[] {
  return argv.filter((arg) => !flags.includes(arg));
}

export function createCliOutputStreamHooks(): NodeExecutionHooks {
  const streamedOutputExecutionIds = new Set<string>();

  return {
    onNodeChunk(event) {
      if (event.nodeName !== "output") {
        return;
      }

      streamedOutputExecutionIds.add(event.executionId);
      const content = formatCliOutputChunk(event.chunk);
      if (content !== "") {
        process.stdout.write(content);
      }
    },
    onNodeFinish(event) {
      if (event.nodeName !== "output") {
        return;
      }

      if (!streamedOutputExecutionIds.has(event.executionId)) {
        const content = formatCliOutputContent(event.output);

        if (content !== "") {
          process.stdout.write(content);
        }
      }

      process.stdout.write("\n");
    },
  };
}

export function formatCliOutputContent(output: unknown): string {
  if (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    Array.isArray((output as { items?: unknown }).items)
  ) {
    return (output as { items: unknown[] }).items
      .map(formatCliOutputItem)
      .filter((item) => item !== "")
      .join("\n");
  }

  if (output === undefined || output === null) {
    return "";
  }

  if (typeof output === "string") {
    return output;
  }

  if (
    typeof output === "number" ||
    typeof output === "boolean" ||
    typeof output === "bigint"
  ) {
    return String(output);
  }

  return JSON.stringify(output, null, 2);
}

function formatCliOutputChunk(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (!isOutputItemStreamChunk(chunk)) {
    return "";
  }

  if (chunk.type === "output_item_start") {
    const title = chunk.item.title.trim() || "Output";
    return `\n${title}\n`;
  }

  if (chunk.type === "output_item_delta") {
    return formatCliOutputContent(chunk.delta);
  }

  return "\n";
}

function formatCliOutputItem(item: unknown): string {
  if (
    typeof item === "object" &&
    item !== null &&
    !Array.isArray(item) &&
    typeof (item as { title?: unknown }).title === "string"
  ) {
    const title = (item as { title: string }).title.trim();
    const content = formatCliOutputContent((item as { content?: unknown }).content);
    return title === "" ? content : `${title}\n${content}`;
  }

  return formatCliOutputContent(item);
}

function runStructureCli(argv: string[]): void {
  try {
    const report = inspectWorkspaceWorkflowStructureFromCli(argv);

    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.log(formatWorkflowStructureError(error, argv[0]));
    process.exitCode = 1;
  }
}

function formatWorkflowStructureError(
  error: unknown,
  workflowName: string | undefined,
): string {
  return JSON.stringify(
    {
      workflow: {
        name: workflowName ?? "",
      },
      definitions: {
        nodes: {},
        apiCalls: [],
        variables: {},
      },
      execution: {
        kind: "sequence",
        children: [],
      },
      diagnostics: {
        warnings: [],
        violations: [],
        error: createWorkflowFailure(error).error,
      },
    },
    null,
    2,
  );
}

function createExecutorFileStore(options: {
  env?: NodeJS.ProcessEnv;
  workflowName: string;
  conversationId?: string;
  fileStore?: FileStore;
  fileStoreDir?: string;
  fileCreateStoreDir?: string;
}): FileStore {
  const resolveStore = options.fileStore ?? createLocalResolveFileStore(options.fileStoreDir);

  if (options.fileStore?.createFile !== undefined) {
    return options.fileStore;
  }

  const createRoot = options.fileCreateStoreDir?.trim();
  if (createRoot !== undefined && createRoot !== "") {
    const createStore = createServerWorkflowFileStore({
      rootDir: createRoot,
      workflowName: options.workflowName,
      conversationId: options.conversationId,
    });
    return createWorkflowFileStore({
      resolveStore,
      createFile: (input) => createStore.createFile!(input),
    });
  }

  const remoteStore = createRemoteWorkflowFileStoreFromEnv({
    env: options.env,
    workflowName: options.workflowName,
    conversationId: options.conversationId,
  });
  if (remoteStore !== undefined) {
    return createWorkflowFileStore({
      resolveStore,
      createFile: (input) => remoteStore.createFile!(input),
    });
  }

  return createWorkflowFileStore({ resolveStore });
}

function createLocalResolveFileStore(
  rootDir: string | undefined,
): FileStore {
  if (rootDir === undefined || rootDir.trim() === "") {
    return createLocalWorkflowFileStore({ allowAbsolutePaths: true });
  }

  return createLocalWorkflowFileStore({
    rootDir,
    allowAbsolutePaths: true,
  });
}

function createChainedAbortController(abortSignal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();

  if (abortSignal === undefined) {
    return controller;
  }

  if (abortSignal.aborted) {
    controller.abort(abortSignal.reason);
    return controller;
  }

  // Local workflow runs now accept a parent abort signal so app
  // conversation cancel can propagate into workflow context and SDK calls.
  abortSignal.addEventListener(
    "abort",
    () => controller.abort(abortSignal.reason),
    { once: true },
  );
  return controller;
}

function throwIfRunLocalWorkflowAborted(signal: AbortSignal, workflowName: string): void {
  if (!signal.aborted) {
    return;
  }

  throw new HarnessError({
    type: "execution_aborted",
    message: signal.reason instanceof Error
      ? signal.reason.message
      : `Workflow "${workflowName}" execution was aborted.`,
    metadata: {
      workflow: workflowName,
      reason: "abort",
    },
    cause: signal.reason,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
