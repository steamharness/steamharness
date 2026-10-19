import { t } from './localization';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Connection } from './workflow-auth-client';
import { sanitizeWorkflowEnvironment } from './workflow-auth-client';
import type { Project } from './workflow-types';
import type { WebReady, WebSession, RelatedProjectBinding } from './workflow-cli-types';

export interface StudioControlConfiguration { mcpServer?: string; url: string; token: string }

/**
 * Keep the private system-AI connection available only to the dedicated
 * assistant surface. The editor and its project workers must never receive
 * those fields, even when the host account has an AI session configured.
 */
export function sanitizeConnectionForSurface(connection: Connection | undefined, surface: 'editor' | 'assistant'): Connection | undefined {
  if (!connection) { return undefined; }
  if (surface === 'assistant') { return { ...connection }; }
  return { serverUrl: connection.serverUrl, accessToken: connection.accessToken };
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

export function createProjectCliEnvironment(base: NodeJS.ProcessEnv = process.env, studioControl?: StudioControlConfiguration): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = sanitizeWorkflowEnvironment(base);
  env.ELECTRON_RUN_AS_NODE = '1';
  for (const key of ['TSX_TSCONFIG_PATH', 'STEAMHARNESS_LOCAL_HARNESS_ROOT', 'STEAMHARNESS_LOCAL_SHARED_ROOT', 'STEAMHARNESS_LOCAL_SOURCE_MODE',
    'STEAMHARNESS_DEVELOPER_ASSISTANT_HOST', 'STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR', 'STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST',
    'STEAMHARNESS_AI_SERVER_URL', 'STEAMHARNESS_AI_API_KEY', 'STEAMHARNESS_LLM_SERVER_URL', 'STEAMHARNESS_LLM_SERVER_TOKEN',
    'STEAMHARNESS_STUDIO_INTERNAL', 'STEAMHARNESS_STUDIO_INTERNAL_MODULE', 'STEAMHARNESS_STUDIO_INTERNAL_SERVER_URL',
    'STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL', 'STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN',
    'STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY',
    'STEAMHARNESS_DESKTOP_CONTROL_MCP_SERVER', 'STEAMHARNESS_DESKTOP_CONTROL_PROXY_URL', 'STEAMHARNESS_DESKTOP_CONTROL_PROXY_TOKEN',
    'STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL', 'STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN']) { delete env[key]; }
  if (studioControl) {
    if (studioControl.mcpServer) { env.STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER = studioControl.mcpServer; }
    env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL = studioControl.url;
    env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN = studioControl.token;
  }
  return env;
}

function environment(studioControl?: StudioControlConfiguration): NodeJS.ProcessEnv {
  return createProjectCliEnvironment(process.env, studioControl);
}

export async function inspectProjectCli(projectDir: string, nodePath: string, signal?: AbortSignal, assistantProjectDir?: string, assistant?: Project['assistant'], locale = 'en'): Promise<{ projects: Omit<Project, 'uri'>[]; errors: string[] }> {
  const { entry } = await resolveProjectCli(projectDir);
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [entry, '--locale', locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en', 'web', projectDir, '--inspect', '--json', '--no-open', ...(assistantProjectDir ? ['--host-stdio'] : [])], { cwd: projectDir, env: environment(), shell: false, stdio: ['pipe', 'pipe', 'pipe'], signal });
    child.stdin.on('error', () => undefined);
    child.stdin.end(assistantProjectDir ? `${JSON.stringify({ type: 'configure', surface: 'assistant', assistantProjectDir,
      assistant: assistant ?? { workdir: projectDir, roots: [{ uri: `file://${projectDir}`, folderPath: projectDir, name: path.basename(projectDir) }] } })}\n` : undefined);
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) { child.kill('SIGKILL'); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        if (code !== 0) { throw new Error(stderr.trim() || `Project CLI exited (${code}).`); }
        const result = JSON.parse(stdout);
        if (!Array.isArray(result.projects) || !Array.isArray(result.errors)) { throw new Error('Invalid project CLI inspection response.'); }
        if (assistantProjectDir && result.assistantProtocolVersion !== 1) {
          throw new Error(t("The standalone Assistant CLI is incompatible. Update its @steamharness/cli."));
        }
        resolve({ ...result, projects: result.projects.map((project: Omit<Project, 'uri'>) => ({ ...project, folderPath: path.resolve(assistantProjectDir ?? projectDir) })) });
      } catch (error) { reject(error); }
    });
  });
}

