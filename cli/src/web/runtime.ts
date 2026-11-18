import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LLMBotModelRequestSnapshot, UserSettings } from 'steamharness';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { STEAMHARNESS_RUNTIME_LOCALE_ENV, createLocalProjectConfigurationStore, type ProjectConfigurationSnapshot } from 'steamharness';
import { locale } from './localization';
import { redactProjectData, type Runtime, type Report, type Project } from './workflow-types';

import type { AgentSessionCommand, AgentSessionReceipt } from 'steamharness/agent';
import { createSecretStreamRedactor } from './runtime-log';
import { KANBAN_FILE_BRIDGE_REQUEST_TIMEOUT_MS } from '@steamharness/kanban-project';
import type { AggregateEntryCall } from './entry-conversations';
import { CLI_VERSION } from '../version';

// Set by the Studio launcher for its private stdio host, not by page requests.
export const WEB_HOST_ENV = 'STEAMHARNESS_WEB_HOST';

export interface WebConnection {
  serverUrl: string;
  accessToken: string;
  /** Independent private system-AI connection, never used for project APIs. */
  aiServerUrl?: string;
  aiAccessToken?: string;
}

export function cliRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    try { if (JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')).name === '@steamharness/cli') { return directory; } } catch {}
    directory = path.dirname(directory);
  }
  throw new Error('Cannot locate the CLI installation.');
}

