import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { readProjectDeclarationFromDirectorySync } from "./node";
import { projectEntryFilePath } from "./artifacts";
import { isForbiddenReleasePath, parseProjectReleaseManifest, PROJECT_RELEASE_FILE, releasePath, type ProjectReleaseManifest } from "./release";

export const releaseHash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

interface ReleaseStructure {
  version: 1;
  report: Record<string, any>;
  scripts: { definedNodes: any[]; violations: any[] };
  agentModels?: { found: boolean; projectModels: boolean };
}
const structureLimit = 64 * 1024 * 1024;

function decodeReleaseStructure(bytes: Buffer, entryId: string): ReleaseStructure {
  const encoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (encoded?.version !== 2 || encoded.encoding !== "brotli-base64") throw new Error("Unsupported release structure format. Upgrade the host.");
  try {
    if (typeof encoded.data !== "string" || !encoded.data || Buffer.from(encoded.data, "base64").toString("base64") !== encoded.data
      || Object.keys(encoded).some(key => !["version", "encoding", "projectId", "entryId", "entryName", "projectType", "data"].includes(key))) throw new Error("Invalid structure encoding.");
    const decoded = brotliDecompressSync(Buffer.from(encoded.data, "base64"), { maxOutputLength: structureLimit });
    const structure = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
    if (structure?.version !== 1 || !structure.report || encoded.projectId !== structure.report.projectId || encoded.entryId !== entryId
      || encoded.entryId !== structure.report.entryId || encoded.entryName !== structure.report.entryName || encoded.projectType !== structure.report.projectType) throw new Error("Structure identity mismatch.");
    return structure;
  } catch (cause) {
    throw new Error(`Invalid release structure: ${entryId}`, { cause });
  }
}

function encodeReleaseStructure(bytes: Buffer, entryId: string): Buffer {
  const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const structure = document?.version === 2 ? decodeReleaseStructure(bytes, entryId) : document;
  if (structure?.version !== 1 || !structure.report || structure.report.entryId !== entryId) throw new Error(`Invalid release structure: ${entryId}`);
  const content = Buffer.from(JSON.stringify(structure));
  if (content.byteLength > structureLimit) throw new Error(`Release structure exceeds 64 MiB: ${entryId}`);
  const { projectId, entryName, projectType } = structure.report;
  return Buffer.from(JSON.stringify({ version: 2, encoding: "brotli-base64", projectId, entryId, entryName, projectType,
    data: brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).toString("base64") }));
}

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
    const structure = decodeReleaseStructure(readFileSync(releaseRegularFile(root, compiled.structure)), entry.entryId);
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
export function readReleaseStructureSync(root: string, entryId: string): ReleaseStructure | undefined {
  const manifest = readProjectReleaseSync(root);
  if (!manifest) return undefined;
  const entry = manifest.entries.find(item => item.entryId === entryId);
  if (!entry) throw new Error(`Entry is not included in this release: ${entryId}`);
  return decodeReleaseStructure(readFileSync(releaseRegularFile(root, entry.structure)), entryId);
}

function compactReleaseJson(bytes: Buffer, relative: string): Buffer {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(text);
  } catch (cause) {
    throw new Error(`Invalid release JSON: ${relative}`, { cause });
  }
  // Remove whitespace tokens without reserializing asset numbers or string escapes.
  return Buffer.from(text.replace(/"(?:\\.|[^"\\])*"|[ \t\r\n]+/g, token => token.startsWith('"') ? token : ""));
}

/** Called only by the local compiler or Server after controlled configuration publication. */
export function sealProjectRelease(root: string, manifest: Omit<ProjectReleaseManifest, "files">): ProjectReleaseManifest {
  const filename = releaseRegularFile(root, "steamharness.json");
  const declaration = JSON.parse(readFileSync(filename, "utf8"));
  declaration.distribution = { kind: "release", version: 1 };
  writeFileSync(filename, JSON.stringify(declaration));
  const structures = new Map(manifest.entries.map(entry => [entry.structure, entry.entryId]));
  const result = parseProjectReleaseManifest({ ...manifest, files: releaseFiles(root).map(relative => {
    const filename = releaseRegularFile(root, relative);
    let bytes: Buffer = readFileSync(filename);
    const entryId = structures.get(relative);
    if (entryId !== undefined || path.extname(relative).toLowerCase() === ".json") {
      const compact = entryId === undefined ? compactReleaseJson(bytes, relative) : encodeReleaseStructure(bytes, entryId);
      if (!bytes.equals(compact)) writeFileSync(filename, compact);
      bytes = compact;
    }
    return { path: relative, size: bytes.byteLength, sha256: releaseHash(bytes) };
  }) });
  writeFileSync(path.join(root, PROJECT_RELEASE_FILE), JSON.stringify(result));
  return readProjectReleaseSync(root)!;
}
