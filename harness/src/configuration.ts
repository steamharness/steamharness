import { projectEntrySources } from "./project-sources";
import { resolveProjectDeclarationEntrySync } from "@steamharness/project-manifest/node";
import { projectEntryKey } from "@steamharness/project-manifest";
import {isDeepStrictEqual} from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import ts from "typescript";
import { getUserSettings, type UserSettings } from "./user-settings";
import { setTimeout as delay } from "node:timers/promises";
import {resolveProjectConfigurationAccess,type ConfigurationConnection} from './configuration-access';
export {resolveProjectConfigurationAccess} from './configuration-access';
import {
  applyConfigurationAction, configurationSnapshot, configurationAgentModelPolicy, exportConfigurations, parseAgentModelPolicy, parseConfigurationDefinition, readConfigurationState,
  bindConfigurationTemplate, configurationCapability, parseConfigurationTemplate, configurationTemplatePath, CONFIGURATION_TEMPLATE_FILE, type ProjectConfigurationTemplate,
  PROJECT_CONFIGURATION_FILE, ProjectConfigurationError, validateConfigurationAction, isConfigurationValue, AGENT_MODELS_CONFIGURATION_FIELD, AGENT_MODELS_CONFIGURATION_KEY,
  bindConfigurationProfiles,configurationAccessView,validateConfigurationSnapshotAccess,type ConfigurationAccess,type ConfigurationProfilePolicy,
  type AgentModelPolicy, type ProjectConfigurationDefinition, type ProjectConfigurationField, type ConfigurationValue, type ConfigurationValues, type ProjectConfigurationAction, type ProjectConfigurationSnapshot, type ProjectConfigurationState,
} from "@steamharness/project-configuration";
export * from "@steamharness/project-configuration";

const scope = new AsyncLocalStorage<ProjectConfigurationSnapshot>();
const directoryScope = new AsyncLocalStorage<{ directory: string; entryId?: string }>();
export function getConfig<T extends ConfigurationValue = ConfigurationValue>(key: string): T | undefined {
  const values = scope.getStore()?.values;
  return values && Object.hasOwn(values, key) ? values[key] as T : undefined;
}
export function getProjectConfiguration(): ProjectConfigurationSnapshot | undefined { return scope.getStore(); }
export function withProjectConfiguration<T>(snapshot: ProjectConfigurationSnapshot, run: () => T, projectDir?:string, entryId?:string): T {
  const value = structuredClone(snapshot);
  const freeze = (item: unknown): void => { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(value); return scope.run(value,()=>projectDir?directoryScope.run({ directory: projectDir, entryId },run):run());
}
export function currentConfigurationValues(): ConfigurationValues { return scope.getStore()?.values ?? {}; }

/** Static discovery only: opening configuration never imports or executes project code. */
export function projectUsesConfiguredAgentModels(projectDir: string, entryFile?: string): boolean {
  return discoverProjectAgentModels(projectDir, undefined, entryFile);
}

type AgentModelSourceCache = Map<string, { stamp: string; found: boolean; projectModels: boolean }>;
function discoverProjectAgentModels(projectDir: string, cache?: AgentModelSourceCache, entryFile?: string, projectOnly = false): boolean {
  const skipped = new Set(["node_modules", "vendor", "dist", "out", "build", "test", "tests", "__tests__", "fixtures"]);
  const scan = (directory: string): boolean => {
    if (!existsSync(directory)) return false;
    for (const entry of entryFile ? projectEntrySources(projectDir, entryFile).map(file => ({ name: path.relative(directory, file), isDirectory: () => false, isFile: () => true })) : readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || skipped.has(entry.name.toLowerCase())) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (scan(file)) return true; continue; }
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name) || /(?:\.d|\.test|\.spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const info = statSync(file);
      if (info.size > 1024 * 1024) continue;
      const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const previous = cache?.get(file);
      if (previous?.stamp === stamp) { if (projectOnly ? previous.projectModels : previous.found) return true; continue; }
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
      // Resolve local constants without evaluating project code. Unknown options
      // may select project models, so keep that configuration available.
      const constants = new Map<string, ts.Expression>();
      const collect = (node: ts.Node): void => {
        if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const)) for (const declaration of node.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
        }
        ts.forEachChild(node, collect);
      };
      collect(source);
      const unwrap = (value: ts.Expression, seen = new Set<string>()): ts.Expression => {
        if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isTypeAssertionExpression(value)) return unwrap(value.expression, seen);
        if (ts.isIdentifier(value) && constants.has(value.text) && !seen.has(value.text)) return unwrap(constants.get(value.text)!, new Set([...seen, value.text]));
        return value;
      };
      const modelSource = (argument?: ts.Expression, seen = new Set<ts.Node>()): "user-settings" | "project" | "unknown" | undefined => {
        if (!argument) return undefined;
        const value = unwrap(argument);
        if (ts.isIdentifier(value) && value.text === "undefined") return undefined;
        if (!ts.isObjectLiteralExpression(value) || seen.has(value)) return "unknown";
        const visited = new Set([...seen, value]);
        let selected: ReturnType<typeof modelSource>;
        for (const property of value.properties) {
          if (ts.isSpreadAssignment(property)) { selected = modelSource(property.expression, visited) ?? selected; continue; }
          const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
          if (name !== "modelSource") continue;
          const expression = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
          const mode = expression && unwrap(expression);
          selected = mode && ts.isStringLiteral(mode) && (mode.text === "user-settings" || mode.text === "project") ? mode.text : "unknown";
        }
        return selected;
      };
      let found = false, projectModels = false;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const expression = node.expression;
          if (ts.isIdentifier(expression) && imports.has(expression.text) ||
            ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text) && factories.has(expression.name.text)) {
            found = true;
            const mode = modelSource(node.arguments[0]);
            projectModels ||= mode === "project" || mode === "unknown";
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source); cache?.set(file, { stamp, found, projectModels }); if (projectOnly ? projectModels : found) return true;
    }
    return false;
  };
  return scan(projectDir);
}

