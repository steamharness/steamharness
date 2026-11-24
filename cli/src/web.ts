import { parseWebAppBindings } from "./web/web-app-preview";
import { assertProjectDataDirectory } from "@steamharness/project-manifest/node";
import { prepareReleaseRun } from "./release/build";
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startWebServer } from './web/server';
import { i18n } from '@steamharness/i18n';
import { createInterface } from 'node:readline';
import { createWebRuntime } from './web/runtime';
import { parseHostConfiguration, parseHostAuthentication, parseHostResourceProjects } from './web/host-config';
import { ASSISTANT_PROTOCOL_VERSION, inspectWebProject } from './web/assistant-project';
import { parseUserSettings } from 'steamharness';
import { formatOnlineHelp, parseOnlineOptions, resolveOnlineConnections } from './online';

export function parseWebArgs(argv: string[]) {
  const online = parseOnlineOptions(argv);
  argv = online.argv;
  const options = { release: false, projectDir: process.cwd(), port: 0, theme: 'auto' as 'auto' | 'light' | 'dark', dataDir: undefined as string | undefined, open: true, json: false, help: false, inspect: false, hostStdio: false, folderContext: false, entryId: undefined as string | undefined };
  let projectSet = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--release') { options.release = true; }
    else if (arg === '--no-open') { options.open = false; }
    else if (arg === '--json') { options.json = true; }
    else if (arg === '--inspect') { options.inspect = true; }
    else if (arg === '--host-stdio') { options.hostStdio = true; }
    else if (arg === '--folder-context') { options.folderContext = true; }
    else if (['--help', '-h'].includes(arg)) { options.help = true; }
    else if (['--port', '--data-dir', '--theme', '--entry'].includes(arg)) {
      const value = argv[++index]; if (!value || value.startsWith('--')) { throw new Error(`${arg} requires a value.`); }
      if (arg === '--entry') { options.entryId = value; }
      else if (arg === '--port') { if (!/^\d+$/.test(value) || Number(value) > 65535) { throw new Error('--port must be an integer between 0 and 65535.'); } options.port = Number(value); }
      else if (arg === '--theme') { if (!['auto', 'light', 'dark'].includes(value)) { throw new Error('--theme must be auto, light, or dark.'); } options.theme = value as typeof options.theme; }
      else { options.dataDir = path.resolve(value); }
    } else if (arg.startsWith('-') || projectSet) { throw new Error(`Unknown web argument: ${arg}`); }
    else { options.projectDir = path.resolve(arg); projectSet = true; }
  }
  if (options.hostStdio && online.online.length) throw new Error('Use the host protocol, not --online, when embedding CLI Web.');
  if (options.folderContext && (!options.hostStdio || !options.entryId || options.release || options.inspect)) throw new Error('Local folder context requires a dedicated stdio host and entry.');
  return { ...options, online: online.online };
}

