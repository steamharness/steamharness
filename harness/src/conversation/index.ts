import { randomUUID } from "node:crypto";
import { HarnessError } from "../workflow/errors";

export type ConversationRole = "user" | "assistant" | "system" | "tool";

export interface ConversationMessageContract {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationState {
  conversationId: string;
  projectName: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessageContract[];
  values: Record<string, unknown>;
}

export interface AppendProjectConversationMessageInput {
  /** A stable projection identity replaces the same message when replayed. */
  id?: string;
  role: ConversationRole;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationContext {
  enabled: boolean;
  conversationId?: string;
  getValue(): Promise<ConversationState>;
  setValue(key: string, value: unknown): Promise<ConversationState>;
  setTitle(title: string): Promise<ConversationState | undefined>;
  appendMessage(
    message: AppendProjectConversationMessageInput,
  ): Promise<ConversationState>;
}

export interface ConversationStateStorage {
  read(initial: ConversationState): Promise<ConversationState>;
  update(initial: ConversationState, change: (state: ConversationState) => ConversationState): Promise<ConversationState>;
}

export interface ConversationRuntimeOptions {
  enabled?: boolean;
  conversationId?: string;
  projectName: string;
  storage?: ConversationStateStorage;
  onTitleChange?: (event: {
    conversationId: string;
    title?: string;
    updatedAt: string;
  }) => Promise<void> | void;
}

export function createProjectConversationContext(
  options: ConversationRuntimeOptions,
): ConversationContext {
  if (options.enabled !== true) {
    return createDisabledProjectConversationContext();
  }

  if (options.storage === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message:
        "Workflow conversation is enabled, but no runtime persistence was configured.",
      metadata: { project: options.projectName },
    });
  }

  const conversationId = normalizeConversationId(options.conversationId);
  if (conversationId === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message:
        "Workflow conversation is enabled, but no conversation id was configured.",
      metadata: { project: options.projectName },
    });
  }
  const store = createProjectConversationStore({
    projectName: options.projectName,
    conversationId,
    storage: options.storage,
    onTitleChange: options.onTitleChange,
  });

  return {
    enabled: true,
    conversationId,
    getValue: () => store.readState(),
    setValue: (key, value) => store.setValue(key, value),
    setTitle: (title) => store.setTitle(title),
    appendMessage: (message) => store.appendMessage(message),
  };
}

export function createDisabledProjectConversationContext(): ConversationContext {
  return {
    enabled: false,
    async getValue() {
      throw createDisabledConversationError();
    },
    async setValue() {
      throw createDisabledConversationError();
    },
    async setTitle() {
      // Conversation title changes are optional UI hints. Calling
      // setTitle outside conversation mode must not interrupt workflow runs.
      return undefined;
    },
    async appendMessage() {
      throw createDisabledConversationError();
    },
  };
}

function createProjectConversationStore(options: {
  projectName: string;
  conversationId: string;
  storage: ConversationStateStorage;
  onTitleChange?: (event: {
    conversationId: string;
    title?: string;
    updatedAt: string;
  }) => Promise<void> | void;
}): {
  readState(): Promise<ConversationState>;
  setValue(key: string, value: unknown): Promise<ConversationState>;
  setTitle(title: string): Promise<ConversationState | undefined>;
  appendMessage(message: AppendProjectConversationMessageInput): Promise<ConversationState>;
} {
  async function readState(): Promise<ConversationState> {
    return options.storage.read(createInitialConversationState(options.projectName, options.conversationId));
  }

  const update = (change: (state: ConversationState) => ConversationState) => options.storage.update(
    createInitialConversationState(options.projectName, options.conversationId), change);

  return {
    readState,
    async setValue(key, value) {
      const normalizedKey = normalizeStateKey(key);
      return update(state => ({ ...state, updatedAt: new Date().toISOString(), values: { ...state.values, [normalizedKey]: value } }));
    },
    async setTitle(title) {
      const normalizedTitle = normalizeOptionalTitle(title);
      const written = await update(state => {
        const next = { ...state, title: normalizedTitle, updatedAt: new Date().toISOString() };
        if (normalizedTitle === undefined) delete next.title;
        return next;
      });
      await options.onTitleChange?.({ conversationId: options.conversationId, title: written.title, updatedAt: written.updatedAt });
      return written;
    },
    async appendMessage(message) {
      const id = message.id ?? randomUUID();
      return update(state => {
        const existing = state.messages.findIndex(entry => entry.id === id);
        const now = new Date().toISOString();
        const next = { id, role: message.role, content: message.content,
          createdAt: existing < 0 ? now : state.messages[existing]!.createdAt, metadata: message.metadata };
        const messages = [...state.messages];
        if (existing < 0) messages.push(next); else messages[existing] = next;
        return { ...state, updatedAt: now, messages };
      });
    },
  };
}

function createInitialConversationState(
  projectName: string,
  conversationId: string,
): ConversationState {
  const now = new Date().toISOString();
  return {
    conversationId,
    projectName,
    createdAt: now,
    updatedAt: now,
    messages: [],
    values: {},
  };
}

function createDisabledConversationError(): HarnessError {
  return new HarnessError({
    type: "input_validation",
    message:
      'Workflow conversation context is disabled. Set executor.projectType to "conversation" before using context.conversation.',
  });
}

function normalizeConversationId(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value.trim();
}

function normalizeStateKey(value: string): string {
  const key = value.trim();
  if (key === "") {
    throw new HarnessError({
      type: "input_validation",
      message: "Conversation state key must be a non-empty string.",
    });
  }
  return key;
}

function normalizeOptionalTitle(value: string): string | undefined {
  const title = value.trim().replace(/\s+/g, " ");
  return title === "" ? undefined : title;
}

function isProjectConversationState(
  value: unknown,
): value is ConversationState {
  return (
    isRecord(value) &&
    typeof value.conversationId === "string" &&
    typeof value.projectName === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.messages) &&
    value.messages.every(isProjectConversationMessage) &&
    isRecord(value.values)
  );
}

function isProjectConversationMessage(
  value: unknown,
): value is ConversationMessageContract {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isProjectConversationRole(value.role) &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string" &&
    (value.metadata === undefined || isRecord(value.metadata))
  );
}

function isProjectConversationRole(value: unknown): value is ConversationRole {
  return value === "user" || value === "assistant" || value === "system" || value === "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
