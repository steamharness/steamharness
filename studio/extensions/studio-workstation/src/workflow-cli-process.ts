import { openWebApp, type WebAppSession } from "./web-app-providers";
import { webAppFailureReason, type WebAppFailureReason } from "./web-app-errors";
import { t, locale as currentLocale } from './localization';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { Connection } from './workflow-auth-client';
import { sanitizeProjectEnvironment } from './workflow-auth-client';
import type { Project } from './workflow-types';
import type { WebReady, WebSession, WebSessionExit } from './workflow-cli-types';
import type { StudioUserSettings } from './user-settings';
import { nodeRuntimeEnvironment, type NodeRuntime } from './node-runtime';

export interface StudioControlConfiguration { mcpServer?: string; url: string; token: string }

function hostAuthentication(connection: Connection | undefined, ai: Connection | undefined) {
  return { connection: connection ? { serverUrl: connection.serverUrl, accessToken: connection.accessToken } : null,
    ...(ai ? { systemAiConnection: { serverUrl: ai.serverUrl, accessToken: ai.accessToken } } : {}) };
}

export async function resolveProjectCli(projectDir: string): Promise<{ entry: string; version: string }> {
  const directory = await realpath(projectDir);
  let manifestPath: string | undefined;
  // Node caches resolved package symlinks across pnpm reinstalls in a long-lived host.
  for (const modules of createRequire(path.join(directory, 'package.json')).resolve.paths('@steamharness/cli') ?? []) {
    try { manifestPath = await realpath(path.join(modules, '@steamharness/cli/package.json')); break; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; } }
  }
  if (!manifestPath) { throw new Error(t("The project has no @steamharness/cli installed. Install project dependencies first: {0}", directory)); }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['steamharness'];
  if (manifest.name !== '@steamharness/cli' || typeof bin !== 'string') { throw new Error('The project CLI has no steamharness executable.'); }
  const entry = await realpath(path.resolve(path.dirname(manifestPath), bin)).catch(() => { throw new Error(t("Project CLI is not built: {0}", manifestPath)); });
  return { entry, version: manifest.version };
}

export function createProjectCliEnvironment(base: NodeJS.ProcessEnv = process.env, studioControl?: StudioControlConfiguration, runtime?: NodeRuntime, authRoot?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = sanitizeProjectEnvironment(runtime ? nodeRuntimeEnvironment(runtime, base) : base);
  if (!runtime) env.ELECTRON_RUN_AS_NODE = '1';
  for (const key of ['TSX_TSCONFIG_PATH', 'STEAMHARNESS_LOCAL_HARNESS_ROOT', 'STEAMHARNESS_LOCAL_SHARED_ROOT', 'STEAMHARNESS_LOCAL_SOURCE_MODE',
    'STEAMHARNESS_DEVELOPER_ASSISTANT_HOST', 'STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR', 'STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST',
    'STEAMHARNESS_AI_SERVER_URL', 'STEAMHARNESS_AI_API_KEY', 'STEAMHARNESS_LLM_SERVER_URL', 'STEAMHARNESS_LLM_SERVER_TOKEN',
    'STEAMHARNESS_STUDIO_INTERNAL', 'STEAMHARNESS_STUDIO_INTERNAL_MODULE', 'STEAMHARNESS_STUDIO_INTERNAL_SERVER_URL',
    'STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN',
    'STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY',
    'STEAMHARNESS_DESKTOP_CONTROL_MCP_SERVER', 'STEAMHARNESS_DESKTOP_CONTROL_PROXY_URL', 'STEAMHARNESS_DESKTOP_CONTROL_PROXY_TOKEN',
    'STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL', 'STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN']) { delete env[key]; }
  // Old project CLIs/Core may read the desktop and CLI auth files even when
  // the host explicitly sends no account. Point both at host-owned paths.
  if (authRoot) {
    env.STEAMHARNESS_CLI_AUTH_DIR = path.join(authRoot, 'cli');
    env.STEAMHARNESS_DESKTOP_CONFIG_DIR = path.join(authRoot, 'desktop');
  }
  if (studioControl) {
    if (studioControl.mcpServer) { env.STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER = studioControl.mcpServer; }
    env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL = studioControl.url;
    env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN = studioControl.token;
  }
  return env;
}