function usesOnlyUserAgentModels(projectDir: string, entryFile?: string, cache?: AgentModelSourceCache, settings = getUserSettings()): boolean {
  return settings.agent.models !== undefined && discoverProjectAgentModels(projectDir, cache, entryFile)
    && !discoverProjectAgentModels(projectDir, cache, entryFile, true);
}

/** Host presentation only: keep saved project models intact for standalone CLI use. */
function withoutProjectAgentModels(state: ProjectConfigurationState): ProjectConfigurationState {
  const fields = (items: ProjectConfigurationField[]) => items.filter(field => field.name !== AGENT_MODELS_CONFIGURATION_KEY);
  const values = (items: ConfigurationValues) => {
    const { [AGENT_MODELS_CONFIGURATION_KEY]: _ignored, ...remaining } = items;
    return remaining;
  };
  const profiles = (policy: ConfigurationProfilePolicy) => ({ ...policy, profiles: policy.profiles.map(profile => ({ ...profile, fixedValues: values(profile.fixedValues) })) });
  return { ...state, fields: fields(state.fields), customFields: fields(state.customFields),
    configurations: state.configurations.map(configuration => ({ ...configuration, values: values(configuration.values) })),
    ...(state.profilePolicy ? { profilePolicy: profiles(state.profilePolicy) } : {}),
    ...(state.conflicts ? { conflicts: state.conflicts.filter(conflict => conflict.key !== AGENT_MODELS_CONFIGURATION_KEY) } : {}),
    ...(state.shadowedCustomFields ? { shadowedCustomFields: fields(state.shadowedCustomFields) } : {}),
    ...(state.template ? { template: { ...state.template, fields: fields(state.template.fields),
      configurations: state.template.configurations.map(configuration => ({ ...configuration, values: values(configuration.values) })),
      ...(state.template.profilePolicy ? { profilePolicy: profiles(state.template.profilePolicy) } : {}) } } : {}) };
}

export function readProjectConfigurationDefinition(projectDir: string, entryId?: string) {
  const resolved = resolveProjectDeclarationEntrySync(projectDir, entryId);
  const file = resolved.configurationPath;
  projectDir = resolved.rootDir;
  const definition: ProjectConfigurationDefinition = file && existsSync(file) ? parseConfigurationDefinition(JSON.parse(readFileSync(file, "utf8"))) : { version: 1, fields: [] };
  if (!definition.fields.some(field => field.name === AGENT_MODELS_CONFIGURATION_KEY) && projectUsesConfiguredAgentModels(projectDir, resolved.modulePath)) definition.fields.unshift({...structuredClone(AGENT_MODELS_CONFIGURATION_FIELD),...definition.agentModelPolicy});
  if (usesOnlyUserAgentModels(projectDir, resolved.modulePath)) {
    definition.agentModelPolicy = configurationAgentModelPolicy(definition);
    definition.fields = definition.fields.filter(field => field.name !== AGENT_MODELS_CONFIGURATION_KEY);
  }
  return definition;
}

