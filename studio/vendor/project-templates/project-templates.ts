import { randomUUID } from 'node:crypto';
import { resolve } from 'import-meta-resolve';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateProjectCardMetadata } from '@steamharness/project-card-metadata';

export type ProjectTemplateType = 'workflow' | 'conversation' | 'kanban';
export interface ProjectTemplateDefinition {
  id: string;
  projectType: ProjectTemplateType;
  kind: 'starter' | 'example';
  name: Record<'en' | 'zh-CN', string>;
  description: Record<'en' | 'zh-CN', string>;
  files: string[];
  sources?: Record<string, string>;
  entryFile: string;
}
export interface CreateProjectFromTemplateRequest {
  templateId: string;
  name: string;
  parentDirectory: string;
  versions: { harness: string; cli: string };
  signal?: AbortSignal;
}
export interface CreatedTemplateProject {
  id: string;
  name: string;
  directory: string;
  projectType: ProjectTemplateType;
  entryFile: string;
}
export class ProjectTemplateError extends Error {
  constructor(readonly code: 'invalid-name' | 'invalid-template' | 'invalid-version' | 'invalid-parent' | 'directory-exists', message: string) {
    super(message);
    this.name = 'ProjectTemplateError';
  }
}

const templateRoot = fileURLToPath(new URL('./project-templates/', import.meta.url));
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateProjectName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || Buffer.byteLength(name, 'utf8') > 240 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || /^\./.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new ProjectTemplateError('invalid-name', 'Choose a name that is valid as a folder on Windows, macOS and Linux.');
  }
  return name;
}

function safeRelative(filename: string): boolean {
  return !!filename && !filename.includes('\\') && !path.posix.isAbsolute(filename)
    && filename.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.includes(':'));
}

export async function listProjectTemplates(): Promise<ProjectTemplateDefinition[]> {
  const templates: ProjectTemplateDefinition[] = JSON.parse(await readFile(path.join(templateRoot, 'catalog.json'), 'utf8'));
  const ids = new Set<string>();
  for (const template of templates) {
    if (!/^[a-z][a-z0-9-]*$/.test(template.id) || ids.has(template.id) || !['workflow', 'conversation', 'kanban'].includes(template.projectType)
      || !['starter', 'example'].includes(template.kind) || !Array.isArray(template.files) || !template.files.every(safeRelative)
      || !template.files.includes(template.entryFile) || Object.values(template.sources ?? {}).some(source => !safeRelative(source))
      || ['en', 'zh-CN'].some(locale => !template.name?.[locale as 'en'] || !template.description?.[locale as 'en'])) {
      throw new ProjectTemplateError('invalid-template', 'Invalid project template catalog.');
    }
    ids.add(template.id);
  }
  return templates;
}