function environment(studioControl?: StudioControlConfiguration, runtime?: NodeRuntime, authRoot?: string): NodeJS.ProcessEnv {
  return createProjectCliEnvironment(process.env, studioControl, runtime, authRoot);
}

export async function inspectProjectCli(projectDir: string, nodePath: string, signal?: AbortSignal, assistantProjectDir?: string, assistant?: Project['assistant'], locale = 'en', validationDetails = false, runtime?: NodeRuntime, authRoot?: string): Promise<{ projects: Omit<Project, 'uri'>[]; errors: string[] }> {
  const { entry } = await resolveProjectCli(projectDir);
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [entry, '--locale', locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en', 'web', projectDir, '--inspect', '--json', '--no-open', ...(assistantProjectDir ? ['--host-stdio'] : [])], { cwd: projectDir, env: environment(undefined, runtime, authRoot), shell: false, stdio: ['pipe', 'pipe', 'pipe'], signal });
    child.stdin.on('error', () => undefined);
    child.stdin.end(assistantProjectDir ? `${JSON.stringify({ type: 'configure', surface: 'assistant', assistantProjectDir,
      assistant: assistant ?? { workdir: projectDir, roots: [{ uri: `file://${projectDir}`, folderPath: projectDir, name: path.basename(projectDir) }] } })}\n` : undefined);
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) { child.kill('SIGKILL'); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', async code => {
      clearTimeout(timer);
      try {
        if (code !== 0) { throw new Error(stderr.trim() || `Project CLI exited (${code}).`); }
        const result = JSON.parse(stdout);
        if (!Array.isArray(result.projects) || !Array.isArray(result.errors)) { throw new Error('Invalid project CLI inspection response.'); }
        if (assistantProjectDir && result.assistantProtocolVersion !== 1) {
          throw new Error(t("The standalone Assistant CLI is incompatible. Update its @steamharness/cli."));
        }
        if (validationDetails && result.errors.some((error: unknown) => typeof error === 'string' && /script validation failed/.test(error))) {
          // Older published CLIs omit Core's structured violations from web inspection.
          const args = [entry, '--locale', locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en', 'structure', projectDir];
          const diagnostic = await promisify(execFile)(nodePath, args, { cwd: projectDir, env: environment(undefined, runtime, authRoot), signal,
            timeout: 30_000, maxBuffer: 2_000_000, windowsHide: true }).catch((error: Error & { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
          signal?.throwIfAborted();
          try {
            const report = JSON.parse(diagnostic.stdout);
            const violations = report.diagnostics?.error?.metadata?.violations ?? report.diagnostics?.violations ?? [];
            const details = violations.map((violation: { message?: string }) => violation.message).filter((message: unknown): message is string => typeof message === 'string');
            for (const detail of new Set<string>(details)) { if (!result.errors.some((error: string) => error.includes(detail))) { result.errors.push(detail); } }
          } catch { /* Preserve the original inspection error if no structured diagnostics are available. */ }
        }
        resolve({ ...result, projects: result.projects.map((project: Omit<Project, 'uri'>) => ({ ...project, folderPath: path.resolve(assistantProjectDir ?? projectDir) })) });
      } catch (error) { reject(error); }
    });
  });
}

export async function startProjectCli(options: {
  projectDir: string; dataDir: string; nodePath: string; theme: 'dark' | 'light'; locale?: string; port?: number;
  surface: 'editor' | 'assistant'; platform?: boolean; assistant?: Project['assistant']; signal?: AbortSignal;
  authRoot?: string;
  assistantProjectDir?: string;
  expectedProjectId?: string;
  webAppEntries?: import("@steamharness/project-manifest").ProjectEntry[];
  entryId: string;
  resourceProjects?: string[];
  studioControl?: StudioControlConfiguration;
  userSettings?: StudioUserSettings;
  runtime?: NodeRuntime;
}): Promise<WebSession> {
  const { entry } = await resolveProjectCli(options.projectDir);
  options.signal?.throwIfAborted();
  const authentication = hostAuthentication(undefined, undefined);
  const child: ChildProcess = spawn(options.nodePath, [entry, '--locale', options.locale?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en', 'web', options.projectDir, '--entry', options.entryId, '--port', String(options.port ?? 0), '--no-open', '--json', '--theme', options.theme, '--host-stdio', '--data-dir', options.dataDir],
    { cwd: options.projectDir, env: { ...environment(options.studioControl, options.runtime, options.authRoot), STEAMHARNESS_WEB_HOST: 'studio' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
  const events = new EventEmitter();
  const secrets = new Set([options.studioControl?.token].filter((token): token is string => !!token));
  const rememberModels = (settings?: StudioUserSettings) => { for (const model of settings?.agent.models ?? []) if (model.source === 'third-party') secrets.add(model.apiKey); };
  rememberModels(options.userSettings);
  const cleanError = (message: string): string => { for (const token of secrets) { message = message.replaceAll(token, '[redacted]'); } return message; };
  let finishClose!: () => void;
  const closed = new Promise<void>(resolve => { finishClose = resolve; });
  let closing = false, finished = false, buffer = '', stderr = '';
  let webAppFailure: WebAppFailureReason | undefined;
  let webAppEpoch = 0, webAppAbort: AbortController | undefined;
  let webAppSessions: WebAppSession[] = [];
  const clearWebApps = () => { ++webAppEpoch; webAppFailure = undefined; webAppAbort?.abort(); const sessions = webAppSessions; webAppSessions = []; for (const session of sessions) void Promise.resolve(session.dispose()).catch(() => undefined); };
  const refreshWebApps = async (entryId?: string, connection?: Connection) => {
    clearWebApps();
    if (closing || finished) return;
    child.stdin?.write(`${JSON.stringify({ type: 'web-apps', webApps: {} })}\n`);
    const entry = options.webAppEntries?.find(entry => entry.entryId === entryId);
    if (!connection || !options.expectedProjectId || !entry?.webApp) return;
    const epoch = webAppEpoch, abort = webAppAbort = new AbortController();
    const sessions: WebAppSession[] = [];
    try {
      const bindings: Record<string, unknown> = {};
      const session = await openWebApp({ projectId: options.expectedProjectId, entryId: entry.entryId, service: entry.webApp.service, connection, signal: abort.signal });
      sessions.push(session); bindings[entry.entryId] = session.binding;
      if (closing || finished || epoch !== webAppEpoch) { for (const session of sessions) void Promise.resolve(session.dispose()).catch(() => undefined); return; }
      webAppSessions = sessions;
      child.stdin?.write(`${JSON.stringify({ type: 'web-apps', webApps: bindings })}\n`);
    } catch (error) {
      for (const session of sessions) void Promise.resolve(session.dispose()).catch(() => undefined);
      if (!abort.signal.aborted) { webAppFailure = webAppFailureReason(error); events.emit('web-app-error', webAppFailure); }
    }
  };
  let exit: WebSessionExit | undefined;
  const diagnostics = () => cleanError(stderr).slice(-8_000).trim();
  let resourceProjectsKey = JSON.stringify(options.resourceProjects ?? []);
  let connectionKey = JSON.stringify(authentication);
  let userSettingsKey = JSON.stringify(options.userSettings);
  let force: ReturnType<typeof setTimeout> | undefined;
  const close = (): Promise<void> => {
    if (!closing && !finished) {
      closing = true; clearWebApps();
      child.stdin?.end(`${JSON.stringify({ type: 'close' })}\n`);
      force = setTimeout(() => child.kill('SIGKILL'), 5_000);
      force.unref();
    }
    return closed;
  };
  child.stdin?.on('error', () => undefined);
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => {
    // Keep enough context to redact a credential spanning a chunk/tail boundary.
    const overlap = Math.max(0, ...[...secrets].map(token => token.length));
    stderr = (stderr + chunk).slice(-8_000 - overlap);
  });
  child.once('close', (code, signal) => {
    finished = true; clearWebApps(); clearTimeout(force); exit = { code, signal, stderr: diagnostics() };
    events.emit('exit', exit); finishClose();
  });
  try {
    const ready = await new Promise<WebReady>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SteamHarness Web startup timed out.')); }, 45_000);
      const settle = (error?: Error, message?: WebReady) => {
        clearTimeout(timer); child.off('error', failed); child.off('close', exited); child.stdout?.off('data', received);
        if (error) { reject(error); } else { resolve(message!); }
      };
      const failed = (error: Error) => settle(new Error(cleanError(error.message)));
      const exited = (code: number | null, signal: NodeJS.Signals | null) => failed(new Error(`SteamHarness Web exited (code=${code}, signal=${signal}).${diagnostics() ? `\n${diagnostics()}` : ''}`));
      const received = (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 2_000_000) { child.kill('SIGKILL'); failed(new Error('SteamHarness Web startup output is too large.')); return; }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.startsWith('{')) { continue; }
          try {
            const message = JSON.parse(line) as WebReady;
            if (message.type !== 'ready') { continue; }
            const url = new URL(message.url);
            if (message.protocolVersion !== 1 || message.hostProtocolVersion !== 1 || message.accountProtocolVersion !== 1 || message.entriesProtocolVersion !== 1 || (options.assistant && message.assistantProtocolVersion !== 1) || (options.expectedProjectId && message.project?.id !== options.expectedProjectId) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== `/entries/${options.entryId}/` || !message.project?.entries?.some(entry => entry.entryId === options.entryId) || !/^#session=[a-f0-9]{64}$/.test(url.hash)) {
              throw new Error(t("The project CLI does not support the current VS Code Web protocol. Update the project's @steamharness/cli."));
            }
            settle(undefined, message); return;
          } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); return; }
        }
      };
      child.once('error', failed); child.once('close', exited); child.stdout?.on('data', received);
      child.stdin?.write(`${JSON.stringify({ type: 'configure', surface: options.surface, platform: options.platform === true, ...authentication, userSettings: options.userSettings, assistant: options.assistant, assistantProjectDir: options.assistantProjectDir, resourceProjects: options.resourceProjects ?? [] })}\n`);
    });
    child.stdout?.resume();
    child.on('error', () => void close());
    // The browser session URL does not grant access to private trace details.
    const pendingTrace = new Map<string, (request?: unknown) => void>();
    if (ready.traceModelRequestProtocolVersion === 1) {
      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      lines.on('line', line => {
        if (!line.startsWith('{')) return;
        try {
          const reply = JSON.parse(line);
          if (reply.type === 'trace-model-request') pendingTrace.get(reply.requestId)?.(reply.request);
        } catch { /* Other CLI output is not a trace reply. */ }
      });
      child.once('close', () => {
        lines.close();
        for (const settle of pendingTrace.values()) settle();
      });
    }
    return { ready, closed, close,
      readModelRequest: ready.traceModelRequestProtocolVersion !== 1 ? undefined : (entryId, target) => new Promise(resolve => {
        if (closing || finished || !child.stdin?.writable) { resolve(undefined); return; }
        const requestId = globalThis.crypto.randomUUID();
        const settle = (request?: unknown) => { clearTimeout(timer); pendingTrace.delete(requestId); resolve(request); };
        const timer = setTimeout(settle, 10_000);
        pendingTrace.set(requestId, settle);
        child.stdin.write(`${JSON.stringify({ ...target, type: 'trace-model-request', requestId, entryId })}\n`, error => { if (error) settle(); });
      }),
      updateUserSettings: settings => {
        if (closing || finished || ready.userSettingsProtocolVersion !== 1) { return; }
        const key = JSON.stringify(settings);
        if (key === userSettingsKey) { return; }
        userSettingsKey = key;
        rememberModels(settings);
        child.stdin?.write(`${JSON.stringify({ type: 'user-settings', userSettings: settings })}\n`);
      },
      updateAuth: (connection, ai) => {
        if (ai && ready.systemAiConnectionProtocolVersion !== 2) throw new Error(t('Update the project CLI to connect to System AI.'));
        if (connection) secrets.add(connection.accessToken);
        if (ai) secrets.add(ai.accessToken);
        const authentication = hostAuthentication(connection, ai);
        const key = JSON.stringify(authentication);
        if (key === connectionKey) { return; }
        connectionKey = key;
        if (!closing && !finished) child.stdin?.write(`${JSON.stringify({ type: 'auth', ...authentication })}\n`);
      },
      updateResourceProjects: resourceProjects => {
        if (closing || finished) return;
        const key = JSON.stringify(resourceProjects);
        if (key === resourceProjectsKey) return;
        resourceProjectsKey = key;
        child.stdin?.write(`${JSON.stringify({ type: 'resource-projects', resourceProjects })}\n`);
      },
      connectWebApp: (entryId, connection) => {
        if (ready.webAppProtocolVersion !== 1) throw new Error(t('Update the project CLI to open the hosted Web App.'));
        if (connection) secrets.add(connection.accessToken);
        return refreshWebApps(entryId, connection);
      },
      onWebAppError: callback => { events.on('web-app-error', callback); if (webAppFailure) { const reason = webAppFailure, epoch = webAppEpoch; queueMicrotask(() => { if (webAppEpoch === epoch && webAppFailure === reason && events.listeners('web-app-error').includes(callback)) callback(reason); }); } return { dispose: () => events.off('web-app-error', callback) }; },
      onExit: callback => { events.on('exit', callback); if (finished) { queueMicrotask(() => { if (events.listeners('exit').includes(callback)) callback(exit); }); } return { dispose: () => events.off('exit', callback) }; },
    };
  } catch (error) { await close(); throw error; }
}

