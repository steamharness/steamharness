import { HarnessError } from "../workflow/errors";
import { normalizeProjectParamDeclarations } from "../executor/param-definition";
import { parseProjectParamValues } from "../executor/params";
import type { ConversationParamDeclaration, ParamFieldDeclaration, ParamValues } from "../executor/types";
import type { AgentConversationProject, AgentInput, AgentProjectOptions, AgentProjectParamOverride } from "./types";

export interface AgentProjectParamContract {
  params: ConversationParamDeclaration[];
  modelSource?: "user-settings" | "project";
  skillDirectories: readonly string[];
  memory?: AgentProjectOptions["memory"];
}
const contracts = new WeakMap<object, AgentProjectParamContract>();
export function registerAgentProject(project: object, options: AgentProjectOptions): AgentConversationProject {
  contracts.set(project, { params: structuredClone(options.params ?? createAgentProjectParams(options)), modelSource: options.modelSource,
    skillDirectories: [...(options.skills?.directories ?? [])], memory: options.memory });
  return project as AgentConversationProject;
}
export function readAgentProjectContract(project: unknown): AgentProjectParamContract | undefined {
  return typeof project === "object" && project !== null ? contracts.get(project) : undefined;
}

/** The assistant parameter contract, shared by runtime and static inspection. */
export function createAgentProjectParams(options: AgentProjectOptions = {}): ConversationParamDeclaration[] {
  const defaults: ConversationParamDeclaration[] = [
    {
      kind: "quick",
      id: "model",
      label: "Model",
      icon: "sparkle",
      summary: ["model"],
      fields: [
        {
          name: "provider",
          flag: "--provider",
          type: "string",
          required: true,
          label: "Provider",
          description: "SteamHarness Server system AI configuration.",
          control: "select",
          options: [],
        },
        {
          name: "model",
          flag: "--model",
          type: "string",
          required: true,
          label: "Model",
          description: options.modelSource === "project" ? "选择项目配置中的模型。" : "Choose a model from user settings or project configurations.",
          ...(options.model !== undefined ? { defaultValue: options.model } : options.modelSource === "project" ? {} : { userSetting: { key: "agent.model" as const, mode: "default" as const } }),
          control: "select",
          options: [],
        },
      ],
    },
    {
      kind: "quick",
      id: "effort",
      label: "Effort",
      icon: "lightbulb",
      summary: ["effort"],
      fields: [
        {
          name: "effort",
          flag: "--effort",
          type: "string",
          required: false,
          label: "Effort",
          description: "思考强度。超出模型支持范围时会自动收敛到该模型支持的档位。",
          defaultValue: options.effort ?? "high",
          control: "select",
          options: [
            { value: "", label: "模型默认", description: "交给模型决定。" },
            { value: "off", label: "Off", description: "不做推理。" },
            { value: "minimal", label: "Minimal" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra high" },
            { value: "max", label: "Max", description: "仅部分模型支持。" },
          ],
        },
      ],
    },
    {
      kind: "slash",
      name: "plan",
      flag: "--plan",
      type: "boolean",
      required: false,
      label: "Plan",
      description: "开启或关闭 Plan 模式。",
      defaultValue: options.mode === "plan" ? "true" : "false",
    },
    {
      kind: "quick",
      id: "permission",
      label: "Permission",
      icon: "shield",
      summary: ["permissionPolicy"],
      fields: [
        {
          name: "permissionPolicy",
          flag: "--permission-policy",
          type: "string",
          required: false,
          label: "Permission",
          description: "工具权限策略：read-only 隐藏写入与命令工具，workspace 限定在工作区内，auto 批准一切未被显式拒绝的权限。",
          ...(options.permissionPolicy === undefined || options.permissionPolicy === "inherit"
            ? { userSetting: { key: "agent.permissionPolicy" as const, mode: "fixed" as const } }
            : { defaultValue: options.permissionPolicy }),
          control: "select",
          options: [
            { value: "read-only", label: "Read only", description: "隐藏写入与命令工具。" },
            { value: "workspace", label: "Workspace", description: "工作区内自动批准编辑和命令；读写与检索工具只能访问工作区与挂载目录，shell 命令不受此限制。" },
            { value: "auto", label: "Auto approve", description: "批准一切未被显式拒绝的权限，包括工作区之外的路径。" },
          ],
        },
      ],
    },
  ];
  const fields = options.paramOptions?.fields ?? {};
  for (const name of Object.keys(fields)) {
    if (!["provider", "model", "effort", "plan", "permissionPolicy"].includes(name)) fail(`Unknown Core Agent parameter "${name}".`);
    const patch = fields[name as keyof typeof fields];
    if (patch !== undefined && patch !== false && (patch === null || typeof patch !== "object" || Array.isArray(patch))) fail(`Core Agent parameter "${name}" options must be an object or false.`);
  }
  const declarations: ConversationParamDeclaration[] = [];
  for (const declaration of defaults) {
    if (declaration.kind === "quick" || declaration.kind === "auxiliary") {
      const updated = declaration.fields.flatMap(field => {
        const patch = fields[field.name as keyof typeof fields];
        if (patch === false) return [];
        const next = { ...field, ...definedOverrides(patch) };
        if (patch?.userSetting === null || patch?.defaultValue !== undefined || patch?.fixedValue !== undefined) delete next.userSetting;
        if (next.userSetting) delete next.defaultValue;
        if (patch?.fixedValue !== undefined) delete next.defaultValue;
        return [next];
      });
      if (updated.length) declarations.push({ ...declaration, fields: updated,
        ...(declaration.kind === "quick" ? { summary: remainingSummary(declaration.summary, updated) } : {}),
      } as ConversationParamDeclaration);
    } else {
      const patch = fields[declaration.name as keyof typeof fields];
      if (patch !== false) {
        const next = { ...declaration, ...definedOverrides(patch) };
        if (patch?.userSetting === null || patch?.defaultValue !== undefined || patch?.fixedValue !== undefined) delete next.userSetting;
        if (next.userSetting || patch?.fixedValue !== undefined) delete next.defaultValue;
        declarations.push(next as ConversationParamDeclaration);
      }
    }
  }
  const groups = options.paramOptions?.groups;
  if (groups !== undefined) {
    const available = new Map<string, ParamFieldDeclaration>();
    for (const declaration of declarations) {
      if (declaration.kind === "quick" || declaration.kind === "auxiliary") {
        for (const field of declaration.fields) available.set(field.name, field);
      } else if (declaration.kind === "mode") {
        const { kind: _kind, ...field } = declaration;
        available.set(field.name, { ...field, type: "string", control: "select" });
      } else {
        const { kind: _kind, ...field } = declaration;
        available.set(field.name, field);
      }
    }
    const assigned = new Set<string>();
    const custom = groups.map(group => ({ ...group, fields: group.fields.map(name => {
      const field = available.get(name);
      if (!field || assigned.has(name)) fail(`Core Agent group field "${name}" must be enabled and assigned once.`);
      assigned.add(name);
      return field;
    }) } as ConversationParamDeclaration));
    const remaining = declarations.flatMap(d => {
      if (d.kind !== "quick" && d.kind !== "auxiliary") return assigned.has(d.name) ? [] : [d];
      const kept = d.fields.filter(f => !assigned.has(f.name));
      if (!kept.length) return [];
      return [{ ...d, fields: kept, ...(d.kind === "quick" ? { summary: remainingSummary(d.summary, kept) } : {}) } as ConversationParamDeclaration];
    });
    declarations.splice(0, declarations.length, ...custom, ...remaining);
  }
  normalizeProjectParamDeclarations(declarations);
  return declarations;
}

/** Resolve only declared fields, preserving resolved overrides and legacy Agent flags. */
export function resolveAgentProjectParamValues(
  params: ConversationParamDeclaration[],
  args: string[] = [],
  supplied?: ParamValues,
): ParamValues {
  const fields = normalizeProjectParamDeclarations(params).params;
  const flags = new Map(fields.flatMap(field => [field.flag, field.shortFlag]
    .filter((flag): flag is string => flag !== undefined).map(flag => [flag, field] as const)));
  const model = fields.find(field => field.name === "model" && field.flag === "--model");
  const plan = fields.find(field => field.name === "plan" && field.flag === "--plan" && field.type === "boolean");
  const canonical: string[] = [];
  let legacyMode: string | undefined;
  let explicitPlan = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const field = flags.get(arg) ?? (arg === "-m" && model ? model : undefined);
    if (field) {
      canonical.push(flags.has(arg) ? arg : field.flag!);
      if (field === plan) explicitPlan = true;
      const next = args[index + 1];
      if (next !== undefined && (field.type !== "boolean" || next === "true" || next === "false")) canonical.push(args[++index]!);
    } else if (arg === "--agent" && plan) {
      const mode = args[++index];
      if (mode === "plan" || mode === "build") legacyMode = mode;
    } else if (arg.startsWith("-")) {
      // Standard composer payloads and undeclared options are not Agent flags.
      if (!arg.includes("=")) index++;
    } else {
      canonical.push(arg);
    }
  }
  if (legacyMode !== undefined && !explicitPlan) canonical.push("--plan", legacyMode === "plan" ? "true" : "false");
  const values = parseProjectParamValues(params, canonical);
  for (const field of fields) {
    if (field.fixedValue !== undefined || field.userSetting?.mode === "fixed") continue;
    const value = supplied?.[field.name];
    if (value !== undefined) values[field.name] = value;
  }
  return values;
}

