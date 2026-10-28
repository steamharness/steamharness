import type { NodeContext } from "../../types/context";
import { isConfigurationValue } from "@steamharness/project-configuration";
import type { Capability } from "./types";

export const PRESENTATION_CARD_MCP_SERVER_ID = "workflow-ui";
export const PRESENTATION_CARD_MCP_TOOL_NAME = "present_card";
export const PRESENTATION_CARD_MCP_TOOL_ID =
  `${PRESENTATION_CARD_MCP_SERVER_ID}_${PRESENTATION_CARD_MCP_TOOL_NAME}`;

export type PresentationCardKind = "kv" | "knowledge" | "project" | "browser" | "file" | "kanban";

export interface PresentationCardToolArgs {
  action: "upsert" | "remove";
  cardId: string;
  kind?: PresentationCardKind;
  target?: Record<string, unknown>;
  pinned?: boolean;
  preview?: boolean;
  title?: string;
  kanban?: {
    mode: "preview";
    values: Record<string, unknown>;
  };
}

const CARD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CARD_KINDS = new Set<PresentationCardKind>([
  "kv", "knowledge", "project", "browser", "file", "kanban",
]);
const CARD_TARGET_FIELDS: Record<PresentationCardKind, readonly string[]> = {
  kv: ["source", "projectId", "entryId", "database", "spaceId", "scope", "conversationId", "key"],
  knowledge: ["source", "projectId", "entryId", "database", "spaceId", "documentId"],
  project: ["source", "projectId", "entryId", "configurationId"],
  browser: ["url"],
  file: ["source", "projectId", "entryId", "filePath"],
  kanban: ["source", "projectId", "entryId", "configurationId"],
};

export async function runPresentationCardAction(
  context: NodeContext,
  args: PresentationCardToolArgs,
): Promise<unknown> {
  if (args.action !== "upsert" && args.action !== "remove") {
    throw new Error("Card action must be upsert or remove.");
  }
  if (typeof args.cardId !== "string" || !CARD_ID_PATTERN.test(args.cardId)) {
    throw new Error("Card id must be 1-128 letters, digits, dots, colons, underscores, or hyphens.");
  }
  if (args.action === "remove") {
    if (args.kind !== undefined || args.target !== undefined || args.kanban !== undefined || args.preview !== undefined
      || args.pinned !== undefined || args.title !== undefined) {
      throw new Error("Removing a card accepts only its card id.");
    }
    return { action: "remove", cardId: args.cardId };
  }
  if (!CARD_KINDS.has(args.kind as PresentationCardKind)) {
    throw new Error("Card kind is invalid.");
  }
  const target = readTarget(args.kind!,args.target);
  if(target.source === "current") { target.projectId ??= context.projectId; target.entryId ??= context.entryId; }
  if (args.pinned !== undefined && typeof args.pinned !== "boolean") {
    throw new Error("Card pinned must be a boolean.");
  }
  if (args.preview !== undefined && typeof args.preview !== "boolean") {
    throw new Error("Card preview must be a boolean.");
  }
  const supportsPreview = args.kind === "kanban" || args.kind === "project" || args.kind === "browser";
  if (args.preview === true && !supportsPreview) {
    throw new Error("Card preview requires a Kanban, project, or browser card.");
  }
  if (args.title !== undefined && (typeof args.title !== "string" || args.title.trim() === "" || args.title.length > 200)) {
    throw new Error("Card title must be 1-200 characters.");
  }
  let kanban: PresentationCardToolArgs["kanban"];
  if (args.kanban !== undefined) {
    if (args.kind !== "kanban" || !isRecord(args.kanban)) {
      throw new Error("Kanban parameters require a Kanban card.");
    }
    const mode = args.kanban.mode;
    if (mode !== "preview") throw new Error("Use Studio Control manage_configurations to save project configurations with an explicit target and revision.");
    if (!isRecord(args.kanban.values) || Object.keys(args.kanban.values).length > 100) {
      throw new Error("Kanban card values must be a small object.");
    }
    const values = Object.fromEntries(Object.entries(args.kanban.values).map(([key, value]) => {
      if (key.length < 1 || key.length > 200 || !isKanbanValue(value)) {
        throw new Error("Kanban card parameter is invalid.");
      }
      return [key, value];
    }));
    kanban = { mode, values };
  }
  return {
    action: "upsert",
    cardId: args.cardId,
    kind: args.kind,
    target,
    ...(args.title === undefined ? {} : { title: args.title.trim() }),
    ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
    ...(args.preview === undefined || !supportsPreview ? {} : { preview: args.preview }),
    ...(kanban === undefined ? {} : { kanban }),
  };
}

