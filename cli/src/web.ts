import { spawn } from 'node:child_process';
import path from 'node:path';
import { startWebServer } from './web/server';
import { i18n } from '@workflow-code/i18n';
import { createInterface } from 'node:readline';
import { createWebRuntime } from './web/runtime';
import { parseHostConfiguration, parseHostConnection, parseHostRelatedProjects, parseHostResourceProjects } from './web/host-config';
import { ASSISTANT_PROTOCOL_VERSION, inspectWebProject } from './web/assistant-project';

export function parseWebArgs(argv: string[]) {
  const options = { projectDir: process.cwd(), port: 0, theme: 'auto' as 'auto' | 'light' | 'dark', dataDir: undefined as string | undefined, open: true, json: false, help: false, inspect: false, hostStdio: false };
  let projectSet = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--no-open') { options.open = false; }
    else if (arg === '--json') { options.json = true; }
    else if (arg === '--inspect') { options.inspect = true; }
    else if (arg === '--host-stdio') { options.hostStdio = true; }
    else if (['--help', '-h'].includes(arg)) { options.help = true; }
    else if (['--port', '--data-dir', '--theme'].includes(arg)) {
      const value = argv[++index]; if (!value || value.startsWith('--')) { throw new Error(`${arg} requires a value.`); }
      if (arg === '--port') { if (!/^\d+$/.test(value) || Number(value) > 65535) { throw new Error('--port must be an integer between 0 and 65535.'); } options.port = Number(value); }
      else if (arg === '--theme') { if (!['auto', 'light', 'dark'].includes(value)) { throw new Error('--theme must be auto, light, or dark.'); } options.theme = value as typeof options.theme; }
      else { options.dataDir = path.resolve(value); }
    } else if (arg.startsWith('-') || projectSet) { throw new Error(`Unknown web argument: ${arg}`); }
    else { options.projectDir = path.resolve(arg); projectSet = true; }
  }
  return options;
}

export async function main(argv: string[]): Promise<number> {
  const options = parseWebArgs(argv);
  if (options.help) {
    console.log(i18n.language.startsWith('zh')
      ? 'workflow-code web [项目目录]\n  --port <0-65535>   监听端口，0 自动分配\n  --no-open          不自动打开浏览器\n  --theme <auto|light|dark>\n  --data-dir <目录>   对话和文件存储位置\n  --json             输出结构化启动信息'
      : 'workflow-code web [project-directory]\n  --port <0-65535>   Listen port; 0 selects an available port\n  --no-open          Do not open a browser\n  --theme <auto|light|dark>\n  --data-dir <path>   Conversation and file storage directory\n  --json             Print structured startup information');
    return 0;
  }
  const input = options.hostStdio ? createInterface({ input: process.stdin, crlfDelay: Infinity }) : undefined;
  const lines = input?.[Symbol.asyncIterator]();
  let host;
  try {
    if (lines) {
      const initial = await lines.next();
      if (initial.done || initial.value.length > 256_000) { throw new Error('Web host configuration is missing or too large.'); }
      host = parseHostConfiguration(JSON.parse(initial.value));
    }
  } catch (error) { input?.close(); throw error; }
  if (options.inspect) {
    const runtime = createWebRuntime(options.projectDir, options.dataDir ?? '', () => undefined);
    try { console.log(JSON.stringify(await inspectWebProject(runtime, options.projectDir, host))); }
    finally { runtime.dispose(); input?.close(); process.stdin.pause(); }
    return 0;
  }
  const app = await startWebServer({ ...options, host }).catch(error => { input?.close(); throw error; });
  const close = () => { process.off('SIGINT', close); process.off('SIGTERM', close); input?.close(); process.stdin.pause(); void app.close().catch(error => { console.error(error); process.exitCode = 1; }); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  console.log(options.json ? JSON.stringify({ type: 'ready', protocolVersion: 1, hostProtocolVersion: 1, accountProtocolVersion: 1, relatedProjectsProtocolVersion: 1, traceProtocolVersion: 1, assistantProtocolVersion: host?.assistant ? ASSISTANT_PROTOCOL_VERSION : undefined, url: app.url, project: { id: app.project.id, name: app.project.name, projectType: app.project.projectType }, runtime: (app.project as unknown as { runtime: unknown }).runtime }) : `Workflow Web: ${app.url}`);
  if (lines) {
    void (async () => {
      try {
        for await (const line of { [Symbol.asyncIterator]: () => lines }) {
          if (line.length > 256_000) { throw new Error('Web host message is too large.'); }
          const message = JSON.parse(line);
          if (message.type === 'auth') {
            void app.setHostConnection(parseHostConnection(message.connection, { allowAi: host?.surface === 'assistant' })).catch(() => { console.error('Workflow web host connection failed.'); process.exitCode = 1; close(); });
          }
          else if (message.type === 'related-projects') { app.setHostRelatedProjects(parseHostRelatedProjects(message.relatedProjects)); if (message.resourceProjects !== undefined) { app.setHostResourceProjects(parseHostResourceProjects(message.resourceProjects)); } }
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