export async function startProjectCli(options: {
  projectDir: string; dataDir: string; nodePath: string; theme: 'dark' | 'light'; locale?: string;
  surface: 'editor' | 'assistant'; connection?: Connection; assistant?: Project['assistant']; signal?: AbortSignal;
  assistantProjectDir?: string;
  expectedProjectId?: string;
  relatedProjects?: RelatedProjectBinding[];
  resourceProjects?: string[];
  studioControl?: StudioControlConfiguration;
}): Promise<WebSession> {
  const { entry } = await resolveProjectCli(options.projectDir);
  options.signal?.throwIfAborted();
  const connection = sanitizeConnectionForSurface(options.connection, options.surface);
  const child: ChildProcess = spawn(options.nodePath, [entry, '--locale', options.locale?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en', 'web', options.projectDir, '--port', '0', '--no-open', '--json', '--theme', options.theme, '--host-stdio', '--data-dir', options.dataDir],
    { cwd: options.projectDir, env: environment(options.studioControl), shell: false, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
  const events = new EventEmitter();
  const secrets = new Set([options.connection?.accessToken, options.connection?.aiAccessToken, options.studioControl?.token].filter((token): token is string => !!token));
  const cleanError = (message: string): string => { for (const token of secrets) { message = message.replaceAll(token, '[redacted]'); } return message; };
  let finishClose!: () => void;
  const closed = new Promise<void>(resolve => { finishClose = resolve; });
  let closing = false, finished = false, buffer = '', stderr = '';
  let relatedProjectsKey = JSON.stringify([options.relatedProjects ?? [], options.resourceProjects ?? []]);
  let connectionKey = JSON.stringify(connection ?? null);
  let force: ReturnType<typeof setTimeout> | undefined;
  const close = (): Promise<void> => {
    if (!closing && !finished) {
      closing = true;
      child.stdin?.end(`${JSON.stringify({ type: 'close' })}\n`);
      force = setTimeout(() => child.kill('SIGKILL'), 5_000);
      force.unref();
    }
    return closed;
  };
  child.stdin?.on('error', () => undefined);
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
  child.once('close', () => { finished = true; clearTimeout(force); events.emit('exit'); finishClose(); });
  try {
    const ready = await new Promise<WebReady>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SteamHarness Web startup timed out.')); }, 45_000);
      const settle = (error?: Error, message?: WebReady) => {
        clearTimeout(timer); child.off('error', failed); child.off('close', exited); child.stdout?.off('data', received);
        if (error) { reject(error); } else { resolve(message!); }
      };
      const failed = (error: Error) => settle(new Error(cleanError(error.message)));
      const exited = (code: number | null) => failed(new Error(stderr.trim() || `SteamHarness Web exited (${code}).`));
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
            if (message.protocolVersion !== 1 || message.hostProtocolVersion !== 1 || message.accountProtocolVersion !== 1 || (options.relatedProjects?.length && message.relatedProjectsProtocolVersion !== 1) || (options.assistant && message.assistantProtocolVersion !== 1) || (options.expectedProjectId && message.project?.id !== options.expectedProjectId) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || !/^#session=[a-f0-9]{64}$/.test(url.hash)) {
              throw new Error(t("The project CLI does not support the current VS Code Web protocol. Update the project's @steamharness/cli."));
            }
            settle(undefined, message); return;
          } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); return; }
        }
      };
      child.once('error', failed); child.once('close', exited); child.stdout?.on('data', received);
      child.stdin?.write(`${JSON.stringify({ type: 'configure', surface: options.surface, connection: connection ?? null, assistant: options.assistant, assistantProjectDir: options.assistantProjectDir, relatedProjects: options.relatedProjects ?? [], resourceProjects: options.resourceProjects ?? [] })}\n`);
    });
    child.stdout?.resume();
    child.on('error', () => void close());
    return { ready, closed, close,
      updateAuth: connection => {
        if (connection) { secrets.add(connection.accessToken); if (connection.aiAccessToken) { secrets.add(connection.aiAccessToken); } }
        const sanitized = sanitizeConnectionForSurface(connection, options.surface);
        const key = JSON.stringify(sanitized ?? null);
        if (key === connectionKey) { return; }
        connectionKey = key;
        if (!closing && !finished) { child.stdin?.write(`${JSON.stringify({ type: 'auth', connection: sanitized ?? null })}\n`); }
      },
      updateRelatedProjects: (relatedProjects, resourceProjects = []) => {
        if (closing || finished) { return; }
        if (relatedProjects.length && ready.relatedProjectsProtocolVersion !== 1) {
          throw new Error(t("The project CLI does not support the current VS Code Web protocol. Update the project's @steamharness/cli."));
        }
        const key = JSON.stringify([relatedProjects, resourceProjects]);
        if (key === relatedProjectsKey) { return; }
        relatedProjectsKey = key;
        child.stdin?.write(`${JSON.stringify({ type: 'related-projects', relatedProjects, resourceProjects })}\n`);
      },
      onExit: callback => { events.on('exit', callback); if (finished) { queueMicrotask(callback); } return { dispose: () => events.off('exit', callback) }; },
    };
  } catch (error) { await close(); throw error; }
}
