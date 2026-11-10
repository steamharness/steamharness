/** Project-owned references; the host only renders and inserts their text. */
export interface KanbanConversationMentionGroup {
  kind: string;
  label: string;
  items: { value: string; label: string; description?: string; suggest?: boolean }[];
}

/** Plain project data attached to one assistant turn, outside model history. */
export interface KanbanConversationMessageCard {
  id: string;
  requestId: string;
  title: string;
  text: string;
  icon?: "bot" | "message" | "send";
  iconColor?: string;
  status?: { label: string; tone?: "neutral" | "info" | "success" | "warning" | "danger" };
  /** An opaque card event handled by the owning project, without URLs or scripts. */
  action?: { label: string };
}

export interface KanbanConversationUi {
  mentions?: KanbanConversationMentionGroup[];
  placeholder?: string;
  /** Use project-owned transcript slots with the native composer. */
  presentation?: "conversation" | "composer";
  messageCards?: KanbanConversationMessageCard[];
}

export type KanbanConversationSubmission = {
  requestId: string;
  text: string;
  createdAt: number;
} & ({ phase: "sending" } | { phase: "accepted"; receiptId: string; result?: unknown } | { phase: "failed"; error: string });

export interface KanbanConversationMountOptions {
  /** DOM remains in the owning Kanban document, outside the native sandbox. */
  slots?: { header?: HTMLElement; transcript?: HTMLElement; footer?: HTMLElement };
  /** Local sending is provisional; accepted carries the authorized Workflow result. */
  onSubmission?(event: KanbanConversationSubmission): void;
  onSubmitted?(event: { requestId: string; receiptId: string }): void;
  onMessageCardAction?(event: { id: string; requestId: string }): void;
}

export interface KanbanConversationMount {
  (): void;
  /** Update project UI without replacing the composer or its draft. */
  update(ui: KanbanConversationUi): Promise<void>;
  /** Explicitly retry an unsuccessful native submission with its original identity. */
  retry(requestId: string): void;
}

export function assertConversationUi(value: unknown): asserts value is KanbanConversationUi {
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const string = (item: unknown, max: number) => typeof item === "string" && item.trim().length > 0 && item.length <= max;
  if (!record(value) || Object.keys(value).some(key => !["mentions", "placeholder", "presentation", "messageCards"].includes(key)) ||
    value.placeholder !== undefined && !string(value.placeholder, 500) ||
    value.presentation !== undefined && value.presentation !== "conversation" && value.presentation !== "composer") throw new Error("Invalid conversation UI.");
  if (value.messageCards !== undefined) {
    if (!Array.isArray(value.messageCards) || value.messageCards.length > 100) throw new Error("Invalid message cards.");
    const cardIds = new Set();
    for (const card of value.messageCards) {
      if (!record(card) || Object.keys(card).some(key => !["id", "requestId", "title", "text", "icon", "iconColor", "status", "action"].includes(key)) ||
        !string(card.id, 200) || cardIds.has(card.id) || !string(card.requestId, 200) || !string(card.title, 200) || !string(card.text, 4000) ||
        card.icon !== undefined && !["bot", "message", "send"].includes(String(card.icon)) ||
        card.iconColor !== undefined && (typeof card.iconColor !== "string" || !/^#[\da-f]{6}$/i.test(card.iconColor)) ||
        card.action !== undefined && (!record(card.action) || Object.keys(card.action).some(key => key !== "label") || !string(card.action.label, 200)) ||
        card.status !== undefined && (!record(card.status) || Object.keys(card.status).some(key => !["label", "tone"].includes(key)) ||
          !string(card.status.label, 60) || card.status.tone !== undefined && !["neutral", "info", "success", "warning", "danger"].includes(String(card.status.tone))))
        throw new Error("Invalid message card.");
      cardIds.add(card.id);
    }
  }
  if (value.mentions === undefined) return;
  if (!Array.isArray(value.mentions) || value.mentions.length > 16) throw new Error("Invalid mention groups.");
  const kinds = new Set(["skill", "file", "entry"]);
  for (const group of value.mentions) {
    if (!record(group) || Object.keys(group).some(key => !["kind", "label", "items"].includes(key)) ||
      typeof group.kind !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(group.kind) || kinds.has(group.kind) ||
      !string(group.label, 100) || !Array.isArray(group.items) || group.items.length > 200) throw new Error("Invalid mention group.");
    kinds.add(group.kind);
    const values = new Set();
    for (const item of group.items) {
      if (!record(item) || Object.keys(item).some(key => !["value", "label", "description", "suggest"].includes(key)) ||
        !string(item.value, 500) || /[\r\n]/.test(String(item.value)) || values.has(item.value) || !string(item.label, 200) ||
        item.description !== undefined && !string(item.description, 1000) ||
        item.suggest !== undefined && typeof item.suggest !== "boolean") throw new Error("Invalid mention item.");
      values.add(item.value);
    }
  }
}
