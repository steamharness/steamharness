import type { Context } from "@earendil-works/chord";
import { createRegistry, defineDoc, defineExtension, type Agent, type Harness, type RegistryReader, type RegistrySnapshot, type ToolRegistration, type ConversationId, type JsonObject } from "@earendil-works/pi-durable";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { AgentTool, AgentToolSet } from "./types";
import type { AgentSessionOptions, AgentSessionResources } from "./session-types";

export interface AgentToolCatalog {
  /** Stable, non-secret identity of an explicitly authorized directory. */
  id: string;
  tools?: readonly Omit<AgentTool, "execute">[];
  /** Required for discovery without predeclared schemas. Uses the final agent tool ids. */
  allowedTools?: readonly string[];
  open(): Promise<AgentToolSet>;
}

const CatalogDoc = defineDoc({ kind: "workflow.catalog-manifests", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ catalogs: {} as Record<string, JsonObject[]> }) });
const EnvironmentDoc = defineDoc({ kind: "workflow.environment", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ id: "" }) });
type Directory = { catalog: AgentToolCatalog; tools: readonly Omit<AgentTool, "execute">[]; fingerprints?: readonly string[]; state: "idle" | "connecting" | "ready" | "failed"; connection?: Promise<AgentToolSet> };

export interface AgentExecutionEnvironment {
  id: string;
  label: string;
  /** The environment enforces file and command permissions on its own host. */
  open(target: { conversationId: number; cwd?: string }, context: Context): ExecutionEnv | Promise<ExecutionEnv>;
}

export function toolFingerprint(tool: Omit<AgentTool, "execute">): string {
  return canonical({ name: tool.name, description: tool.description, parameters: tool.parameters, replay: tool.replay ?? "never" });
}

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** Merges immutable publications; the Harness itself pins each phase and wakes missing tasks. */
export function mergeAgentRegistries(internal: RegistryReader, application?: RegistryReader): RegistryReader {
  return {
    snapshot: () => {
      const own = internal.snapshot(), extra = application?.snapshot();
      const extensions = own.installed(), tasks = own.tasks(), names = new Set(extensions.map(extension => extension.name));
      const taskNames = new Set(tasks.map(task => task.definition.name)), tools = new Set(own.tools().map(item => item.tool.name));
      if (tools.size !== own.tools().length) throw new Error("Duplicate agent tool in the session registry.");
      for (const extension of extra?.installed() ?? []) {
        if (names.has(extension.name) || /^(pi|workflow)\./.test(extension.name)) throw new Error(`Reserved agent extension: ${extension.name}`);
        names.add(extension.name);
        for (const task of extension.tasks ?? []) {
          if (taskNames.has(task.definition.name) || /^(pi|workflow)\./.test(task.definition.name)) throw new Error(`Reserved or duplicate agent task: ${task.definition.name}`);
          taskNames.add(task.definition.name);
        }
        for (const tool of extension.tools ?? []) {
          if (tools.has(tool.name)) throw new Error(`Duplicate agent tool: ${tool.name}`);
          tools.add(tool.name);
        }
      }
      const merged = createRegistry();
      // Project argument transforms run before the Core approval hook.
      for (const extension of [...(extra?.installed() ?? []), ...extensions]) merged.install(extension);
      return merged.snapshot();
    },
    subscribe: listener => {
      const first = internal.subscribe(listener), second = application?.subscribe(listener);
      return () => { first(); second?.(); };
    },
  };
}

export class AgentExtensionResources {
  private readonly directories: Directory[] = [];
  private readonly environments = new Map<string, Promise<ExecutionEnv>>();
  private environmentState: "idle" | "ready" | "failed" = "idle";
  private sandbox?: { close(): Promise<void> };
  private closing = false;
  private registry?: ReturnType<typeof createRegistry>;
  private adapt?: (tool: AgentTool) => ToolRegistration;
  private harness?: Harness;
  private rootId?: ConversationId;

  constructor(private readonly options: AgentSessionOptions) {}