/** Shared by application ID across Studio, CLI Web, CLI and local SDK execution. Values never enter project source. */
export interface LocalProjectConfigurationOptions {
  entryId?: string; entryFile?: string; templateFile?: string; identity?: string; configurationFile?: string; accessProjectDir?: string;
  rootDir?: string; storageKey?: string; template?: ProjectConfigurationTemplate | null;
  fields?: ProjectConfigurationField[]; agentModelPolicy?: AgentModelPolicy; templateCacheDir?: string;
  profilePolicy?: ConfigurationProfilePolicy;
  /** Trusted host injection. These options are never taken from RPC action payloads. */
  access?: ConfigurationAccess;
  connection?:()=>ConfigurationConnection|null;
  userSettings?: () => UserSettings | undefined;
}
export async function createLocalProjectConfigurationStore(projectDir: string, options: LocalProjectConfigurationOptions = {}) {
  const resolved = resolveProjectDeclarationEntrySync(projectDir, options.entryId);
  return createLocalEntryConfigurationStore(resolved.rootDir, { ...options, entryId: resolved.registration.entryId, entryFile: resolved.modulePath, templateFile: path.join(resolved.projectDir, configurationTemplatePath(resolved.registration.entryId)), identity: projectEntryKey(resolved.manifest.projectId, resolved.registration.entryId), configurationFile: resolved.configurationPath, accessProjectDir: resolved.projectDir });
}
async function createLocalEntryConfigurationStore(projectDir: string, options: LocalProjectConfigurationOptions = {}) {
  const directory=await realpath(projectDir);
  if (!options.identity || !options.entryId) throw new Error("A registered project entry is required.");
  const agentModelSources: AgentModelSourceCache = new Map();
  const target=async(fresh:boolean)=>{
    let definition: Pick<ProjectConfigurationDefinition,'profilePolicy'> = options;
    if(options.fields===undefined){
      try { definition=parseConfigurationDefinition(JSON.parse(await readFile(options.configurationFile ?? path.join(directory,".no-entry-configuration"),'utf8'))); }
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;definition={};}
    }
    let template=options.template;
    if(template===undefined){try{template=parseConfigurationTemplate(JSON.parse(await readFile(options.templateFile ?? path.join(directory, configurationTemplatePath(options.entryId!)),'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    const profilePolicy=template?.profilePolicy??definition.profilePolicy;
    const access=profilePolicy?(options.access??await resolveProjectConfigurationAccess(options.accessProjectDir ?? directory,options.connection?.(),fresh)):undefined;
    const storageKey=profilePolicy&&options.storageKey===undefined?JSON.stringify([options.identity!,access!.subject]):options.storageKey;
    return createProjectConfigurationStoreForIdentity(directory,{...options,storageKey,profilePolicy,access},agentModelSources,options.storageKey===undefined);
  };
  return {
    read:async(fresh=false)=>(await target(fresh)).read(),
    dispatch:async(call:ProjectConfigurationAction)=>(await target(true)).dispatch(call),
    snapshot:async(input:{id?:string;runId?:string;required?:boolean;configuration?:ProjectConfigurationSnapshot;refreshAccess?:boolean;requireExisting?:boolean}={})=>(await target(input.refreshAccess!==false)).snapshot(input),
  };
}

/** Rechecked before a restricted tool executes; a saved run is not an authorization grant. */
export async function assertProjectConfigurationAccess(projectDir:string,configuration=getProjectConfiguration(),entryId=directoryScope.getStore()?.entryId):Promise<void>{
  if(configuration?.profilePolicyVersion!==undefined) {
    const state=await (await createLocalProjectConfigurationStore(projectDir, { entryId })).read(true);
    const capability=state.capabilities;
    // The run boundary has verified frozen template values. Tool boundaries
    // recheck current authority without replacing those values after an upgrade.
    validateConfigurationSnapshotAccess({...state,template:undefined},configuration,capability?{subject:capability.subject,role:capability.role,online:capability.online}:undefined);
  }
}
export async function assertCurrentProjectConfigurationAccess():Promise<void>{
  const snapshot=getProjectConfiguration();
  if(snapshot?.profilePolicyVersion===undefined)return;
  const directory=directoryScope.getStore();
  if(!directory)throw new ProjectConfigurationError('A restricted run requires a verified project directory.','CONFIGURATION_FORBIDDEN');
  await assertProjectConfigurationAccess(directory.directory,snapshot,directory.entryId);
}

async function createProjectConfigurationStoreForIdentity(projectDir: string, options: LocalProjectConfigurationOptions = {}, agentModelSources:AgentModelSourceCache=new Map(), local=options.storageKey===undefined) {
  const directory = await realpath(projectDir);
  const root = options.rootDir ?? path.join(os.homedir(), ".steamharness", "configurations");
  const key = createHash("sha256").update(options.storageKey ?? options.identity!).digest("hex");
  const filename = path.join(root, `${key}.json`), lock = `${filename}.lock.sqlite`;

  // Run snapshots use the same project and entry identity as configuration profiles.
  const runKey = key;
  const settingsModelsOnly = () => usesOnlyUserAgentModels(directory, options.entryFile, agentModelSources, options.userSettings?.() ?? getUserSettings());
  const view = (state: ProjectConfigurationState) => settingsModelsOnly() ? withoutProjectAgentModels(state) : state;
  const snapshotView = (snapshot: ProjectConfigurationSnapshot): ProjectConfigurationSnapshot => {
    if (!settingsModelsOnly()) return snapshot;
    const { [AGENT_MODELS_CONFIGURATION_KEY]: _ignored, ...values } = snapshot.values;
    return { ...snapshot, values };
  };
  const validateSnapshot = (state: ProjectConfigurationState, snapshot: ProjectConfigurationSnapshot) => validateConfigurationSnapshotAccess(view(state), snapshotView(snapshot), options.access);
  const declared = async () => {
    let definition: ProjectConfigurationDefinition = {version:1,fields:[]};
    try { definition = parseConfigurationDefinition(JSON.parse(await readFile(options.configurationFile ?? path.join(directory, ".no-entry-configuration"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!definition.fields.some(field => field.name === AGENT_MODELS_CONFIGURATION_KEY) && discoverProjectAgentModels(directory, agentModelSources, options.entryFile)) definition.fields.unshift({...structuredClone(AGENT_MODELS_CONFIGURATION_FIELD),...definition.agentModelPolicy});
    return definition;
  };
  const verifiedTemplate = async (value: ProjectConfigurationTemplate): Promise<boolean> => {
    try { return isDeepStrictEqual(JSON.parse(await readFile(configurationTemplateCachePath(value,options.templateCacheDir), "utf8")),value); }
    catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error; }
  };
  const load = async (restoring = false): Promise<ProjectConfigurationState> => {
    let stored: unknown;
    try { stored = JSON.parse(await readFile(filename, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let template = options.template;
    if (template === undefined && local) {
      let source: string | undefined;
      try { source = await readFile(options.templateFile ?? path.join(directory, configurationTemplatePath(options.entryId!)), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (source === undefined) {
        // Once bound, removing source metadata cannot turn an installed project into an author.
        template = (stored as ProjectConfigurationState | undefined)?.template;
      } else {
        const candidate = parseConfigurationTemplate(JSON.parse(source));
        if (candidate.entryId !== options.entryId || candidate.projectId !== options.identity?.split(':')[0]) throw new ProjectConfigurationError("Configuration template belongs to another project or entry.");
        if(await verifiedTemplate(candidate))template=candidate;
        else {
          // Waiting runs may keep the last verified version while a new source
          // download is incomplete. New reads and writes still require it.
          const previous=(stored as ProjectConfigurationState|undefined)?.template;
          if(!restoring||!previous||!await verifiedTemplate(previous))throw new ProjectConfigurationError("Download this configuration version online before using it offline.");
          template=parseConfigurationTemplate(previous);
        }
      }
    }
    if(options.template===null && stored) delete (stored as ProjectConfigurationState).template;
    const definition = options.fields === undefined ? await declared() : {fields:options.fields,agentModelPolicy:options.agentModelPolicy};
    const policy = configurationAgentModelPolicy(definition,template??{fields:[]});
    let state = readConfigurationState(stored, template?.fields ?? definition.fields, () => `default-${key.slice(0, 24)}`,policy);
    if (template) state = bindConfigurationTemplate(state, template);
    if(options.profilePolicy)state=bindConfigurationProfiles(state,options.profilePolicy);
    if(state.profilePolicy)state.activeConfigurationId=configurationAccessView(state,options.access).activeConfigurationId;
    const changed = !isDeepStrictEqual(stored,state);
    if (!stored || changed) {
      if (stored && changed && state.revision === (stored as ProjectConfigurationState).revision) state.revision++;
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
  const capabilities = (state: ProjectConfigurationState): ProjectConfigurationState => ({...configurationAccessView(state,options.access),fieldCapabilities:Object.fromEntries(state.fields.map(field=>[field.name,{...configurationCapability(state,field),paths:Object.fromEntries(Object.keys(field.paths??{}).map(pointer=>[pointer,configurationCapability(state,field,pointer)]))}]))});
  const read = async () => capabilities(view(await exclusive(load)));
  return {
    read,
    async dispatch(call: ProjectConfigurationAction) {
      validateConfigurationAction(call);
      if (call.action.startsWith('publication.')) throw new ProjectConfigurationError("Official configuration publication requires an online connection.", "CONFIGURATION_ONLINE_REQUIRED");
      if (call.action === "get") return read();
      if (call.action === "export") return exportConfigurations(await read(), call.id,options.access);
      return exclusive(async () => {
        const next = applyConfigurationAction(await load(), call, randomUUID,undefined,options.access);
        await atomic(filename, next); return capabilities(view(next));
      });
    },
    async snapshot(snapshotOptions: { id?: string; runId?: string; required?: boolean; configuration?: ProjectConfigurationSnapshot; requireExisting?:boolean } = {}): Promise<ProjectConfigurationSnapshot> {
      const provided = snapshotOptions.configuration === undefined ? undefined : structuredClone(parseSnapshot(snapshotOptions.configuration));
      const runFile = snapshotOptions.runId ? path.join(root, "snapshots", runKey, `${createHash("sha256").update(snapshotOptions.runId).digest("hex")}.json`) : undefined;
      if (runFile) return exclusive(async () => {
        try {
          const persisted=JSON.parse(await readFile(runFile, "utf8"));
          const wrapped=persisted && typeof persisted==='object' && !Array.isArray(persisted) && Object.hasOwn(persisted,'snapshot');
          const saved=parseSnapshot(wrapped?persisted.snapshot:persisted);
          let state=await load(true);
          if(wrapped) {
            // Values stay frozen to the run's verified template. Authority and
            // model restrictions still come from the current project state.
            const template=parseConfigurationTemplate(persisted.template);
            const trusted=isDeepStrictEqual(template,state.template)||await verifiedTemplate(template);
            if(!trusted || template.projectId!==state.template?.projectId || template.entryId!==options.entryId || !template.configurations.some(profile=>profile.id===persisted.templateId))throw new ProjectConfigurationError('Invalid run configuration snapshot.');
            state={...state,template,fields:template.fields,configurations:state.configurations.map(profile=>profile.id===saved.id?{...profile,templateId:persisted.templateId}:profile)};
          }
          return validateSnapshot(state,saved);
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (snapshotOptions.requireExisting && options.profilePolicy) throw new ProjectConfigurationError('This restricted run has no verified configuration snapshot. Start a new task.', 'CONFIGURATION_FORBIDDEN');
        const state=await load();
        if(snapshotOptions.id && state.profilePolicy && !configurationAccessView(state,options.access).configurations.some(profile=>profile.id===snapshotOptions.id))throw new ProjectConfigurationError('This configuration is not available to this account.','CONFIGURATION_FORBIDDEN');
        const snapshot = validateSnapshot(state,provided ?? configurationSnapshot(configurationAccessView(view(state),options.access), snapshotOptions.id, snapshotOptions.required !== false));
        await atomic(runFile, state.template ? {snapshot,template:state.template,templateId:state.configurations.find(profile=>profile.id===snapshot.id)?.templateId??state.template.defaultConfigurationId} : snapshot);
        return snapshot;
      });
      const state=await exclusive(load);
      if(snapshotOptions.id && state.profilePolicy && !configurationAccessView(state,options.access).configurations.some(profile=>profile.id===snapshotOptions.id))throw new ProjectConfigurationError('This configuration is not available to this account.','CONFIGURATION_FORBIDDEN');
      return validateSnapshot(state,provided ?? configurationSnapshot(configurationAccessView(view(state),options.access),snapshotOptions.id,snapshotOptions.required!==false));
    },
  };
}

function parseSnapshot(value: unknown): ProjectConfigurationSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectConfigurationError("Invalid run configuration snapshot.");
  const snapshot = value as ProjectConfigurationSnapshot;
  if (typeof snapshot.id !== "string" || typeof snapshot.name !== "string" || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !isConfigurationValue(snapshot.values) || !snapshot.values || typeof snapshot.values !== "object" || Array.isArray(snapshot.values)) throw new ProjectConfigurationError("Invalid run configuration snapshot.");
  if (snapshot.agentModelPolicy !== undefined) parseAgentModelPolicy(snapshot.agentModelPolicy);
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
export async function readCachedConfigurationFile(projectDir:string,fileId:string,options:{rootDir?:string;templateCacheDir?:string;entryId?:string}={}):Promise<{file:unknown;base64:string}|undefined> {
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