function readTarget(kind: PresentationCardKind, value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("Card target must be an object.");
  const target: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!CARD_TARGET_FIELDS[kind].includes(key)) {
      throw new Error(`Card target contains an invalid field "${key}" for ${kind}. Allowed fields: ${CARD_TARGET_FIELDS[kind].join(", ")}.${kind === "file" ? ' Use filePath for the workspace-relative file path, for example {"source":"current","filePath":"README.md"}.' : ""}`);
    }
    if (typeof entry !== "string" || entry.trim() === "" || entry.length > 2_048) {
      throw new Error(`Card target field "${key}" must be a non-empty string of at most 2048 characters.`);
    }
    target[key] = entry.trim();
  }
  if (kind === "browser") {
    const url = new URL(target.url ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Card browser URL must use HTTP(S).");
    target.url = url.toString();
  } else {
    if (target.source !== "local" && target.source !== "server" && target.source !== "current") {
      throw new Error("Card target source is invalid.");
    }
    if (target.source !== "current" && (!target.projectId || !target.entryId)) throw new Error("Card target requires projectId and entryId.");
    if ((kind === "kv" || kind === "knowledge") && !target.database) throw new Error("Database cards require a declared database alias.");
    if (kind === "kv" && (!target.key || !["project", "conversation"].includes(target.scope ?? ""))) {
      throw new Error("KV card requires a key and scope.");
    }
    if (kind === "file" && (!target.filePath || target.filePath.startsWith("/")
      || /^[A-Za-z]:[\\/]/.test(target.filePath) || target.filePath.includes("\0")
      || target.filePath.replaceAll("\\", "/").split("/").some((segment) => segment === ".." || segment === ""))) {
      throw new Error("File card requires a workspace-relative path.");
    }
  }
  return target;
}

function isKanbanValue(value: unknown): boolean { return isConfigurationValue(value); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const PRESENTATION_CARD_CAPABILITY: Capability = {
  serverId: PRESENTATION_CARD_MCP_SERVER_ID,
  toolName: PRESENTATION_CARD_MCP_TOOL_NAME,
  toolId: PRESENTATION_CARD_MCP_TOOL_ID,
  title: "Conversation resource card",
  description: 'Show, update, pin, or remove a resource card in the current Conversation. For a file use {"action":"upsert","cardId":"readme","kind":"file","target":{"source":"current","filePath":"README.md"}}. Omit preview on file, KV and knowledge cards. preview controls the Kanban or Desktop browser preview; Kanban projects and browser cards preview and pin by default. Set target.configurationId to preview a specific named Kanban configuration without selecting or modifying the host configuration. Omitted IDs use the active configuration when the preview opens. Kanban parameter mode=preview is temporary. Persist values with Studio Control manage_configurations using an explicit target, configuration ID and revision.',
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["upsert", "remove"] },
      cardId: { type: "string", minLength: 1, maxLength: 128 },
      kind: { type: "string", enum: [...CARD_KINDS] },
      target: { type: "object", additionalProperties: false,
        properties: Object.fromEntries([...new Set(Object.values(CARD_TARGET_FIELDS).flat())].map(field => [field, {
          type: "string", minLength: 1, maxLength: 2_048,
          ...(field === "source" ? { enum: ["local", "server", "current"] } : {}),
          description: field === "filePath" ? "File cards: workspace-relative path, e.g. README.md. Required for kind=file."
            : field === "url" ? "Browser cards: HTTP(S) URL. Required for kind=browser."
            : `Used by ${Object.entries(CARD_TARGET_FIELDS).filter(([, fields]) => fields.includes(field)).map(([kind]) => kind).join(", ")} cards.`,
        }])),
        description: "Use only fields for the selected kind. File: source, projectId, entryId, filePath. Browser: url. KV: source, projectId, entryId, database, spaceId, scope, conversationId, key. Knowledge: source, projectId, entryId, database, spaceId, documentId. Kanban/project: source, projectId, entryId, configurationId. source=current resolves missing projectId and entryId from the host.",
      },
      pinned: { type: "boolean" },
      preview: { type: "boolean", description: "Only Kanban, project or browser cards. Omit for file, KV and knowledge cards; false is ignored for those kinds." },
      title: { type: "string", minLength: 1, maxLength: 200 },
      kanban: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["preview"] },
          values: { type: "object" },
        },
        required: ["mode", "values"],
      },
    },
    required: ["action", "cardId"],
  },
  async run(context, args) {
    return runPresentationCardAction(context, args as unknown as PresentationCardToolArgs);
  },
};
