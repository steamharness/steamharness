import { readFile, realpath, stat } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { PROJECT_CONFIG_FILE, readProjectDeclaration, readProjectManifest, selectProjectEntry, type ProjectDeclaration, type ProjectEntryDeclaration, type ProjectEntry, type ProjectManifest } from "./index";

export function readProjectManifestFromDirectorySync(projectDir: string, env: NodeJS.ProcessEnv = process.env): ProjectManifest {
  const root = realpathSync(projectDir);
  let config: unknown;
  try {
    const file = realpathSync(path.join(root, PROJECT_CONFIG_FILE));
    assertWithin(root, file);
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return readProjectManifest(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")), config, env);
}

export async function readProjectManifestFromDirectory(projectDir: string, env: NodeJS.ProcessEnv = process.env): Promise<ProjectManifest> {
  const root = await realpath(projectDir);
  let config: unknown;
  try {
    const file = await realpath(path.join(root, PROJECT_CONFIG_FILE));
    assertWithin(root, file);
    config = JSON.parse(await readFile(file, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return readProjectManifest(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")), config, env);
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
  const manifest = readProjectDeclaration(JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")));
  const registration = selectProjectEntry(manifest, entryId);
  return { projectDir: projectRoot, manifest, registration, ...resolveEntryFilesSync(projectRoot, registration) };
}
export function resolveProjectEntrySync(projectDir: string, entryId?: string, env?: NodeJS.ProcessEnv): ResolvedProjectEntry {
  const projectRoot = realpathSync(projectDir);
  const manifest = readProjectManifestFromDirectorySync(projectRoot, env);
  const registration = selectProjectEntry(manifest, entryId);
  return { projectDir: projectRoot, manifest, registration, ...resolveEntryFilesSync(projectRoot, registration) };
}
function resolveEntryFilesSync(projectRoot: string, registration: Pick<ProjectEntry, "entryId" | "root" | "entry" | "configuration">): Pick<ResolvedProjectEntry, "rootDir" | "modulePath" | "configurationPath"> {
  const rootDir = realpathSync(path.resolve(projectRoot, registration.root));
  assertWithin(projectRoot, rootDir);
  if (!statSync(rootDir).isDirectory()) throw new Error(`Entry "${registration.entryId}" root is not a directory.`);
  const file = (relative: string) => { const target = realpathSync(path.resolve(rootDir, relative)); assertWithin(rootDir, target); if (!statSync(target).isFile()) throw new Error(`Registered entry path is not a file: ${relative}`); return target; };
  return { rootDir, modulePath: file(registration.entry), ...(registration.configuration === undefined ? {} : { configurationPath: file(registration.configuration) }) };
}
export async function resolveProjectEntry(projectDir: string, entryId?: string, env?: NodeJS.ProcessEnv): Promise<ResolvedProjectEntry> {
  const root = await realpath(projectDir);
  const manifest = await readProjectManifestFromDirectory(root, env);
  return resolveRegisteredProjectEntry(root, manifest, selectProjectEntry(manifest, entryId));
}
export async function resolveRegisteredProjectEntry(projectDir: string, manifest: ProjectManifest, registration: ProjectEntry): Promise<ResolvedProjectEntry> {
  const root = await realpath(projectDir);
  const rootDir = await realpath(path.resolve(root, registration.root));
  assertWithin(root, rootDir);
  if (!(await stat(rootDir)).isDirectory()) throw new Error(`Entry "${registration.entryId}" root is not a directory.`);
  const modulePath = await resolveFile(rootDir, registration.entry);
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