export async function createProjectFromTemplate(request: CreateProjectFromTemplateRequest): Promise<CreatedTemplateProject> {
  request.signal?.throwIfAborted();
  const name = validateProjectName(request.name);
  if (!exactVersion.test(request.versions.harness) || !exactVersion.test(request.versions.cli)) {
    throw new ProjectTemplateError('invalid-version', 'Project dependencies must use exact published versions.');
  }
  const template = (await listProjectTemplates()).find(entry => entry.id === request.templateId);
  if (!template) { throw new ProjectTemplateError('invalid-template', 'Unknown project template.'); }
  let parent: string;
  try {
    if (!path.isAbsolute(request.parentDirectory)) { throw new Error('Not absolute'); }
    parent = await realpath(request.parentDirectory);
    if (!(await stat(parent)).isDirectory()) { throw new Error('Not a directory'); }
  } catch { throw new ProjectTemplateError('invalid-parent', 'Choose an existing parent folder.'); }
  const directory = path.join(parent, name);
  const id = randomUUID();
  const packageName = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || `project-${id.slice(0, 8)}`;
  const manifest = {
    id, name: packageName, version: '0.1.0', private: true, type: 'module',
    scripts: { dev: 'steamharness web .', inspect: 'steamharness structure .', 'run:json': 'steamharness json .' },
    devDependencies: { 'steamharness': request.versions.harness, '@steamharness/cli': request.versions.cli },
    steamHarness: {
      projectType: template.projectType,
      projectCard: generateProjectCardMetadata(template.projectType),
      ...(template.projectType === 'kanban' ? { kanban: {} } : {}),
      projectInfo: { localizedNames: { en: name, 'zh-CN': name }, platformSupport: { mode: 'agnostic' }, dataStorage: { mode: 'local' } },
    },
  };
  // Read and render everything before reserving the destination folder.
  const files = await Promise.all(template.files.map(async filename => {
    const content = await readFile(path.join(templateRoot, template.sources?.[filename] ?? `${template.id}/${filename}`), 'utf8');
    return { filename, content: content.replaceAll('__PROJECT_NAME_HTML__', escapeHtml(name)).replaceAll('__PROJECT_TITLE__', name) };
  }));
  request.signal?.throwIfAborted();
  try { await mkdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') { throw new ProjectTemplateError('directory-exists', 'The project folder already exists.'); }
    throw error;
  }
  try {
    await writeFile(path.join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await writeFile(path.join(directory, '.gitignore'), 'node_modules/\ndist/\n.env\n.env.*\n*.log\n', { flag: 'wx' });
    await writeFile(path.join(directory, '.steamharnessignore'), '.git/\nnode_modules/\ndist/\n.env\n.env.*\n*.log\n', { flag: 'wx' });
    if (!files.some(file => file.filename === 'configuration.json')) await writeFile(path.join(directory,'configuration.json'), JSON.stringify({version:1,fields:[]},null,2)+'\n',{flag:'wx'});
    for (const file of files) {
      request.signal?.throwIfAborted();
      await mkdir(path.dirname(path.join(directory, file.filename)), { recursive: true });
      await writeFile(path.join(directory, file.filename), file.content, { flag: 'wx' });
    }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { id, name, directory, projectType: template.projectType, entryFile: template.entryFile };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function workflowRuntimeSource(source: string): string {
  return source.replaceAll('RuntimeApi', 'WorkflowRuntimeApi')
    .replaceAll('const steamharness =', 'const workflow =')
    .replaceAll('{ steamharness:', '{ workflow:')
    .replaceAll('}).steamharness;', '}).workflow;')
    .replaceAll('steamharness.', 'workflow.')
    .replaceAll('.defineProject', '.defineWorkflow');
}

/** Match untouched scaffold files to the SDK actually installed, including published SDKs from before the API rename. */
export async function prepareProjectTemplateRuntime(directory: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const templates = (await listProjectTemplates()).filter(template => template.projectType === manifest.steamHarness?.projectType && template.entryFile.endsWith('.ts'));
  if (!templates.length) { return false; }
  const runtime = await import(resolve('steamharness/runtime-api', pathToFileURL(path.join(directory, 'package.json')).href));
  const modern = typeof runtime.projectRuntimeApi?.defineProject === 'function';
  if (!modern && typeof runtime.workflowRuntimeApi?.defineWorkflow !== 'function') {
    throw new Error('The installed SDK does not support this project template.');
  }
  for (const template of templates) {
    const filename = path.join(directory, template.entryFile);
    const source = await readFile(filename, 'utf8');
    const canonical = await readFile(path.join(templateRoot, template.id, template.entryFile), 'utf8');
    const published = workflowRuntimeSource(canonical);
    // A setup retry must never rewrite user-edited source.
    if (![canonical, published].includes(source.replaceAll('\r\n', '\n'))) { continue; }
    const target = modern ? canonical : published;
    if (source.replaceAll('\r\n', '\n') === target) { return false; }
    signal?.throwIfAborted();
    await writeFile(filename, source.includes('\r\n') ? target.replaceAll('\n', '\r\n') : target);
    return true;
  }
  return false;
}
