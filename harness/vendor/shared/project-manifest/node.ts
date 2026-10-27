import { readFile, realpath, stat } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { readProjectManifest, selectProjectEntry, type ProjectEntry, type ProjectManifest } from "./index";

export interface ResolvedProjectEntry {
  projectDir: string;
  manifest: ProjectManifest;
  registration: ProjectEntry;
  rootDir: string;
  modulePath: string;
  configurationPath?: string;
}
export function resolveProjectEntrySync(projectDir: string, entryId?: string): ResolvedProjectEntry {
  const projectRoot = realpathSync(projectDir);
  const manifest = readProjectManifest(JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")));
  const registration = selectProjectEntry(manifest, entryId);
  const rootDir = realpathSync(path.resolve(projectRoot, registration.root));
  assertWithin(projectRoot, rootDir);
  if (!statSync(rootDir).isDirectory()) throw new Error(`Entry "${registration.entryId}" root is not a directory.`);
  const file = (relative: string) => { const target = realpathSync(path.resolve(rootDir, relative)); assertWithin(rootDir, target); if (!statSync(target).isFile()) throw new Error(`Registered entry path is not a file: ${relative}`); return target; };
  return { projectDir: projectRoot, manifest, registration, rootDir, modulePath: file(registration.entry), ...(registration.configuration === undefined ? {} : { configurationPath: file(registration.configuration) }) };
}
export async function resolveProjectEntry(projectDir: string, entryId?: string): Promise<ResolvedProjectEntry> {
  const root = await realpath(projectDir);
  const manifest = readProjectManifest(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
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
