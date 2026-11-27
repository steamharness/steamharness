import { readFile, realpath, stat } from "node:fs/promises";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { PROJECT_UUID_PATTERN } from "./identity";
import { projectEntryFilePath } from "./artifacts";
import { PROJECT_MANIFEST_FILE, projectEntryConfigRoots, projectEntryKey, readProjectDeclaration, selectProjectEntry, type ProjectDeclaration, type ProjectEntryDeclaration, type ProjectEntry, type ProjectManifest } from "./index";

export function localDataHome(): string { return path.join(os.homedir(), '.steamharness'); }
export function localAccountsDirectory(): string { return path.join(localDataHome(), 'accounts'); }
export function localAccountDirectory(owner = 'local', accounts = localAccountsDirectory()): string {
  if (owner !== 'local' && !/^[a-f0-9]{64}$/.test(owner)) throw new Error('Invalid local account identity.');
  return path.join(accounts, owner);
}
export function localRuntimeAccountDirectory(): string { return localAccountDirectory(process.env.STEAMHARNESS_LOCAL_ACCOUNT_KEY); }

/** Do not follow a pre-existing link out of the product or account hierarchy. */
export function prepareLocalDirectory(directory: string): string {
  const home = localDataHome(), relative = path.relative(home, directory);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Invalid local storage directory.');
  mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 });
  let current = home;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!lstatSync(current).isDirectory()) throw new Error('Invalid local storage directory.');
  }
  return current;
}
export function localProjectDirectory(account: string, projectId: string): string {
  if (!PROJECT_UUID_PATTERN.test(projectId)) throw new Error('Invalid local project identity.');
  return path.join(account, 'projects', projectId.toLowerCase());
}
export function localEntryDirectory(account: string, projectId: string, entryId: string, scope?: { instanceId: string } | { workdir: string }): string {
  projectEntryKey(projectId, entryId);
  let base = localProjectDirectory(account, projectId);
  if (scope && 'instanceId' in scope) {
    if (!PROJECT_UUID_PATTERN.test(scope.instanceId)) throw new Error('Invalid local folder Bot identity.');
    base = path.join(base, 'instances', scope.instanceId.toLowerCase());
  } else if (scope) {
    if (!path.isAbsolute(scope.workdir)) throw new Error('Invalid assistant workspace directory.');
    const key = path.normalize(scope.workdir);
    base = path.join(base, 'workspaces', createHash('sha256').update(process.platform === 'win32' ? key.toLowerCase() : key).digest('hex'));
  }
  return path.join(base, 'entries', entryId);
}

