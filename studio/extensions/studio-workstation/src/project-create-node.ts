import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createProjectCliEnvironment } from './workflow-cli-process';
import { nodeRuntimeEnvironment, type NodeRuntime } from './node-runtime';
import { t } from './localization';
import type { CreatedProject, ProjectCreationInput, StartTemplate } from './start-page-types';
import type { TemplateProjectRegistration } from '../../../vendor/project-templates/project-templates';

interface TemplateModule {
  validateProjectName(value: string): string;
  listProjectTemplates(): Promise<Array<Omit<StartTemplate, 'name' | 'description'> & { name: Record<string, string>; description: Record<string, string> }>>;
  createProjectFromTemplate(input: { templateId: string; name: string; parentDirectory: string; versions: { harness: string; cli: string }; signal?: AbortSignal;
    allocateProjectId?: (project: TemplateProjectRegistration) => Promise<string> }): Promise<CreatedProject>;
}

export function defaultProjectParentDirectory(): string { return path.join(homedir(), 'Documents', 'steamharness-projects'); }

export function projectTemplatesRuntime(extensionDirectory: string, locale: string) {
  const directory = path.join(extensionDirectory, 'dist');
  const module = (): Promise<TemplateModule> => import(pathToFileURL(path.join(directory, 'project-templates.mjs')).href);
  const validate = async (input: ProjectCreationInput): Promise<void> => {
    const name = (await module()).validateProjectName(input.name);
    try {
      if (!path.isAbsolute(input.parentDirectory)) { throw new Error('Not absolute'); }
      const parent = await stat(input.parentDirectory).catch(error => {
        if (error.code === 'ENOENT' && input.parentDirectory === defaultProjectParentDirectory()) { return undefined; }
        throw error;
      });
      if (parent && !parent.isDirectory()) { throw new Error('Not a directory'); }
    } catch { throw Object.assign(new Error('Choose an existing parent folder.'), { code: 'invalid-parent' }); }
    const destination = await lstat(path.join(input.parentDirectory, name)).catch(error => {
      if (error.code === 'ENOENT') { return undefined; }
      throw error;
    });
    if (destination) { throw Object.assign(new Error('The project folder already exists.'), { code: 'directory-exists' }); }
  };
  return {
    validate,
    templates: async (): Promise<StartTemplate[]> => {
      const language = locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
      return (await (await module()).listProjectTemplates()).map(template => ({ id: template.id, projectType: template.projectType, kind: template.kind,
        name: template.name[language] || template.name.en, description: template.description[language] || template.description.en }));
    },
    create: async (input: { templateId: string; name: string; parentDirectory: string }, signal?: AbortSignal,
      allocateProjectId?: (project: TemplateProjectRegistration) => Promise<string>): Promise<CreatedProject> => {
      await validate(input);
      signal?.throwIfAborted();
      const versions = JSON.parse(await readFile(path.join(directory, 'project-template-versions.json'), 'utf8'));
      if (input.parentDirectory === defaultProjectParentDirectory()) { await mkdir(input.parentDirectory, { recursive: true }); }
      return (await module()).createProjectFromTemplate({ ...input, versions, signal, allocateProjectId });
    },
    prepare: async (projectDirectory: string, nodePath: string, signal: AbortSignal, runtime?: NodeRuntime): Promise<boolean> => {
      // Use a fresh process so a long-lived extension host cannot retain an SDK from before a reinstall.
      const script = 'const templates = await import(process.argv[1]); const changed = await templates.prepareProjectTemplateRuntime(process.argv[2]); process.stdout.write(JSON.stringify(changed));';
      const result = await promisify(execFile)(nodePath, ['--input-type=module', '--eval', script,
        pathToFileURL(path.join(directory, 'project-templates.mjs')).href, projectDirectory], {
        cwd: projectDirectory, env: createProjectCliEnvironment(process.env, undefined, runtime), signal, timeout: 30_000, windowsHide: true,
      });
      signal.throwIfAborted();
      return JSON.parse(result.stdout.trim()) === true;
    },
  };
}

export async function installProjectDependencies(options: { directory: string; signal: AbortSignal; log: (message: string) => void; env?: NodeJS.ProcessEnv; runtime?: NodeRuntime }): Promise<void> {
  const runtime = options.runtime;
  const env = runtime ? nodeRuntimeEnvironment(runtime, options.env) : options.env ?? process.env;
  const run = (manager: 'pnpm' | 'npm', args: string[], probe = false): Promise<void> => new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    const windows = process.platform === 'win32';
    // Only fixed commands enter cmd.exe; project paths are passed through cwd.
    const cli = manager === 'pnpm' ? runtime?.pnpmCli : runtime?.npmCli;
    if (runtime && runtime.source !== 'host' && !cli) {
      reject(Object.assign(new Error(t('The selected Node.js has no package manager. Repair the bundled runtime or choose a local Node.js installation with npm.')), { code: 'package-manager-missing' }));
      return;
    }
    const child = spawn(cli ? runtime!.nodePath : windows ? 'cmd.exe' : manager, cli ? [cli, ...args] : windows ? ['/d', '/s', '/c', `${manager} ${args.join(' ')}`] : args,
      { cwd: options.directory, env, shell: false, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    let errorText = '', timedOut = false, stopping: Promise<void> | undefined;
    const stop = (forcefully = false): void => {
      if (!child.pid) { return; }
      if (windows) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, forcefully ? 'SIGKILL' : 'SIGTERM'); } catch { /* Already stopped. */ }
      }
    };
    const abort = (): void => {
      if (stopping) { return; }
      stop();
      // The manager can exit before a lifecycle script. Keep its process group until forced cleanup finishes.
      stopping = new Promise(resolve => setTimeout(() => { stop(true); resolve(); }, 3_000));
    };
    const timeout = setTimeout(() => { timedOut = true; abort(); }, probe ? 10_000 : 10 * 60_000);
    options.signal.addEventListener('abort', abort, { once: true });
    const clean = (): void => { clearTimeout(timeout); options.signal.removeEventListener('abort', abort); };
    const output = (chunk: Buffer): void => {
      errorText = (errorText + chunk.toString()).slice(-4_000);
      if (!probe) { options.log(chunk.toString()); }
    };
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.once('error', error => { clean(); reject(error); });
    child.once('close', async code => {
      clean();
      await stopping;
      if (options.signal.aborted) { reject(new DOMException('Dependency installation cancelled.', 'AbortError')); }
      else if (timedOut) { reject(Object.assign(new Error('Package manager timed out.'), { code: 'package-manager-timeout' })); }
      else if (code === 0) { resolve(); }
      else { reject(new Error(errorText.trim() || `${manager} exited (${code}).`)); }
    });
    if (options.signal.aborted) { abort(); }
  });
  let manager: 'pnpm' | 'npm' = 'pnpm';
  if (runtime?.npmCli && !runtime.pnpmCli) manager = 'npm';
  try { await run(manager, ['--version'], true); }
  catch (error) {
    options.signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && process.platform !== 'win32') { throw error; }
    manager = 'npm';
    try { await run('npm', ['--version'], true); }
    catch { options.signal.throwIfAborted(); throw Object.assign(new Error('Install pnpm or npm to prepare project dependencies.'), { code: 'package-manager-missing', cause: error }); }
  }
  options.log(`${manager} install\n`);
  await run(manager, manager === 'pnpm' ? ['install', '--reporter=append-only'] : ['install', '--no-audit', '--no-fund']);
}