export function createWebRuntime(projectDir: string, storageDir: string, connection: () => Partial<WebConnection> | undefined,
  options: { entryId?: string; hostKind?: 'cli-web' | 'studio'; allowSystemAi?: boolean; actor?: () => import('@steamharness/project-access').AccessActor; userSettings?: () => UserSettings | undefined; entryRuntime?(call: AggregateEntryCall): Promise<unknown> } = {}): Runtime {
  const runtimeHost = { kind: options.hostKind ?? 'cli-web', cliVersion: CLI_VERSION };
  const root = cliRoot();
  const builtWorker = path.join(root, 'dist/web/worker.mjs');
  const worker = existsSync(builtWorker) ? builtWorker : path.join(root, 'src/web/worker.mjs');
  const children = new Set<ChildProcess>();
  const active = new Map<string, ChildProcess>();
  const controls = new Map<string, (command: AgentSessionCommand, scopeId: string, attachments?: unknown[]) => Promise<AgentSessionReceipt>>();
  const runCancellation = new Map<string, AbortController>();
  let disposed = false;
  const configurationStores = new Map<string, ReturnType<typeof createLocalProjectConfigurationStore>>();
  const configurations = (entryId = options.entryId) => {
    const key = entryId ?? "default";
    let store = configurationStores.get(key);
    if (!store) { store = createLocalProjectConfigurationStore(projectDir, { entryId, connection: () => {
      const auth = connection(); return auth?.serverUrl && auth.accessToken ? { serverUrl: auth.serverUrl, accessToken: auth.accessToken } : null;
    }, userSettings: options.userSettings }); configurationStores.set(key, store); }
    return store;
  };
  const invoke = <T>(request: Record<string, unknown>, onEvent?: (event: Record<string, unknown>) => void,
    onModelRequest?: (request: LLMBotModelRequestSnapshot) => void): Promise<T> => new Promise((resolve, reject) => {
    if (disposed) { reject(new Error('Web runtime has stopped.')); return; }
    const auth = connection();
    const actor = options.actor?.() ?? { isSystemAdmin: false };
    const runtimeAuth = options.allowSystemAi === false && auth
      ? { serverUrl: auth.serverUrl, accessToken: auth.accessToken }
      : auth;
    const userSettings = request.userSettings as UserSettings | undefined ?? options.userSettings?.();
    const secrets = [runtimeAuth?.accessToken ?? '', runtimeAuth?.aiAccessToken ?? '', ...(userSettings?.agent.models ?? []).flatMap(model => model.source === 'third-party' ? [model.apiKey] : [])];
    // Workers use the verified page identity, including after logout.
    const env: NodeJS.ProcessEnv = sanitizeWebWorkerEnvironment(process.env);
    Object.assign(env, { STEAMHARNESS_RUNTIME_PLATFORM: 'cli',
      [STEAMHARNESS_RUNTIME_LOCALE_ENV]: locale(), STEAMHARNESS_LOCALE: locale(),
      STEAMHARNESS_SERVER_URL: runtimeAuth?.serverUrl ?? '', STEAMHARNESS_SERVER_ADMIN_KEY: runtimeAuth?.accessToken ?? '', STEAMHARNESS_SERVER_TOKEN: '',
      STEAMHARNESS_AI_SERVER_URL: runtimeAuth?.aiServerUrl ?? '', STEAMHARNESS_AI_API_KEY: runtimeAuth?.aiAccessToken ?? '',
      STEAMHARNESS_CLI_AUTH_DIR: path.join(storageDir, 'runtime-auth'),
    });
    delete env.STEAMHARNESS_LLM_SERVER_URL;
    delete env.STEAMHARNESS_LLM_SERVER_TOKEN;
    delete env[WEB_HOST_ENV];
    for (const key of ['TSX_TSCONFIG_PATH', 'STEAMHARNESS_LOCAL_HARNESS_ROOT', 'STEAMHARNESS_LOCAL_SHARED_ROOT', 'STEAMHARNESS_LOCAL_SOURCE_MODE',
      'STEAMHARNESS_DEVELOPER_ASSISTANT_HOST', 'STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR', 'STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST']) { delete env[key]; }
    if (env.NODE_OPTIONS) { env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/(?:--conditions=development|--conditions\s+development|-C=development|-C\s+development)/g, ''); }
    const child = spawn(process.execPath, [worker], { cwd: projectDir, env, shell: false, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    children.add(child);
    if (request.method === 'run') { active.set(String(request.runId), child); }
    const pending = new Map<string, { resolve(value: AgentSessionReceipt): void; reject(error: Error): void }>();
    if (request.method === 'run') controls.set(String(request.runId), (command, scopeId, attachments) => new Promise((resolve, reject) => {
      const send=()=>{const id = globalThis.crypto.randomUUID(); pending.set(id, { resolve, reject });
      child.send({ type: 'agent-control', id, command, scopeId, attachments }, error => {
        if (error) { pending.delete(id); reject(Object.assign(error, { code: 'STEAMHARNESS_WORKER_INTERRUPTED' })); }
      });};
      const configuration=request.configuration as ProjectConfigurationSnapshot|undefined;
      if(command.type==='cancel'||command.type==='fork'||!configuration?.profilePolicyVersion)send();
      else void configurations((request.project as Project)?.entryId).then(store=>store.snapshot({configuration,required:false})).then(send,reject);
    }));
    child.on('message', (message: any) => {
      if (message?.type === 'entry-runtime' && typeof message.id === 'string') {
        const call = message.call;
        const current = request.project as Project | undefined;
        const perform = async () => {
          if (!options.entryRuntime || !current || !call || typeof call.entryId !== 'string'
            || !['list', 'submit', 'snapshot', 'resolveInput', 'cancel', 'resumeQueue'].includes(call.action)
            || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) throw new Error('Conversation entry control is unavailable.');
          const abortSignal = runCancellation.get(String(request.runId))?.signal;
          abortSignal?.throwIfAborted();
          if (disposed || !child.connected) throw new Error("The entry caller disconnected.");
          // The parent derives provenance from the admitted worker, never its payload.
          return options.entryRuntime({ entryId: call.entryId, action: call.action, input: call.input,
            sourceEntryId: current.entryId, projectId: current.id, actor, abortSignal,
            sourceRunId: typeof request.runId === 'string' ? request.runId : undefined,
            sourceConversationId: typeof request.conversationId === 'string' ? request.conversationId : undefined });
        };
        void perform().then(value => { if (child.connected) child.send({ type: 'entry-runtime-result', id: message.id, value }); },
          error => { if (child.connected) child.send({ type: 'entry-runtime-result', id: message.id, error: String(error.message) }); });
        return;
      }
      if (message?.type !== 'agent-receipt' || typeof message.id !== 'string') return;
      const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id);
      if (message.error) waiter.reject(Object.assign(new Error(String(message.error)), { code: message.code, status: message.status }));
      else waiter.resolve(message.receipt);
    });
    let buffer = '', stderr = '', failure: string | undefined;
    let failureMetadata: Record<string, unknown> | undefined;
    let failureCode: string | undefined;
    let result: T | undefined;
    // Runs wait for completion or explicit cancellation without a wall-clock deadline.
    const fileBridge = request.method === 'kanban-bridge' && (request.call as { operation?: string } | undefined)?.operation?.startsWith('files.');
    const requestTimeout = fileBridge ? KANBAN_FILE_BRIDGE_REQUEST_TIMEOUT_MS : 30_000;
    const timeout = request.method === 'run' ? undefined : setTimeout(() => {
      failure = 'Workflow runtime request timed out.';
      if (request.method === 'kanban-bridge') failureCode = 'KANBAN_BRIDGE_TIMEOUT';
      child.kill('SIGTERM');
    }, requestTimeout);
    const forcedExit = request.method === 'run' ? undefined : setTimeout(() => child.kill('SIGKILL'), requestTimeout + 5_000);
    child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
    const redactStderr = createSecretStreamRedactor(secrets);
    const emitStderr = (chunk: string, final = false) => {
      const text = String(redactProjectData(redactStderr(chunk, final), secrets));
      if (!text) return;
      stderr = (stderr + text).slice(-100_000);
      onEvent?.({ type: 'runtime_log', text, runId: request.runId });
    };
    child.stderr!.on('data', (chunk: string) => emitStderr(chunk));
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.startsWith('__STEAMHARNESS_WEB__')) { continue; }
        try {
          const message = redactProjectData(JSON.parse(line.slice('__STEAMHARNESS_WEB__'.length)), secrets, false) as { kind: string; value: T & Record<string, unknown>; error?: string; code?: string; metadata?: Record<string, unknown> };
          if (message.kind === 'event') { onEvent?.(message.value); }
          if (message.kind === 'model-request') { onModelRequest?.(message.value as unknown as LLMBotModelRequestSnapshot); }
          if (message.kind === 'result') { result = message.value; }
          if (message.kind === 'error') { failure = message.error; failureMetadata = message.metadata; failureCode = typeof message.code === 'string' ? message.code : undefined; }
        } catch { failure = 'Invalid workflow runtime response.'; }
      }
    });
    const cleanup = () => {
      clearTimeout(timeout); clearTimeout(forcedExit); children.delete(child);
      if (active.get(String(request.runId)) === child) { active.delete(String(request.runId)); controls.delete(String(request.runId)); }
      for (const waiter of pending.values()) waiter.reject(Object.assign(new Error('The agent owner disconnected.'), { code: 'STEAMHARNESS_WORKER_INTERRUPTED' }));
      pending.clear();
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      emitStderr('', true);
      cleanup();
      if (failure) { reject(Object.assign(new Error(failure), { code: failureCode, metadata: failureMetadata })); }
      else if (result !== undefined) { if (request.method === 'run') { (result as Report).logs = String(redactProjectData(stderr, secrets)); } resolve(result); }
      else { reject(Object.assign(new Error(String(redactProjectData(stderr.trim(), secrets)) || `Workflow runtime exited (${signal ?? code}).`),
        { code: 'STEAMHARNESS_WORKER_INTERRUPTED' })); }
    });
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(JSON.stringify({ ...request, userSettings, storageDir, runtimeProjectDir: projectDir, entryId: (request.project as Project)?.entryId ?? request.entryId ?? options.entryId,
      actor, runtimeHost, captureModelRequest: Boolean(onModelRequest) }));
  });
  const invokeRun = async (request: Record<string, unknown>, onEvent: (event: Record<string, unknown>) => void, signal: AbortSignal,
    onModelRequest?: (request: LLMBotModelRequestSnapshot) => void): Promise<Report> => {
    // A replacement host can start before its orphaned worker finishes cleanup.
    // Wait only for the storage owner of the original recovering request. Never
    // retry admission conflicts or steal a live owner's lock.
    const deadline = Date.now() + 35_000;
    while (true) {
      signal.throwIfAborted();
      try {
        const report = await invoke<Report>({ method: 'run', ...request }, onEvent, onModelRequest);
        if (disposed || !request.resumeConfiguration && !request.resumeAgent || !agentOwnerConflict(report) || Date.now() >= deadline) return report;
      } catch (error) {
        if (disposed || !request.resumeConfiguration && !request.resumeAgent || !agentOwnerConflict(error) || Date.now() >= deadline) throw error;
      }
      await delay(500, undefined, { signal });
    }
  };
  return {
    available: true,
    listSkills: (project, entrypointId) => invoke({ method: 'skills', project, entrypointId }),
    readSkill: (project, skillId, entrypointId) => invoke({ method: 'skills', project, entrypointId, skillId }),
    agentControl: async (runId, command, scopeId, attachments) => {
      const control = controls.get(runId);
      if (!control) throw Object.assign(new Error('The agent session is not ready.'), { code: 'AGENT_NOT_READY' });
      return control(command, scopeId, attachments);
    },
    forkAgentConversation: (project, conversationId, command) => invoke({ method: 'fork-conversation', project, conversationId, command }),
    isolateAgentConversation: (project, sourceConversationId, conversationId, targetId, retireSource, fileIds) => invoke({ method: 'isolate-conversation', project, sourceConversationId, conversationId, targetId, retireSource, fileIds }),
    inspect: (paths, entryId) => invoke({ method: 'inspect', paths, entryId }),
    resolveParams: (project, request, entrypointId) => invoke({ method: 'resolve', project, request, entrypointId }),
    resolveLiveInput: (runId, { requestId, values, submittedAt }) => new Promise((resolve, reject) => {
      const child = active.get(runId);
      if (!child?.connected || runCancellation.get(runId)?.signal.aborted) { reject(new Error('The run is no longer waiting for input.')); return; }
      child.send({ type: 'live-input', input: { requestId, values, submittedAt } }, error => error ? reject(error) : resolve());
    }),
    run: async (request, onEvent, onModelRequest) => {
      const runId = String(request.runId), cancellation = new AbortController();
      runCancellation.set(runId, cancellation);
      const { abortSignal, ...serializable } = request;
      const stop = () => { cancellation.abort(abortSignal?.reason);
        const child = active.get(runId);
        if (child) { child.kill('SIGTERM'); const timer = setTimeout(() => { if (children.has(child)) child.kill('SIGKILL'); }, 5_000); timer.unref(); }
      };
      abortSignal?.addEventListener('abort', stop, { once: true });
      try {
        abortSignal?.throwIfAborted();
        if(!request.configurationSelection)return await invokeRun({...serializable},onEvent,cancellation.signal,onModelRequest);
        const selection=request.configurationSelection;
        const configuration=await (await configurations(request.project.entryId)).snapshot({id:selection.id,runId:request.configurationRunId??request.runId,requireExisting:request.resumeConfiguration});
        if(configuration.accessSubject!==selection.subject||configuration.profileKey!==selection.profileKey)throw new Error('This run configuration is not available to this account.');
        return await invokeRun({...serializable,configuration},onEvent,cancellation.signal,onModelRequest);
      } finally { abortSignal?.removeEventListener('abort', stop); if (runCancellation.get(runId) === cancellation) runCancellation.delete(runId); }
    },
    uploadFiles: (project, conversationId, files) => invoke({ method: 'upload', project, conversationId, files }),
    readFile: (project, id) => invoke({ method: 'file', project, id }),
    deleteFiles: async (project, conversationId, ids) => { await invoke({ method: 'delete-files', project, conversationId, ids }); },
    deleteConversation: async (project, conversationId) => { await invoke({ method: 'delete-conversation', project, conversationId }); },
    cancelConversation: async (project, conversationId) => { await invoke({ method: 'cancel-conversation', project, conversationId }); },
    cancel: (runId) => {
      for (const cancellation of runId ? [runCancellation.get(runId)] : runCancellation.values()) cancellation?.abort(new Error('Stopped.'));
      const running = runId ? [active.get(runId)].filter((child): child is ChildProcess => !!child) : [...active.values()];
      for (const child of running) { child.kill('SIGTERM'); const timer = setTimeout(() => { if (children.has(child)) { child.kill('SIGKILL'); } }, 5_000); timer.unref(); }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const cancellation of runCancellation.values()) cancellation.abort(new Error('Web runtime has stopped.'));
      for (const child of children) {
        // Let the worker close its IPC channel after parking the run. Closing
        // both ends concurrently can leave ChildProcess's close event pending.
        if (child.connected) child.send({ type: 'shutdown' }, error => { if (error) child.kill('SIGTERM'); });
        else child.kill('SIGTERM');
        const timer = setTimeout(() => { if (children.has(child)) child.kill('SIGKILL'); }, 5_000); timer.unref();
        child.once('close', () => clearTimeout(timer));
      }
    },
  };
}

