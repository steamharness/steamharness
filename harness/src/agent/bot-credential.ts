import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { NodeContext } from "../types/context";
import { isBotCredentialStatus, parseBotCredentialSlot } from "../types/bot-credential";
import { currentBotRequestId } from "./bot-lifecycle";

export const BOT_CREDENTIAL_TOOL = { name: "bot_credentials_request", label: "Request a Bot credential", enabled: true, autoApprove: true } as const;
export const BOT_CREDENTIAL_GUIDANCE = "To ask for a credential, use bot_credentials_request with a descriptive alias and kind. Never ask the user to put a secret in chat, input fields, or memory. The Studio prompt saves it privately and returns only a status, not a usable token or key. Do not claim that a connection was made or a secret was used.";

export function createBotCredentialTool(context: NodeContext): AgentTool | undefined {
  if (!context.userInput?.waitForCredential || context.toolPermissions?.getTool(BOT_CREDENTIAL_TOOL.name)?.enabled === false) return;
  return {
    name: BOT_CREDENTIAL_TOOL.name, label: BOT_CREDENTIAL_TOOL.label,
    description: "Ask the local Studio user to save or confirm a credential in this Bot's private store. Use an alias, never the credential itself. Returns only saved, existing, or declined.",
    parameters: { type: "object", additionalProperties: false, required: ["name", "kind"], properties: {
      name: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$", description: "A descriptive alias, not a credential value." },
      kind: { type: "string", enum: ["api-key", "password", "ssh-private-key"] },
    } },
    replay: "never",
    async execute(_id: string, input: unknown, signal?: AbortSignal) {
      const credential = parseBotCredentialSlot(input);
      const status = await context.userInput!.waitForCredential!({ requestId: `credential:${randomUUID()}`, nodeName: "bot-credential",
        title: "Bot credential", params: [], credential, createdAt: new Date(), metadata: { type: "bot-credential", title: "Bot credential", version: "1.0.0", botRequestId: currentBotRequestId() } }, signal ?? context.abortSignal);
      if (!isBotCredentialStatus(status)) throw new Error("Invalid Bot credential receipt.");
      return { content: [{ type: "text", text: JSON.stringify({ ...credential, status }) }], details: {} };
    },
  } as unknown as AgentTool;
}
