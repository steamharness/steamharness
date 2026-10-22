import {isDeepStrictEqual} from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import ts from "typescript";
import { setTimeout as delay } from "node:timers/promises";
import {
  applyConfigurationAction, configurationSnapshot, exportConfigurations, parseConfigurationDefinition, readConfigurationState,
  bindConfigurationTemplate, configurationCapability, parseConfigurationTemplate, CONFIGURATION_TEMPLATE_FILE, type ProjectConfigurationTemplate,
  PROJECT_CONFIGURATION_FILE, ProjectConfigurationError, validateConfigurationAction, isConfigurationValue, AGENT_MODELS_CONFIGURATION_FIELD, AGENT_MODELS_CONFIGURATION_KEY,
  type ProjectConfigurationField, type ConfigurationValue, type ConfigurationValues, type ProjectConfigurationAction, type ProjectConfigurationSnapshot, type ProjectConfigurationState,
} from "@steamharness/project-configuration";
export * from "@steamharness/project-configuration";

const scope = new AsyncLocalStorage<ProjectConfigurationSnapshot>();
export function getConfig<T extends ConfigurationValue = ConfigurationValue>(key: string): T | undefined {
  const values = scope.getStore()?.values;
  return values && Object.hasOwn(values, key) ? values[key] as T : undefined;
}
export function getProjectConfiguration(): ProjectConfigurationSnapshot | undefined { return scope.getStore(); }
export function withProjectConfiguration<T>(snapshot: ProjectConfigurationSnapshot, run: () => T): T {
  const value = structuredClone(snapshot);
  const freeze = (item: unknown): void => { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(value); return scope.run(value, run);
}
export function currentConfigurationValues(): ConfigurationValues { return scope.getStore()?.values ?? {}; }

/** Static discovery only: opening configuration never imports or executes project code. */
export function projectUsesConfiguredAgentModels(projectDir: string): boolean {
  return discoverProjectAgentModels(projectDir);
}

type AgentModelSourceCache = Map<string, { stamp: string; found: boolean }>;
function discoverProjectAgentModels(projectDir: string, cache?: AgentModelSourceCache): boolean {
  const skipped = new Set(["node_modules", "vendor", "dist", "out", "build", "test", "tests", "__tests__", "fixtures"]);
  const scan = (directory: string): boolean => {
    if (!existsSync(directory)) return false;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || skipped.has(entry.name.toLowerCase())) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (scan(file)) return true; continue; }
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name) || /(?:\.d|\.test|\.spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const info = statSync(file);
      if (info.size > 1024 * 1024) continue;
      const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const previous = cache?.get(file);
      if (previous?.stamp === stamp) { if (previous.found) return true; continue; }
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const factories = new Set(["createAgentNode", "createAgentConversationProject", "createAgentProjectParamResolver", "defineAgentConversationExecutor"]);
      const imports = new Set<string>(), namespaces = new Set(["steamharness"]);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !["steamharness", "steamharness/agent"].includes(statement.moduleSpecifier.text) || statement.importClause?.isTypeOnly) continue;
        const clause = statement.importClause;
        if (clause?.name) namespaces.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const binding of clause.namedBindings.elements) {
          if (!binding.isTypeOnly && factories.has(binding.propertyName?.text ?? binding.name.text)) imports.add(binding.name.text);
        }
      }
      let found = false;
      const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isCallExpression(node)) {
          const expression = node.expression;
          if (ts.isIdentifier(expression) && imports.has(expression.text) ||
            ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text) && factories.has(expression.name.text)) { found = true; return; }
        }
        ts.forEachChild(node, visit);
      };
      visit(source); cache?.set(file, { stamp, found }); if (found) return true;
    }
    return false;
  };
  return scan(projectDir);
}

export function readProjectConfigurationDefinition(projectDir: string) {
  const file = path.join(projectDir, PROJECT_CONFIGURATION_FILE);
  const definition = existsSync(file) ? parseConfigurationDefinition(JSON.parse(readFileSync(file, "utf8"))) : { version: 1 as const, fields: [] as ProjectConfigurationField[] };
  if (!definition.fields.some(field => field.name === AGENT_MODELS_CONFIGURATION_KEY) && projectUsesConfiguredAgentModels(projectDir)) definition.fields.unshift(structuredClone(AGENT_MODELS_CONFIGURATION_FIELD));
  return definition;
}