function agentOwnerConflict(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  const error = value as Record<string, any>;
  return error.code === 'RUNTIME_STORAGE_OWNER_CONFLICT' || error.metadata?.code === 'RUNTIME_STORAGE_OWNER_CONFLICT' || error.metadata?.agentFailure === 'owner_conflict' || ['cause', 'error', 'result'].some(key => agentOwnerConflict(error[key], depth + 1));
}

/**
 * Project code runs in a separate worker and must not inherit the Studio or
 * host process's deployment credentials. The scoped project and optional
 * assistant connections are added explicitly above.
 */
export function sanitizeWebWorkerEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(base).filter(([key, value]) => value !== undefined && !isPrivateEnvironmentKey(key)));
  return environment;
}

/**
 * Studio Control is a per-session capability the host injects only when it has
 * opened a control bridge. The assistant project reads these values once and
 * removes them before spawning coding tools, so the worker must receive all
 * three together; the generic TOKEN rule would otherwise strip only the token
 * and leave the MCP definition pointing at an unusable capability.
 */
const STUDIO_CONTROL_CAPABILITY_KEYS = new Set([
  'STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER',
  'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL',
  'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN',
]);

function isPrivateEnvironmentKey(key: string): boolean {
  if (STUDIO_CONTROL_CAPABILITY_KEYS.has(key)) { return false; }
  return key === 'NODE_OPTIONS' ||
    /^(?:STEAMHARNESS_(?:AI|LLM|SERVER|PUBLIC_SERVER|FILE_SERVER|STUDIO_INTERNAL)(?:_|$)|SUB2API_)/iu.test(key) ||
    /(?:^|_)(?:API[_-]?KEY|ACCESS[_-]?KEY(?:_ID)?|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY|DATABASE_URL|REDIS_URL|CREDENTIALS?|AUTH(?:ORIZATION)?|CONFIG)(?:$|_)/iu.test(key) ||
    /^(?:DOCKER_CONFIG|KUBECONFIG|SSH_AUTH_SOCK|GIT_(?:CONFIG|SSH|ASKPASS)|NPM_CONFIG_USERCONFIG|PIP_CONFIG_FILE|CARGO_HOME|AZURE_CONFIG_DIR)$/u.test(key);
}