export async function main(argv: string[]): Promise<number> {
  const options = parseWebArgs(argv);
  if (options.help) {
    console.log(i18n.language.startsWith('zh')
      ? 'steamharness web [项目目录]\n  --port <0-65535>   监听端口，0 自动分配\n  --no-open          不自动打开浏览器\n  --theme <auto|light|dark>\n  --data-dir <目录>   对话和文件存储位置\n  --json             输出结构化启动信息'
      : 'steamharness web [project-directory]\n  --port <0-65535>   Listen port; 0 selects an available port\n  --no-open          Do not open a browser\n  --theme <auto|light|dark>\n  --data-dir <path>   Conversation and file storage directory\n  --json             Print structured startup information');
    console.log(formatOnlineHelp());
    return 0;
  }
  if (options.release && options.dataDir) assertProjectDataDirectory(options.projectDir, options.dataDir);
  if (options.release) options.projectDir = (await prepareReleaseRun(options.projectDir, { progress: message => process.stderr.write(message + '\n') })).directory;
  const input = options.hostStdio ? createInterface({ input: process.stdin, crlfDelay: Infinity }) : undefined;
  const lines = input?.[Symbol.asyncIterator]();
  let host: ReturnType<typeof parseHostConfiguration> | undefined;
  try {
    if (lines) {
      const initial = await lines.next();
      if (initial.done || initial.value.length > 256_000) { throw new Error('Web host configuration is missing or too large.'); }
      host = parseHostConfiguration(JSON.parse(initial.value));
      if (options.folderContext !== !!host.folderBot) throw new Error('The local folder host configuration does not match the requested mode.');
    }
  } catch (error) { input?.close(); throw error; }
  if (options.inspect) {
    const runtime = createWebRuntime(options.projectDir, options.dataDir ?? '', () => undefined, { entryId: options.entryId, userSettings: () => host?.userSettings });
    try { console.log(JSON.stringify(await inspectWebProject(runtime, options.projectDir, host))); }
    finally { runtime.dispose(); input?.close(); process.stdin.pause(); }
    return 0;
  }
  const initialPlatform = await resolveOnlineConnections(options.online);
  const publishWebAppConfigurations = Boolean(input && host?.platform === true);
  const app = await startWebServer({ ...options, initialPlatform, host, onWebAppConfigurationChanged: publishWebAppConfigurations ? (entryId, configuration) => {
    console.log(JSON.stringify({ type: 'web-app-configuration', entryId, configuration }));
  } : undefined, onWebAppLogin: publishWebAppConfigurations ? (entryId, configuration) => {
    console.log(JSON.stringify({ type: 'web-app-login', entryId, configuration }));
  } : undefined }).catch(error => { input?.close(); throw error; });
  const close = () => { process.off('SIGINT', close); process.off('SIGTERM', close); input?.close(); process.stdin.pause(); void app.close().catch(error => { console.error(error); process.exitCode = 1; }); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  const hostConversationProtocolVersion = input && host?.surface === 'editor' && host.folderBot?.background !== false ? 1 : undefined;
  const workflowScheduleProtocolVersion = input && host?.workflowScheduleKey && process.env.STEAMHARNESS_WEB_HOST === 'studio' ? 1 : undefined;
  console.log(options.json ? JSON.stringify({ type: 'ready', protocolVersion: 1, hostProtocolVersion: 1, studioPreviewProtocolVersion: host ? 1 : undefined, hostConversationProtocolVersion, workflowScheduleProtocolVersion, folderBotProtocolVersion: host?.folderBot ? 1 : undefined, folderBotProfileVersion: host?.folderBot?.profileRecord ? 1 : undefined, botArtifactProtocolVersion: host?.localBotArtifacts ? 1 : undefined, botMemoryProtocolVersion: host?.localBotArtifacts ? 1 : undefined, accountProtocolVersion: 1, webAppProtocolVersion: 1, ...(publishWebAppConfigurations ? { webAppConfigurationProtocolVersion: 1, webAppLoginProtocolVersion: 1, webAppConfigurations: app.webAppConfigurations } : {}), systemAiConnectionProtocolVersion: 2, restrictedConfigurationEntries: app.restrictedConfigurationEntries, entriesProtocolVersion: 1, traceProtocolVersion: 1, traceModelRequestProtocolVersion: host?.surface === 'editor' ? 1 : undefined, userSettingsProtocolVersion: 1, assistantProtocolVersion: host?.assistant ? ASSISTANT_PROTOCOL_VERSION : undefined, url: app.url, project: { id: app.project.id, name: app.project.name, entries: app.manifest.entries, defaultEntry: app.manifest.defaultEntry }, runtime: (app.project as unknown as { runtime: unknown }).runtime }) : `SteamHarness Web: ${app.url}`);
  if (lines) {
    void (async () => {
      try {
        for await (const line of { [Symbol.asyncIterator]: () => lines }) {
          if (line.length > 256_000) { throw new Error('Web host message is too large.'); }
          const message = JSON.parse(line);
          if (message.type === 'auth') {
            const connections = parseHostAuthentication(message);
            // A slow verification must not prevent a newer connection, logout, or close.
            void app.setHostConnection(connections.project, connections.ai).catch(() => {
              console.error('Workflow web host authentication failed.');
            });
          }
          else if (message.type === 'web-apps') { await app.setHostWebApps(parseWebAppBindings(message.webApps)); }
          else if (message.type === 'resource-projects') { app.setHostResourceProjects(parseHostResourceProjects(message.resourceProjects)); }
          else if (message.type === 'user-settings') { await app.setHostUserSettings(parseUserSettings(message.userSettings)); }
          else if (message.type === 'trace-model-request' && host?.surface === 'editor') {
            const { requestId, entryId, sessionId, messageId, executionId } = message;
            if ([requestId, entryId, sessionId, messageId, executionId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)) {
              console.log(JSON.stringify({ type: 'trace-model-request', requestId, request: app.readModelRequest(entryId, sessionId, messageId, executionId) }));
            }
          }
          else if (message.type === 'host-turn' && hostConversationProtocolVersion && typeof message.requestId === 'string') {
            const envelope = { type: 'host-turn', requestId: message.requestId };
            try { console.log(JSON.stringify({ ...envelope, value: await app.hostTurn(message.entryId, message.input) })); }
            catch { console.log(JSON.stringify({ ...envelope, failed: true })); }
          }
          else if (message.type === 'close') { break; }
          else { throw new Error('Unknown web host message.'); }
        }
      } catch { console.error('Workflow web host connection failed.'); process.exitCode = 1; }
      finally { close(); }
    })();
  }
  if (options.open) {
    const invocation = process.platform === 'darwin' ? { command: 'open', args: [app.url] }
      : process.platform === 'win32' ? { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', app.url] }
      : { command: 'xdg-open', args: [app.url] };
    const browser = spawn(invocation.command, invocation.args, { detached: true, shell: false, stdio: 'ignore' });
    browser.once('error', error => console.error(`Cannot open browser: ${error.message}`)); browser.unref();
  }
  return 0;
}