/** Shared by Studio, CLI Web, CLI and direct local SDK execution. Values never enter project source. */
export async function createLocalProjectConfigurationStore(projectDir: string, options: { rootDir?: string; storageKey?: string; template?: ProjectConfigurationTemplate | null; fields?: ProjectConfigurationField[]; templateCacheDir?: string } = {}) {
  const directory = await realpath(projectDir);
  const agentModelSources: AgentModelSourceCache = new Map();
  const root = options.rootDir ?? path.join(os.homedir(), ".steamharness", "configurations");
  const key = createHash("sha256").update(options.storageKey ?? directory).digest("hex");
  const filename = path.join(root, `${key}.json`), lock = `${filename}.lock.sqlite`;
  const declared = async () => {
    let fields: ProjectConfigurationField[] = [];
    try { fields = parseConfigurationDefinition(JSON.parse(await readFile(path.join(directory, PROJECT_CONFIGURATION_FILE), "utf8"))).fields; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!fields.some(field => field.name === AGENT_MODELS_CONFIGURATION_KEY) && discoverProjectAgentModels(directory, agentModelSources)) fields.unshift(structuredClone(AGENT_MODELS_CONFIGURATION_FIELD));
    return fields;
  };
  const load = async (): Promise<ProjectConfigurationState> => {
    let stored: unknown;
    try { stored = JSON.parse(await readFile(filename, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let template = options.template;
    if (template === undefined && options.storageKey === undefined) {
      let source: string | undefined;
      try { source = await readFile(path.join(directory, CONFIGURATION_TEMPLATE_FILE), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (source === undefined) {
        // Once bound, removing source metadata cannot turn an installed project into an author.
        template = (stored as ProjectConfigurationState | undefined)?.template;
      } else {
        const candidate = parseConfigurationTemplate(JSON.parse(source));
        let cached: unknown;
        try { cached = JSON.parse(await readFile(configurationTemplateCachePath(candidate,options.templateCacheDir), "utf8")); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          throw new ProjectConfigurationError("Download this configuration version online before using it offline.");
        }
        if (JSON.stringify(cached) !== JSON.stringify(candidate)) throw new ProjectConfigurationError("Download this configuration version online before using it offline.");
        template = candidate;
      }
    }
    if(options.template===null && stored) delete (stored as ProjectConfigurationState).template;
    let state = readConfigurationState(stored, template?.fields ?? options.fields ?? await declared(), () => `default-${key.slice(0, 24)}`);
    if (template) state = bindConfigurationTemplate(state, template);
    if (!stored || !isDeepStrictEqual(stored,state)) {
      if (stored && state.revision === (stored as ProjectConfigurationState).revision) state.revision++;
      await atomic(filename, state);
    }
    return state;
  };
  const atomic = async (target: string, value: unknown) => {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  };
  const exclusive = async <T>(run: () => Promise<T>): Promise<T> => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    // SQLite releases this cross-process guard on crash; stale PID-file recovery cannot remove a new owner's lock.
    const guard = new DatabaseSync(lock);
    const started = Date.now();
    try {
      guard.exec("PRAGMA busy_timeout = 0");
      while (true) {
        try { guard.exec("BEGIN IMMEDIATE"); break; }
        catch (error) {
          if (![5, 6].includes((error as { errcode: number }).errcode)) throw error;
          if (Date.now() - started > 10_000) throw new ProjectConfigurationError("Configuration is busy. Try again.", "CONFIGURATION_BUSY");
          await delay(25);
        }
      }
      try { return await run(); } finally { guard.exec("ROLLBACK"); }
    } finally { guard.close(); }
  };
  const capabilities = (state: ProjectConfigurationState): ProjectConfigurationState => ({...state,fieldCapabilities:Object.fromEntries(state.fields.map(field=>[field.name,{...configurationCapability(state,field),paths:Object.fromEntries(Object.keys(field.paths??{}).map(pointer=>[pointer,configurationCapability(state,field,pointer)]))}]))});
  const read = async () => capabilities(await exclusive(load));
  return {
    read,
    async dispatch(call: ProjectConfigurationAction) {
      validateConfigurationAction(call);
      if (call.action.startsWith('publication.')) throw new ProjectConfigurationError("Official configuration publication requires an online connection.", "CONFIGURATION_ONLINE_REQUIRED");
      if (call.action === "get") return read();
      if (call.action === "export") return exportConfigurations(await read(), call.id);
      return exclusive(async () => {
        const next = applyConfigurationAction(await load(), call, randomUUID);
        await atomic(filename, next); return capabilities(next);
      });
    },
    async snapshot(options: { id?: string; runId?: string; required?: boolean; configuration?: ProjectConfigurationSnapshot } = {}): Promise<ProjectConfigurationSnapshot> {
      const provided = options.configuration === undefined ? undefined : structuredClone(parseSnapshot(options.configuration));
      const runFile = options.runId ? path.join(root, "snapshots", key, `${createHash("sha256").update(options.runId).digest("hex")}.json`) : undefined;
      if (runFile) return exclusive(async () => {
        try { return parseSnapshot(JSON.parse(await readFile(runFile, "utf8"))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const snapshot = provided ?? configurationSnapshot(await load(), options.id, options.required !== false);
        await atomic(runFile, snapshot);
        return snapshot;
      });
      return provided ?? configurationSnapshot(await read(), options.id, options.required !== false);
    },
  };
}

function parseSnapshot(value: unknown): ProjectConfigurationSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectConfigurationError("Invalid run configuration snapshot.");
  const snapshot = value as ProjectConfigurationSnapshot;
  if (typeof snapshot.id !== "string" || typeof snapshot.name !== "string" || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !isConfigurationValue(snapshot.values) || !snapshot.values || typeof snapshot.values !== "object" || Array.isArray(snapshot.values)) throw new ProjectConfigurationError("Invalid run configuration snapshot.");
  return snapshot;
}

function configurationTemplateCachePath(template: ProjectConfigurationTemplate,cacheDir = path.join(os.homedir(),".steamharness","configuration-templates")): string {
  return path.join(cacheDir, `${createHash('sha256').update(JSON.stringify(template)).digest('hex')}.json`);
}
/** Called only after an authenticated source download and its archive hash have been verified. */
export async function cacheVerifiedConfigurationTemplate(input: unknown, attachments: {id:string;bytes:Uint8Array}[] = [], options:{cacheDir?:string} = {}): Promise<void> {
  const template = parseConfigurationTemplate(input), filename = configurationTemplateCachePath(template,options.cacheDir);
  await mkdir(path.dirname(filename), {recursive:true,mode:0o700});
  for(const asset of template.attachments??[]) {
    const data=attachments.find(item=>item.id===asset.id)?.bytes;
    if(!data || createHash('sha256').update(data).digest('hex')!==asset.sha256) throw new ProjectConfigurationError('Downloaded configuration attachment hash mismatch.');
    const assetFile=path.join(path.dirname(filename),asset.sha256);
    await writeFile(assetFile,data,{mode:0o600});
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(temporary,JSON.stringify(template),{mode:0o600,flag:'wx'}); await rename(temporary,filename); }
  finally {await rm(temporary,{force:true});}
}

/** Offline previews read verified cache bytes, never a path supplied by project code. */
export async function readCachedConfigurationFile(projectDir:string,fileId:string,options:{rootDir?:string;templateCacheDir?:string}={}):Promise<{file:unknown;base64:string}|undefined> {
  const state=await (await createLocalProjectConfigurationStore(projectDir,options)).read();
  const asset=state.template?.attachments?.find(item=>item.id===fileId);if(!asset)return;
  let reference:ConfigurationValue|undefined;
  for(const configuration of state.template!.configurations) for(const field of state.template!.fields.filter(f=>f.type==='file')) {
    const value=configuration.values[field.name],files=field.multiple&&Array.isArray(value)?value:[value];
    reference ??= files.find(item=>item&&typeof item==='object'&&!Array.isArray(item)&&item.id===fileId);
  }
  const data=await readFile(path.join(path.dirname(configurationTemplateCachePath(state.template!,options.templateCacheDir)),asset.sha256));
  if(createHash('sha256').update(data).digest('hex')!==asset.sha256)throw new ProjectConfigurationError('Cached configuration attachment is invalid. Download this version again.');
  return {file:reference,base64:data.toString('base64')};
}