export function readProjectDocumentSync(projectDir: string): Record<string, unknown> {
  const root = realpathSync(projectDir), file = realpathSync(path.join(root, PROJECT_MANIFEST_FILE));
  assertWithin(root, file);
  return JSON.parse(readFileSync(file, "utf8"));
}
export async function readProjectDocument(projectDir: string): Promise<Record<string, unknown>> {
  const root = await realpath(projectDir), file = await realpath(path.join(root, PROJECT_MANIFEST_FILE));
  assertWithin(root, file);
  return JSON.parse(await readFile(file, "utf8"));
}
export function readProjectDeclarationFromDirectorySync(projectDir: string): ProjectDeclaration {
  const root = realpathSync(projectDir), document = localProjectDocument(readProjectDocumentSync(root), root);
  const children = Object.fromEntries(projectEntryConfigRoots(document).map(relative => {
    const childRoot = realpathSync(path.join(root, relative)); assertWithin(root, childRoot);
    const file = realpathSync(path.join(childRoot, PROJECT_MANIFEST_FILE)); assertWithin(childRoot, file);
    return [relative, JSON.parse(readFileSync(file, "utf8"))];
  }));
  return readProjectDeclaration(document, children);
}
export async function readProjectDeclarationFromDirectory(projectDir: string): Promise<ProjectDeclaration> {
  const root = await realpath(projectDir), document = localProjectDocument(await readProjectDocument(root), root);
  const children = Object.fromEntries(await Promise.all(projectEntryConfigRoots(document).map(async relative => {
    const childRoot = await realpath(path.join(root, relative)); assertWithin(root, childRoot);
    const file = await realpath(path.join(childRoot, PROJECT_MANIFEST_FILE)); assertWithin(childRoot, file);
    return [relative, JSON.parse(await readFile(file, "utf8"))];
  })));
  return readProjectDeclaration(document, children);
}
/** Local storage needs a stable key even when the authored project has no release identity. Never write it to source. */
function localProjectDocument(document: Record<string, unknown>, root: string): Record<string, unknown> {
  if (typeof document.id === "string" && PROJECT_UUID_PATTERN.test(document.id)) return document;
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const bytes = createHash("sha256").update("steamharness:local-project:\0").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return { ...document, id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
}
export function readProjectManifestFromDirectorySync(projectDir: string): ProjectManifest {
  return readProjectDeclarationFromDirectorySync(projectDir);
}
export async function readProjectManifestFromDirectory(projectDir: string): Promise<ProjectManifest> {
  return readProjectDeclarationFromDirectory(projectDir);
}

export interface ResolvedProjectEntry {
  projectDir: string;
  manifest: ProjectManifest;
  registration: ProjectEntry;
  rootDir: string;
  modulePath: string;
  configurationPath?: string;
}
export interface ResolvedProjectDeclarationEntry extends Omit<ResolvedProjectEntry, "manifest" | "registration"> {
  manifest: ProjectDeclaration;
  registration: ProjectEntryDeclaration;
}
/** Resolve paths for metadata/configuration reads without depending on deployment IDs. */
export function resolveProjectDeclarationEntrySync(projectDir: string, entryId?: string): ResolvedProjectDeclarationEntry {
  const projectRoot = realpathSync(projectDir);
  const manifest = readProjectDeclarationFromDirectorySync(projectRoot);
  const registration = selectProjectEntry(manifest, entryId);
  return { projectDir: projectRoot, manifest, registration, ...resolveEntryFilesSync(projectRoot, registration) };
}
export function resolveProjectEntrySync(projectDir: string, entryId?: string): ResolvedProjectEntry {
  const projectRoot = realpathSync(projectDir);
  const manifest = readProjectManifestFromDirectorySync(projectRoot);
  const registration = selectProjectEntry(manifest, entryId);
  return { projectDir: projectRoot, manifest, registration, ...resolveEntryFilesSync(projectRoot, registration) };
}
function resolveEntryFilesSync(projectRoot: string, registration: Pick<ProjectEntry, "entryId" | "root" | "entry" | "configuration" | "type">): Pick<ResolvedProjectEntry, "rootDir" | "modulePath" | "configurationPath"> {
  const rootDir = realpathSync(path.resolve(projectRoot, registration.root));
  assertWithin(projectRoot, rootDir);
  if (!statSync(rootDir).isDirectory()) throw new Error(`Entry "${registration.entryId}" root is not a directory.`);
  const file = (relative: string) => { const target = realpathSync(path.resolve(rootDir, relative)); assertWithin(rootDir, target); if (!statSync(target).isFile()) throw new Error(`Registered entry path is not a file: ${relative}`); return target; };
  const moduleRoot = registration.type === "kanban" ? projectRoot : rootDir;
  const modulePath = realpathSync(path.resolve(projectRoot, projectEntryFilePath(registration)));
  assertWithin(moduleRoot, modulePath);
  if (!statSync(modulePath).isFile()) throw new Error(`Registered entry path is not a file: ${registration.entry}`);
  return { rootDir, modulePath, ...(registration.configuration === undefined ? {} : { configurationPath: file(registration.configuration) }) };
}
export async function resolveProjectEntry(projectDir: string, entryId?: string): Promise<ResolvedProjectEntry> {
  const root = await realpath(projectDir);
  const manifest = await readProjectManifestFromDirectory(root);
  return resolveRegisteredProjectEntry(root, manifest, selectProjectEntry(manifest, entryId));
}
export async function resolveRegisteredProjectEntry(projectDir: string, manifest: ProjectManifest, registration: ProjectEntry): Promise<ResolvedProjectEntry> {
  const root = await realpath(projectDir);
  const rootDir = await realpath(path.resolve(root, registration.root));
  assertWithin(root, rootDir);
  if (!(await stat(rootDir)).isDirectory()) throw new Error(`Entry "${registration.entryId}" root is not a directory.`);
  const modulePath = await resolveFile(registration.type === "kanban" ? root : rootDir, registration.entry);
  const configurationPath = registration.configuration === undefined ? undefined : await resolveFile(rootDir, registration.configuration);
  return { projectDir: root, manifest, registration, rootDir, modulePath, ...(configurationPath === undefined ? {} : { configurationPath }) };
}
async function resolveFile(root: string, relative: string): Promise<string> {
  const file = await realpath(path.resolve(root, relative));
  assertWithin(root, file);
  if (!(await stat(file)).isFile()) throw new Error(`Registered entry path is not a file: ${relative}`);
  return file;
}
function assertWithin(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Registered entry paths must stay inside their declared project root (including symlinks).");
}

/** Resolve existing ancestors so a data directory cannot re-enter source through a symlink. */
export function assertProjectDataDirectory(projectDir: string, dataDir: string): void {
  const projectRoot = realpathSync(projectDir);
  let ancestor = path.resolve(dataDir);
  const missing: string[] = [];
  while (true) {
    try { ancestor = realpathSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
  }
  const relative = path.relative(projectRoot, path.join(ancestor, ...missing));
  if (!relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error("Runtime data must be stored outside the project directory. Choose an application or user data directory.");
  }
}
