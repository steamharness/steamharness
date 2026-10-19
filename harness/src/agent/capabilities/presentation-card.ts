import type { NodeContext } from "../../types/context";
import { readHostConfigurationBridgeConfig, runHostConfigurationAction } from "./host-configuration";
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
    mode: "preview" | "save";
    values: Record<string, unknown>;
  };
}

const CARD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CARD_KINDS = new Set<PresentationCardKind>([
  "kv", "knowledge", "project", "browser", "file", "kanban",
]);

export async function runPresentationCardAction(
  _context: NodeContext,
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
  const target = readTarget(args.kind!, args.target);
  if (args.pinned !== undefined && typeof args.pinned !== "boolean") {
    throw new Error("Card pinned must be a boolean.");
  }
  if (args.preview !== undefined && typeof args.preview !== "boolean") {
    throw new Error("Card preview must be a boolean.");
  }
  if (args.preview !== undefined && args.kind !== "kanban" && args.kind !== "project" && args.kind !== "browser") {
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
    if (mode !== "preview" && mode !== "save") throw new Error("Kanban card mode is invalid.");
    if (!isRecord(args.kanban.values) || Object.keys(args.kanban.values).length > 100) {
      throw new Error("Kanban card values must be a small object.");
    }
    const values = Object.fromEntries(Object.entries(args.kanban.values).map(([key, value]) => {
      if (key.length < 1 || key.length > 200 || !isKanbanValue(value)) {
        throw new Error("Kanban card parameter is invalid.");
      }
      return [key, value];
    }));
    if (mode === "save") {
      if (target.source !== "current") {
        throw new Error("Saving Kanban parameters requires the current host Kanban project.");
      }
    }
    kanban = { mode, values };
  }
  if (args.kind === "kanban" && target.source === "current" && !target.configurationId
    && readHostConfigurationBridgeConfig()) {
    const state = await runHostConfigurationAction({ action: "get" });
    if (isRecord(state) && typeof state.activeConfigurationId === "string") {
      target.configurationId = state.activeConfigurationId;
    }
  }
  if (kanban?.mode === "save") {
    await runHostConfigurationAction({ action: "update", values: kanban.values,
      ...(target.configurationId ? { configurationId: target.configurationId } : {}),
    });
  }
  return {
    action: "upsert",
    cardId: args.cardId,
    kind: args.kind,
    target,
    ...(args.title === undefined ? {} : { title: args.title.trim() }),
    ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
    ...(args.preview === undefined ? {} : { preview: args.preview }),
    ...(kanban === undefined ? {} : { kanban }),
  };
}

function readTarget(kind: PresentationCardKind, value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("Card target must be an object.");
  const allowed: Record<PresentationCardKind, readonly string[]> = {
    kv: ["source", "projectId", "scope", "conversationId", "key"],
    knowledge: ["source", "projectId", "documentId"],
    project: ["source", "projectId", "configurationId"],
    browser: ["url"],
    file: ["source", "projectId", "filePath"],
    kanban: ["source", "projectId", "configurationId"],
  };
  const target: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed[kind].includes(key) || typeof entry !== "string" || entry.trim() === "" || entry.length > 2_048) {
      throw new Error("Card target contains an invalid field.");
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
    if (target.source !== "current" && !target.projectId) throw new Error("Card target requires a project id.");
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

function isKanbanValue(value: unknown): boolean {
  return typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const PRESENTATION_CARD_CAPABILITY: Capability = {
  serverId: PRESENTATION_CARD_MCP_SERVER_ID,
  toolName: PRESENTATION_CARD_MCP_TOOL_NAME,
  toolId: PRESENTATION_CARD_MCP_TOOL_ID,
  title: "Conversation resource card",
  description: "Show, update, pin, or remove a resource card in the current Conversation. preview controls the Kanban or Desktop browser preview; Kanban projects and browser cards preview and pin by default. Set target.configurationId to preview a specific named Kanban configuration without selecting or modifying the host configuration. Omitted IDs on current-host Kanban cards bind to the configuration active when this command runs. Kanban parameter mode=preview is temporary; mode=save writes the referenced host configuration.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["upsert", "remove"] },
      cardId: { type: "string", minLength: 1, maxLength: 128 },
      kind: { type: "string", enum: [...CARD_KINDS] },
      target: { type: "object", additionalProperties: { type: "string" },
        description: "Resource target. Kanban/project previews accept configurationId, the ID returned by host_project_configuration get. Previewing it does not change the host selection.",
      },
      pinned: { type: "boolean" },
      preview: { type: "boolean" },
      title: { type: "string", minLength: 1, maxLength: 200 },
      kanban: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["preview", "save"] },
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
