import { i18n } from "@steamharness/i18n";
import { createReadStream, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { resolve as resolveModule } from "import-meta-resolve";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build, transform } from "esbuild";
import { inspectLocalProjectStructure, inspectProjectAgentModelUsage } from "steamharness";
import { inspectProjectScripts } from "steamharness/executor/rules";
import { readProjectDeclarationFromDirectory, readProjectDocument } from "@steamharness/project-manifest/node";
import { projectEntryFilePath, PROJECT_RELEASE_BASE_DIRECTORY, PROJECT_RELEASE_DIRECTORY, PROJECT_RELEASE_FILE, releasePath, isForbiddenReleasePath, type ProjectDistributionMode, type ProjectEntryDeclaration, type ProjectReleaseManifest } from "@steamharness/project-manifest";
import { readProjectReleaseSync, releaseHash, releaseRegularFile, sealProjectRelease } from "@steamharness/project-manifest/release-node";
import { parseConfigurationDefinition, type ProjectConfigurationDefinition } from "@steamharness/project-configuration";
import { readProjectCardMetadata } from "@steamharness/project-card-metadata";
import { generateDatabases } from "../database-generation";

export interface ProjectReleaseResult { directory: string; archive: string; buildId: string; entries: string[]; cached: boolean }
export interface ReleaseOptions { signal?: AbortSignal; progress?: (message: string) => void }
const ignored = new Set(["dist", "node_modules", ".git", ".data", ".local", ".workflow", ".steamharness", ".release", ".DS_Store"]);