/** Configuration RPC uses the project's installed CLI, without a running Web session. */
export async function requestProjectCliConfiguration(projectDir: string, nodePath: string, call: Record<string, unknown>, signal: AbortSignal, connection?: Connection, entryId?: string, runtime?: NodeRuntime, authRoot?: string): Promise<unknown> {
  const {entry}=await resolveProjectCli(projectDir);
  return new Promise((resolve,reject)=>{
    const child=spawn(nodePath,[entry,'configuration',projectDir,...(entryId?['--entry',entryId]:[])],{cwd:projectDir,env:environment(undefined,runtime,authRoot),shell:false,stdio:['pipe','pipe','pipe'],signal});
    let stdout='',stderr='';
    const timeout=setTimeout(()=>child.kill('SIGKILL'),30_000);
    child.stdin.on('error',()=>undefined); child.stdin.end(JSON.stringify({call,connection:connection?{serverUrl:connection.serverUrl,accessToken:connection.accessToken}:null}));
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',text=>{stdout+=text;if(stdout.length>4*1024*1024)child.kill('SIGKILL');});
    child.stderr.on('data',text=>{stderr=(stderr+text).slice(-2000);});
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('close',()=>{clearTimeout(timeout);try{const result=JSON.parse(stdout);if(result.ok)resolve(result.value);else reject(Object.assign(new Error(result.error?.message||'Configuration request failed.'),{code:result.error?.code}));}catch(error){reject(new Error(stderr||'Invalid configuration response.'));}});
  });
}

