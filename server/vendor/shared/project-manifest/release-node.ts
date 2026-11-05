import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readProjectDeclarationFromDirectorySync } from "./node";
import { projectEntryFilePath } from "./artifacts";
import { isForbiddenReleasePath, parseProjectReleaseManifest, PROJECT_RELEASE_FILE, releasePath, type ProjectReleaseManifest } from "./release";

export const releaseHash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function releaseRegularFile(root: string, relative: string): string {
  const parts = releasePath(relative).split("/");
  let target = path.resolve(root);
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error(`Release path must be regular: ${relative}`);
  }
  return target;
}
export function releaseFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const item of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      // Installed dependencies and Git metadata are host-owned, never part of an inventory.
      if (item.name === "node_modules" || item.name === ".git" || item.name === ".DS_Store") continue;
      const relative = path.posix.join(directory, item.name);
      if (item.isSymbolicLink() || !item.isFile() && !item.isDirectory()) throw new Error(`Release path must be regular: ${relative}`);
      if (item.isDirectory()) visit(relative); else if (relative !== PROJECT_RELEASE_FILE) {
        if (isForbiddenReleasePath(relative)) throw new Error(`Forbidden release file: ${relative}`);
        result.push(relative);
      }
    }
  };
  visit(""); return result.sort();
}
export function readProjectReleaseSync(root: string): ProjectReleaseManifest | undefined {
  const filename = path.join(root, PROJECT_RELEASE_FILE);
  if (!existsSync(filename)) {
    const declaration = path.join(root, "steamharness.json");
    if (existsSync(declaration) && JSON.parse(readFileSync(declaration, "utf8")).distribution !== undefined) throw new Error("Release manifest is missing. Restore the complete release package.");
    return undefined;
  }
  const manifest = parseProjectReleaseManifest(JSON.parse(readFileSync(releaseRegularFile(root, PROJECT_RELEASE_FILE), "utf8")));
  const actual = releaseFiles(root);
  if (actual.length !== manifest.files.length || actual.some(file => !manifest.files.some(item => item.path === file))) throw new Error("Release inventory contains missing or unregistered files.");
  for (const file of manifest.files) {
    const bytes = readFileSync(releaseRegularFile(root, file.path));
    if (bytes.byteLength !== file.size || releaseHash(bytes) !== file.sha256) throw new Error(`Release file integrity check failed: ${file.path}`);
  }
  const document = JSON.parse(readFileSync(releaseRegularFile(root, "steamharness.json"), "utf8"));
  if (document.distribution?.kind !== "release" || document.distribution?.version !== 1 || document.release !== undefined) throw new Error("Invalid compiled project declaration.");
  const declaration = readProjectDeclarationFromDirectorySync(root);
  if (declaration.projectId !== manifest.projectId || declaration.version !== manifest.projectVersion || declaration.entries.length !== manifest.entries.length) throw new Error("Release project identity does not match its manifest.");
  for (const entry of declaration.entries) {
    const compiled = manifest.entries.find(item => item.entryId === entry.entryId);
    if (!compiled || compiled.root !== entry.root || compiled.entry !== entry.entry || compiled.configuration !== entry.configuration) throw new Error(`Release entry mismatch: ${entry.entryId}`);
    if (!manifest.files.some(file => file.path === projectEntryFilePath(entry))) throw new Error(`Release entry is missing: ${entry.entryId}`);
    const structure = JSON.parse(readFileSync(releaseRegularFile(root, compiled.structure), "utf8"));
    if (structure?.version !== 1 || structure.report?.projectId !== manifest.projectId || structure.report?.entryId !== entry.entryId || structure.report?.projectType !== entry.type
      || !Array.isArray(structure.scripts?.definedNodes) || !Array.isArray(structure.scripts?.violations) || structure.scripts.violations.length
      || !Array.isArray(structure.report?.diagnostics?.violations) || structure.report.diagnostics.violations.length) throw new Error(`Invalid release structure: ${entry.entryId}`);
    if (compiled.profiles) {
      if (!compiled.configuration) throw new Error(`Release profiles require a configuration: ${entry.entryId}`);
      const definition = JSON.parse(readFileSync(releaseRegularFile(root, `${entry.root}/${compiled.configuration}`), "utf8"));
      const profiles = definition.profilePolicy?.profiles;
      if (!Array.isArray(profiles) || profiles.length !== compiled.profiles.length || profiles.some(profile => !compiled.profiles!.includes(profile.key))) throw new Error(`Release configuration profile mismatch: ${entry.entryId}`);
    }
  }
  return manifest;
}
export function readReleaseStructureSync(root: string, entryId: string): { report: Record<string, any>; scripts: { definedNodes: any[]; violations: any[] }; agentModels?: { found: boolean; projectModels: boolean } } | undefined {
  const manifest = readProjectReleaseSync(root);
  if (!manifest) return undefined;
  const entry = manifest.entries.find(item => item.entryId === entryId);
  if (!entry) throw new Error(`Entry is not included in this release: ${entryId}`);
  return JSON.parse(readFileSync(releaseRegularFile(root, entry.structure), "utf8"));
}
/** Called only by the local compiler or Server after controlled configuration publication. */
export function sealProjectRelease(root: string, manifest: Omit<ProjectReleaseManifest, "files">): ProjectReleaseManifest {
  const filename = releaseRegularFile(root, "steamharness.json");
  const declaration = JSON.parse(readFileSync(filename, "utf8"));
  declaration.distribution = { kind: "release", version: 1 };
  writeFileSync(filename, JSON.stringify(declaration, null, 2) + "\n");
  const result = parseProjectReleaseManifest({ ...manifest, files: releaseFiles(root).map(relative => {
    const bytes = readFileSync(releaseRegularFile(root, relative));
    return { path: relative, size: bytes.byteLength, sha256: releaseHash(bytes) };
  }) });
  writeFileSync(path.join(root, PROJECT_RELEASE_FILE), JSON.stringify(result, null, 2) + "\n");
  return readProjectReleaseSync(root)!;
}