async function sourceFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (ignored.has(item.name) || item.name === ".env" || item.name.startsWith(".env.") || item.name.startsWith("._")) continue;
    const relative = path.posix.join(prefix, item.name);
    if (item.isDirectory()) files.push(...await sourceFiles(root, relative));
    else if (item.isFile()) files.push(relative);
    else throw new Error(`Release inputs must be regular files: ${relative}`);
  }
  return files.sort();
}
async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update("steamharness.release:1:compiler:1\n");
  hash.update(await readFile(fileURLToPath(import.meta.url)));
  hash.update(await readFile(createRequire(import.meta.url).resolve("esbuild/package.json")));
  hash.update(packageVersion(root, "steamharness"));
  hash.update(await readFile(new URL(resolveModule("steamharness", pathToFileURL(path.join(root, "package.json")).href))));
  for (const file of await sourceFiles(root)) {
    const content = createHash("sha256");
    for await (const chunk of createReadStream(path.join(root, file))) content.update(chunk);
    hash.update(file + "\0" + content.digest("hex") + "\n");
  }
  return hash.digest("hex");
}
async function exists(filename: string): Promise<boolean> { try { await lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function regularDirectories(root: string, relative: string): Promise<void> {
  let directory = root;
  for (const part of releasePath(relative).split("/")) {
    directory = path.join(directory, part);
    try { await mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Release output must use ordinary directories: ${relative}`);
  }
}
async function command(argv: string[], cwd: string, options: ReleaseOptions): Promise<void> {
  options.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, detached: process.platform !== "win32", env: { ...process.env, COPYFILE_DISABLE: "1", STEAMHARNESS_RELEASE_BUILD: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (signal: NodeJS.Signals) => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ } };
    const abort = () => { stop("SIGTERM"); force = setTimeout(() => stop("SIGKILL"), 5000); force.unref(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    let last = "";
    const output = (bytes: Buffer) => { const text = bytes.toString(); last = (last + text).slice(-12_000); options.progress?.(text.trimEnd()); };
    child.stdout.on("data", output); child.stderr.on("data", output);
    child.once("error", error => { options.signal?.removeEventListener("abort", abort); clearTimeout(force); reject(error); });
    child.once("close", code => { options.signal?.removeEventListener("abort", abort); clearTimeout(force); code === 0 && !options.signal?.aborted ? resolve() : reject(options.signal?.reason ?? new Error(`Release command failed (${code}): ${argv.join(" ")}\n${last}`)); });
  });
}
async function writeJson(root: string, file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), JSON.stringify(value, null, 2) + "\n");
}
function sanitizeStructure(value: unknown, root = "", artifact = ""): unknown {
  if (typeof value === "string" && root) return value.replaceAll(root, ".");
  if (Array.isArray(value)) return value.map(item => sanitizeStructure(item, root, artifact));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [root ? key.replaceAll(root, ".") : key,
    key === "location" && artifact ? { file: artifact, line: 1, column: 1 }
      : ["source", "sourceText", "expression"].includes(key) && typeof item === "string" ? "[compiled]" : sanitizeStructure(item, root, artifact)]));
}
function selectProfiles(definition: ProjectConfigurationDefinition, profiles?: string[]): ProjectConfigurationDefinition {
  if (!profiles) return definition;
  const policy = definition.profilePolicy;
  if (!policy || profiles.some(key => !policy.profiles.some(profile => profile.key === key))) throw new Error("Release references an unknown configuration profile.");
  const selected = policy.profiles.filter(profile => profiles.includes(profile.key));
  if (!selected.some(profile => profile.key === policy.defaultProfileKey)) throw new Error("Release profiles must include the default profile.");
  const fields = definition.fields.map(field => {
    if (!selected.every(profile => field.name in profile.fixedValues)) return field;
    const allowed = selected.map(profile => profile.fixedValues[field.name]);
    return { ...field, defaultValue: selected.find(profile => profile.key === policy.defaultProfileKey)!.fixedValues[field.name], ...(field.options ? { options: field.options.filter(option => allowed.includes(option.value)) } : {}) };
  });
  return parseConfigurationDefinition({ ...definition, fields, profilePolicy: { ...policy, profiles: selected } });
}
async function copyAsset(sourceRoot: string, targetRoot: string, relative: string, destination = relative, omitSourceMaps = false): Promise<void> {
  releasePath(relative); releasePath(destination);
  if (omitSourceMaps && relative.endsWith(".map")) return;
  if (isForbiddenReleasePath(destination)) throw new Error(`Forbidden release asset: ${relative}`);
  const source = path.join(sourceRoot, relative), stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Release assets cannot be symbolic links: ${relative}`);
  if (stat.isDirectory()) {
    for (const child of await readdir(source)) await copyAsset(sourceRoot, targetRoot, path.posix.join(relative, child), path.posix.join(destination, child), omitSourceMaps);
    return;
  }
  releaseRegularFile(sourceRoot, relative);
  const target = path.join(targetRoot, destination);
  if (await exists(target)) throw new Error(`Release asset conflicts with generated output: ${destination}`);
  await mkdir(path.dirname(target), { recursive: true });
  let bytes = await readFile(source);
  if (/\.(?:[cm]?js|css)$/.test(relative)) {
    const output = await transform(bytes.toString("utf8"), { loader: relative.endsWith(".css") ? "css" : "js", minify: true, legalComments: "eof", sourcemap: false });
    bytes = Buffer.from(output.code);
  }
  await writeFile(target, bytes, { mode: stat.mode & 0o777 });
}
async function selectedAssets(root: string, patterns: string[]): Promise<string[]> {
  const files = await sourceFiles(root), selected = new Set<string>();
  for (const pattern of patterns) {
    releasePath(pattern, true);
    const matches = files.filter(file => path.matchesGlob(file, pattern) || file.startsWith(pattern + "/"));
    if (!matches.length) throw new Error(`Release asset pattern matches no files: ${pattern}`);
    matches.forEach(file => selected.add(file));
  }
  return [...selected].sort();
}
function packageVersion(root: string, name: string): string {
  const require = createRequire(path.join(root, "package.json"));
  let filename: string;
  try { filename = require.resolve(name + "/package.json"); }
  catch { filename = path.join(root, "node_modules", ...name.split("/"), "package.json"); }
  const value = JSON.parse(readFileSync(filename, "utf8")).version;
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value)) throw new Error(`Cannot resolve an exact release dependency version: ${name}`);
  return value;
}

export async function buildProjectRelease(directory: string, options: ReleaseOptions = {}): Promise<ProjectReleaseResult> {
  if (process.env.STEAMHARNESS_RELEASE_BUILD === "1") throw new Error("A release build command cannot recursively invoke steamharness release.");
  const root = await realpath(path.resolve(directory)), existing = readProjectReleaseSync(root);
  if (existing) return { directory: root, archive: "", buildId: existing.buildId, entries: existing.entries.map(entry => entry.entryId), cached: true };
  await regularDirectories(root, PROJECT_RELEASE_BASE_DIRECTORY);
  const output = path.join(root, PROJECT_RELEASE_DIRECTORY);
  if (await exists(path.join(root, `${PROJECT_RELEASE_BASE_DIRECTORY}/build.lock.sqlite`))) releaseRegularFile(root, `${PROJECT_RELEASE_BASE_DIRECTORY}/build.lock.sqlite`);
  const lock = new DatabaseSync(path.join(root, `${PROJECT_RELEASE_BASE_DIRECTORY}/build.lock.sqlite`));
  const started = Date.now();
  try { for (;;) {
    options.signal?.throwIfAborted();
    try { lock.exec("BEGIN IMMEDIATE"); break; } catch (error) {
      if (!/busy|locked/i.test(String(error))) throw error;
      if (Date.now() - started > 120_000) throw new Error("Another release build is still running. Retry after it completes.");
      await delay(100, undefined, { signal: options.signal });
    }
  } } catch (error) { lock.close(); throw error; }
  const stage = path.join(root, PROJECT_RELEASE_BASE_DIRECTORY, `stage-${randomUUID()}`), backup = path.join(root, PROJECT_RELEASE_BASE_DIRECTORY, `previous-${randomUUID()}`);
  let replaced = false;
  try {
    const declaration = await readProjectDeclarationFromDirectory(root), config = declaration.release ?? {};
    const selected = declaration.entries.filter(entry => (config.entries ?? declaration.entries.map(item => item.entryId)).includes(entry.entryId));
    const defaultEntry = config.defaultEntry ?? declaration.defaultEntry;
    if (!selected.some(entry => entry.entryId === defaultEntry)) throw new Error("The release must include its defaultEntry.");
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const inputHash = await fingerprint(root);
    const archive = path.join(root, PROJECT_RELEASE_BASE_DIRECTORY, `${String(pkg.name ?? declaration.name).replace(/[^a-zA-Z0-9_-]/g, "-")}-${declaration.version}.tgz`);
    let previous: ProjectReleaseManifest | undefined;
    try { previous = readProjectReleaseSync(output); } catch { /* An invalid output is rebuilt, never distributed. */ }
    if (previous?.inputHash === inputHash && await exists(archive)) return { directory: output, archive, buildId: previous.buildId, entries: previous.entries.map(entry => entry.entryId), cached: true };
    const commandArgs = config.build ?? (pkg.scripts?.build ? ["corepack", "pnpm", "run", "build"] : undefined);
    if (selected.some(entry => entry.type === "kanban") && !commandArgs) throw new Error("A release containing Kanban requires release.build or a package build script.");
    options.progress?.(i18n.language.startsWith("zh") ? "正在生成发行所需的数据库代码" : "Generating release database dependencies");
    for (const source of new Set([".", ...selected.map(entry => entry.root)])) if (await exists(path.join(root, source, "steamharness.database.ts"))) await generateDatabases(root, source);
    if (commandArgs) await command(commandArgs, root, options);
    await mkdir(stage);
    const sourceManifest = await readProjectDocument(root);
    const { release: _release, entries: _entries, defaultEntry: _default, builtinRelease: _builtin, ...identity } = sourceManifest;
    await writeJson(stage, "steamharness.json", { ...identity, defaultEntry, entries: selected.map(entry => ({ entryId: entry.entryId, root: `entries/${entry.entryId}` })) });
    const externals = config.externals ?? [];
    const dependencies = Object.fromEntries(externals.map(name => [name, packageVersion(root, name)]));
    await writeJson(stage, "package.json", { name: pkg.name ?? "steamharness-project", version: declaration.version, type: "module", private: true, ...(pkg.engines ? { engines: pkg.engines } : {}), devDependencies: { steamharness: packageVersion(root, "steamharness"), "@steamharness/cli": packageVersion(root, "@steamharness/cli") }, ...(externals.length ? { dependencies } : {}) });
    if (await exists(path.join(root, "config.json"))) {
      const source = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
      const aliases = new Set(selected.flatMap(entry => entry.knowledgeBases ?? []));
      await writeJson(stage, "config.json", { version: 1, knowledgeBases: Object.fromEntries(Object.entries(source.knowledgeBases ?? {}).filter(([alias]) => aliases.has(alias))) });
    }
    const entries: ProjectReleaseManifest["entries"] = [];
    for (const entry of selected) {
      options.signal?.throwIfAborted(); options.progress?.(i18n.language.startsWith("zh") ? `正在编译发行入口：${entry.entryId}` : `Compiling release entry: ${entry.entryId}`);
      const override = config.entryOverrides?.[entry.entryId] ?? {}, sourceRoot = path.join(root, entry.root), targetRoot = `entries/${entry.entryId}`;
      const targetEntry = entry.type === "kanban" ? `${targetRoot}/index.html` : "index.mjs";
      await mkdir(path.join(stage, targetRoot), { recursive: true });
      let configuration: ProjectConfigurationDefinition | undefined;
      const configurationFile = override.configuration ?? entry.configuration;
      if (configurationFile) configuration = selectProfiles(parseConfigurationDefinition(JSON.parse(await readFile(releaseRegularFile(sourceRoot, configurationFile), "utf8"))), override.profiles);
      else if (override.profiles) throw new Error(`Entry ${entry.entryId} has no configuration profiles.`);
      const { entryId, root: _sourceRoot, entry: _sourceEntry, configuration: _configuration, ...metadata } = entry;
      await writeJson(stage, `${targetRoot}/steamharness.json`, { ...metadata, entry: targetEntry, ...(configuration ? { configuration: "configuration.json" } : {}) });
      if (configuration) await writeJson(stage, `${targetRoot}/configuration.json`, configuration);
      const report = inspectLocalProjectStructure({ projectDir: root, entryId, ...(override.entry ? { sourceEntry: override.entry } : {}) });
      const sourceEntry = override.entry ?? entry.entry;
      const module = override.entry ? releaseRegularFile(sourceRoot, override.entry) : entry.type === "kanban" ? path.join(root, projectEntryFilePath(entry)) : releaseRegularFile(sourceRoot, sourceEntry);
      const scripts = entry.type === "kanban" ? { definedNodes: [], violations: [] } : inspectProjectScripts({ cwd: sourceRoot, projectName: entry.name, projectDir: sourceRoot, aggregateDir: root, entryFile: module });
      if (scripts.violations.length) throw new Error(`Release entry ${entryId} failed source validation: ${JSON.stringify(scripts.violations)}`);
      if (entry.type === "kanban") {
        const artifacts = path.dirname(module);
        for (const file of await readdir(artifacts)) {
          if (file.endsWith(".map")) continue;
          await copyAsset(artifacts, path.join(stage, targetRoot), file, file === path.basename(module) ? "index.html" : file, true);
        }
      } else {
        await build({ absWorkingDir: sourceRoot, entryPoints: { index: module }, outdir: path.join(stage, targetRoot), bundle: true, splitting: true, format: "esm", platform: "node", target: "es2022", minify: true, sourcemap: false, legalComments: "eof", metafile: true,
          external: ["steamharness", "steamharness/*", ...externals], outExtension: { ".js": ".mjs" }, logLevel: "silent",
          banner: { js: 'import {createRequire as __releaseRequire} from "node:module";const require=__releaseRequire(import.meta.url);' } });
      }
      for (const asset of await selectedAssets(sourceRoot, override.assets ?? [])) await copyAsset(sourceRoot, path.join(stage, targetRoot), asset);
      const artifactFile = entry.type === "kanban" ? targetEntry : `${targetRoot}/${targetEntry}`;
      const portable = sanitizeStructure(report, root, artifactFile) as typeof report;
      portable.workflow = { ...portable.workflow, dir: ".", files: [entry.type === "kanban" ? targetEntry : `${targetRoot}/${targetEntry}`] };
      // Hosts read the separate configuration definition, including publication filtering.
      portable.configuration = undefined;
      portable.entries = undefined;
      if (entry.type === "kanban") portable.kanban = { artifactDir: targetRoot, entry: "index.html" };
      await writeJson(stage, `${targetRoot}/structure.json`, { version: 1, report: portable, scripts: sanitizeStructure(scripts, root, artifactFile), agentModels: inspectProjectAgentModelUsage(sourceRoot, module, root) });
      entries.push({ entryId, root: targetRoot, entry: targetEntry, structure: `${targetRoot}/structure.json`, ...(configuration ? { configuration: "configuration.json" } : {}), ...(override.profiles ? { profiles: override.profiles } : {}) });
    }
    for (const file of await selectedAssets(root, config.files ?? [])) await copyAsset(root, stage, file);
    if (await fingerprint(root) !== inputHash) throw new Error("Project inputs changed during release generation. Save the project and retry.");
    options.signal?.throwIfAborted();
    const buildId = releaseHash(inputHash + JSON.stringify(entries));
    sealProjectRelease(stage, { kind: "steamharness.project.release", version: 1, projectId: declaration.projectId, projectVersion: declaration.version, inputHash, buildId, entries });
    const stagedArchive = `${stage}.tgz`;
    await command(["tar", "-czf", stagedArchive, "-C", stage, "."], root, options);
    options.signal?.throwIfAborted();
    const oldArchive = `${backup}.tgz`;
    let archiveBackedUp = false, installed = false;
    try {
      if (await exists(archive)) { await rename(archive, oldArchive); archiveBackedUp = true; }
      if (await exists(output)) { await rename(output, backup); replaced = true; }
      await rename(stage, output); installed = true;
      await rename(stagedArchive, archive);
    } catch (error) {
      if (installed) await rm(output, { recursive: true, force: true });
      if (replaced) await rename(backup, output);
      if (archiveBackedUp) await rename(oldArchive, archive);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    await rm(oldArchive, { force: true });
    return { directory: output, archive, buildId, entries: entries.map(entry => entry.entryId), cached: false };
  } finally {
    await rm(stage, { recursive: true, force: true }); await rm(`${stage}.tgz`, { force: true }); lock.close();
  }
}

export async function resolveProjectDistribution(directory: string, mode: ProjectDistributionMode = "auto", options: ReleaseOptions = {}): Promise<{ directory: string; mode: "source" | "release"; release?: ProjectReleaseResult }> {
  const root = await realpath(path.resolve(directory));
  if (readProjectReleaseSync(root)) return { directory: root, mode: "release" };
  const document = await readProjectDocument(root);
  if (mode === "release" || mode === "auto" && (document.release !== undefined || await exists(path.join(root, PROJECT_RELEASE_DIRECTORY, PROJECT_RELEASE_FILE)))) {
    const release = await buildProjectRelease(root, options); return { directory: release.directory, mode: "release", release };
  }
  return { directory: root, mode: "source" };
}

export async function prepareReleaseRun(directory: string, options: ReleaseOptions & { entryId?: string } = {}): Promise<ProjectReleaseResult> {
  const result = await buildProjectRelease(directory, options);
  const declaration = await readProjectDeclarationFromDirectory(result.directory);
  const entryId = options.entryId ?? declaration.defaultEntry;
  if (!declaration.entries.some(entry => entry.entryId === entryId)) throw new Error(`Entry is not included in this release: ${entryId}`);
  const sourceRoot = await realpath(path.resolve(directory));
  if (sourceRoot === result.directory) return result;
  const snapshotParent = `${PROJECT_RELEASE_BASE_DIRECTORY}/snapshots/${result.buildId}`;
  const snapshot = path.join(sourceRoot, snapshotParent, entryId);
  if (!await exists(snapshot)) {
    await regularDirectories(sourceRoot, snapshotParent);
    const temporary = `${snapshot}.${randomUUID()}`;
    try {
      await cp(result.directory, temporary, { recursive: true, errorOnExist: true });
      const manifest = readProjectReleaseSync(temporary)!;
      const document = await readProjectDocument(temporary);
      const defaultType = declaration.entries.find(entry => entry.entryId === declaration.defaultEntry)!.type;
      await writeJson(temporary, "steamharness.json", { ...document, projectCard: readProjectCardMetadata(document, defaultType), defaultEntry: entryId });
      sealProjectRelease(temporary, manifest);
      await rename(temporary, snapshot);
    }
    catch (error) { if (!await exists(snapshot)) throw error; }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const stat = await lstat(snapshot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Release snapshots must use regular directories.");
  const verified = readProjectReleaseSync(snapshot);
  const current = readProjectReleaseSync(result.directory);
  if (!verified || verified.buildId !== result.buildId || verified.projectId !== current?.projectId || (await readProjectDeclarationFromDirectory(snapshot)).defaultEntry !== entryId) throw new Error("Release snapshot identity mismatch.");
  return { ...result, directory: snapshot };
}