/** Build through the project CLI so desktop and command-line distribution use one contract. */
export async function prepareProjectDistributionCli(directory: string, nodePath: string, snapshot: boolean, signal: AbortSignal, progress: (message: string) => void, runtime?: NodeRuntime, entryId?: string, authRoot?: string): Promise<{ directory: string; mode: 'source' | 'release'; buildId?: string; entries?: string[] }> {
  const cli = await resolveProjectCli(directory);
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [cli.entry, '--locale', currentLocale(), 'release', directory, '--json', snapshot ? '--snapshot' : '--inspect', ...(snapshot && entryId ? ['--entry', entryId] : [])], { cwd: directory, env: environment(undefined, runtime, authRoot), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = '', error = '';
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 2_000_000) child.kill(); });
    child.stderr.on('data', bytes => { error = (error + bytes).slice(-12_000); progress(String(bytes).trim()); });
    child.once('error', reject);
    child.once('close', code => {
      try {
        if (code !== 0) throw new Error(error || `Release CLI exited (${code}).`);
        const value = JSON.parse(output);
        if (typeof value.directory !== 'string' || !path.isAbsolute(value.directory)) throw new Error('Invalid release CLI result.');
        resolve({ ...value, mode: snapshot ? 'release' : value.mode });
      } catch (failure) { reject(failure); }
    });
  });
}