  async install(registry: ReturnType<typeof createRegistry>, adapt: (tool: AgentTool) => ToolRegistration): Promise<void> {
    this.closing = false;
    this.registry = registry; this.adapt = adapt;
    if (this.options.toolSearch) {
      const search = createToolSearchTool();
      registry.install(defineExtension({ name: "tool-search", tools: [{ ...search, execute: async (args, api, context) => {
        for (const directory of this.directories) if (!directory.tools.length && directory.catalog.allowedTools?.length) {
          const connection = await this.connect(directory);
          await api.commit(async tx => {
            (await tx.doc(CatalogDoc, this.rootId!)).catalogs[directory.catalog.id] = JSON.parse(JSON.stringify(connection.tools.map(({ execute: _execute, ...descriptor }) => descriptor))) as JsonObject[];
          }, context);
          directory.tools = connection.tools;
          this.publish(directory);
        }
        return search.execute(args as { query: string; limit?: number }, { ...api, agent: async ctx => (await this.harness!.conversation(api.conversationId, ctx))!.agent(ctx) as Promise<Agent> }, context);
      } }] }));
      const names = new Set<string>();
      for (const catalog of this.options.toolSearch.catalogs ?? []) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(catalog.id) || this.directories.some(item => item.catalog.id === catalog.id)) throw new Error("Tool catalog ids must be unique and bounded.");
        if ((catalog.tools ?? catalog.allowedTools ?? []).length > 256 || this.directories.length >= 8) throw new Error("Too many deferred tools or catalogs.");
        if (!catalog.tools && !catalog.allowedTools) throw new Error("A catalog must declare tools or an allowedTools list.");
        for (const name of catalog.tools?.map(tool => tool.name) ?? catalog.allowedTools ?? []) {
          if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error("Invalid catalog tool name.");
          if (names.has(name)) throw new Error(`Duplicate catalog tool: ${name}`);
          names.add(name);
        }
        const directory: Directory = { catalog, tools: catalog.tools ?? [], state: "idle" };
        this.publish(directory);
        this.directories.push(directory);
      }
    }
    if (this.options.codeMode) {
      const { createSteamHarnessmode } = await import("./codemode");
      const { extension, sandbox } = createSteamHarnessmode(this.options.codeMode);
      this.sandbox = sandbox;
      registry.install(extension);
    }
  }

  private publish(directory: Directory): void {
    const tools = directory.tools.map(descriptor => {
      const fingerprint = toolFingerprint(descriptor);
      const lazy: AgentTool = { ...descriptor, execute: async (id, args, signal, update) => {
        signal?.throwIfAborted();
        if (this.closing) throw new Error("Tool catalog is closing.");
        const connection = await this.connect(directory);
        signal?.throwIfAborted();
        const tool = connection.tools.find(tool => tool.name === descriptor.name && toolFingerprint(tool) === fingerprint)!;
        return tool.execute(id, args, signal, update);
      } };
      return { ...this.adapt!(lazy), deferred: true as const };
    });
    this.registry!.install(defineExtension({ name: `workflow.catalog.${directory.catalog.id}`, tools }));
  }

  private connect(directory: Directory): Promise<AgentToolSet> {
    if (this.closing) return Promise.reject(new Error("Tool catalog is closing."));
    directory.connection ??= (async () => {
      directory.state = "connecting";
      let connection: AgentToolSet | undefined;
      try {
        connection = await directory.catalog.open();
        const allowed = new Set(directory.catalog.allowedTools ?? directory.tools.map(tool => tool.name));
        const fingerprints = new Set(connection.tools.map(toolFingerprint));
        if (connection.tools.length > 256 || new Set(connection.tools.map(tool => tool.name)).size !== connection.tools.length
          || connection.tools.some(tool => !allowed.has(tool.name))
          || (directory.tools.length && (connection.tools.length !== directory.tools.length
            || directory.tools.some(expected => !fingerprints.has(toolFingerprint(expected)))))
          || (directory.fingerprints && (connection.tools.length !== directory.fingerprints.length
            || directory.fingerprints.some(expected => !fingerprints.has(expected))))) throw new Error(`Tool catalog definition changed: ${directory.catalog.id}`);
        directory.state = "ready";
        return connection;
      } catch (error) {
        directory.state = "failed";
        await connection?.close?.();
        throw error;
      }
    })().catch(error => { directory.connection = undefined; throw error; });
    return directory.connection;
  }

  async restore(harness: Harness, rootId: ConversationId, context: Context): Promise<void> {
    this.harness = harness; this.rootId = rootId;
    const identity = this.options.environment?.id ?? "local";
    await harness.commit(async tx => {
      const doc = await tx.doc(EnvironmentDoc, rootId);
      if (doc.id && doc.id !== identity) throw new Error("Execution environment identity changed. Open a new session for a different target.");
      doc.id = identity;
      const manifests = await tx.doc(CatalogDoc, rootId);
      for (const { catalog } of this.directories) if (catalog.tools && !Object.hasOwn(manifests.catalogs, catalog.id)) {
        manifests.catalogs[catalog.id] = JSON.parse(JSON.stringify(catalog.tools)) as JsonObject[];
      }
    }, context);
    const previous = await harness.snapshot(CatalogDoc, rootId, context);
    for (const directory of this.directories) {
      const allowed = new Set(directory.catalog.allowedTools ?? directory.tools.map(tool => tool.name));
      const saved = previous && Object.hasOwn(previous.catalogs, directory.catalog.id) ? previous.catalogs[directory.catalog.id] : undefined;
      const manifest = saved?.filter(descriptor => allowed.has(String(descriptor.name))) as unknown as Directory["tools"] | undefined;
      directory.fingerprints = manifest?.map(toolFingerprint);
      if (directory.catalog.tools) continue;
      directory.tools = manifest ?? [];
      this.publish(directory);
    }
  }

  async environment(target: { conversationId: number; cwd?: string }, context: Context): Promise<ExecutionEnv | undefined> {
    const definition = this.options.environment;
    if (!definition) return undefined;
    if (this.closing) throw new Error("Execution environment is closing.");
    if (!definition.id || !definition.label) throw new Error("An execution environment needs an id and label.");
    const key = canonical(target);
    let pending = this.environments.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => definition.open(target, context)).then(async environment => {
        if (environment.id !== definition.id || (target.cwd !== undefined && environment.cwd !== target.cwd)) {
          await environment.cleanup(context);
          throw new Error("Execution environment identity or working directory changed.");
        }
        this.environmentState = "ready";
        return environment;
      }).catch(error => { this.environmentState = "failed"; this.environments.delete(key); throw error; });
      this.environments.set(key, pending);
    }
    return pending;
  }

  snapshot(registry: RegistrySnapshot, loaded: readonly string[], storage: string): AgentSessionResources {
    return {
      extensions: registry.installed().map(extension => ({ name: extension.name, tools: (extension.tools ?? []).map(tool => tool.name),
        tasks: (extension.tasks ?? []).map(task => ({ name: task.definition.name, version: task.definition.version })) })),
      catalogs: this.directories.map(({ catalog, tools, state }) => ({ id: catalog.id, state, tools: tools.map(tool => tool.name), loaded: tools.filter(tool => loaded.includes(tool.name)).map(tool => tool.name) })),
      codeMode: !!this.options.codeMode,
      environment: this.options.environment ? { id: this.options.environment.id, label: this.options.environment.label, state: this.environmentState, remote: true }
        : { id: "local", label: "Local", state: "ready", remote: false },
      storage,
    };
  }

  async close(context: Context): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled([
      ...this.directories.map(async directory => { const connection = await directory.connection?.catch(() => undefined); await connection?.close?.(); }),
      ...[...this.environments.values()].map(async pending => { const environment = await pending.catch(() => undefined); await environment?.cleanup(context); }),
      this.sandbox?.close(),
    ]);
    this.directories.length = 0; this.environments.clear(); this.sandbox = undefined;
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Agent extension resource cleanup failed.");
  }
}