export function applyAgentParamValues(input: AgentInput, values: ParamValues): AgentInput {
  const result = { ...input };
  for (const name of ["provider", "model", "effort", "permissionPolicy"] as const) {
    const value = values[name];
    if (typeof value === "string") {
      if (value !== "") (result as Record<string, unknown>)[name] = value;
      else if (name === "effort") result.effort = "off";
    }
  }
  if (typeof values.plan === "string") result.agent = values.plan === "true" ? "plan" : "build";
  return result;
}

export function applyAgentProjectDefaults(input: AgentInput, params: ConversationParamDeclaration[]): AgentInput {
  const defaults = applyAgentParamValues({ errCode: 0, errMessage: "", prompt: "" }, parseProjectParamValues(params, []));
  const result = { ...defaults, ...input };
  for (const name of ["provider", "model", "effort", "agent", "permissionPolicy"] as const) {
    if (input[name] === undefined && defaults[name] !== undefined) Object.assign(result, { [name]: defaults[name] });
  }
  return applyAgentProjectFixedValues(result, params);
}

export function applyAgentProjectFixedValues(input: AgentInput, params: ConversationParamDeclaration[]): AgentInput {
  const fixed = Object.fromEntries(normalizeProjectParamDeclarations(params).params.filter(p => p.fixedValue !== undefined).map(p => [p.name, p.fixedValue!]));
  return applyAgentParamValues(input, fixed);
}
function fail(message: string): never { throw new HarnessError({ type: "input_validation", message }); }

function remainingSummary(summary: string[], fields: { name: string }[]): string[] {
  const kept = summary.filter(name => fields.some(field => field.name === name));
  return kept.length ? kept : fields.map(field => field.name);
}

function definedOverrides(patch: AgentProjectParamOverride | undefined): AgentProjectParamOverride {
  return Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined));
}
