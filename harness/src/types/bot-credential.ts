export const BOT_CREDENTIAL_INPUT_VERSION = 1;

export type BotCredentialKind = "api-key" | "password" | "ssh-private-key";
export interface BotCredentialSlot {
  name: string;
  kind: BotCredentialKind;
}

export type BotCredentialStatus = "saved" | "existing" | "declined";

export function parseBotCredentialSlot(value: unknown): BotCredentialSlot {
  const slot = value as Partial<BotCredentialSlot> | undefined;
  if (!slot || typeof slot !== "object" || Array.isArray(slot) || Object.keys(slot).some(key => key !== "name" && key !== "kind")
    || typeof slot.name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slot.name)
    || (slot.kind !== "api-key" && slot.kind !== "password" && slot.kind !== "ssh-private-key")) {
    throw new Error("Invalid Bot credential name or kind.");
  }
  return { name: slot.name, kind: slot.kind };
}

export function isBotCredentialStatus(value: unknown): value is BotCredentialStatus {
  return value === "saved" || value === "existing" || value === "declined";
}
