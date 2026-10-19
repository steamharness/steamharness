import { randomUUID } from "node:crypto";
import type { KVContext } from "../kv/index";
import { HarnessError } from "../workflow/errors";

/** Where a conversation's own state lives inside its KV namespace. */
export const CONVERSATION_STATE_KEY = "conversation.state";

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

export interface AppendWorkflowConversationMessageInput {
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
    message: AppendWorkflowConversationMessageInput,
  ): Promise<ConversationState>;
}

export interface ConversationRuntimeOptions {
  enabled?: boolean;
  conversationId?: string;
  projectName: string;
  kv?: KVContext;
  onTitleChange?: (event: {
    conversationId: string;
    title?: string;
    updatedAt: string;
  }) => Promise<void> | void;
}

export function createWorkflowConversationContext(
  options: ConversationRuntimeOptions,
): ConversationContext {
  if (options.enabled !== true) {
    return createDisabledWorkflowConversationContext();
  }

  if (options.kv === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message:
        "Workflow conversation is enabled, but no workflow KV context was configured.",
      metadata: { workflow: options.projectName },
    });
  }

  const conversationId = normalizeConversationId(options.conversationId);
  if (conversationId === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message:
        "Workflow conversation is enabled, but no conversation id was configured.",
      metadata: { workflow: options.projectName },
    });
  }
  const store = createWorkflowConversationStore({
    projectName: options.projectName,
    conversationId,
    kv: options.kv,
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

export function createDisabledWorkflowConversationContext(): ConversationContext {
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

function createWorkflowConversationStore(options: {
  projectName: string;
  conversationId: string;
  kv: KVContext;
  onTitleChange?: (event: {
    conversationId: string;
    title?: string;
    updatedAt: string;
  }) => Promise<void> | void;
}): {
  readState(): Promise<ConversationState>;
  setValue(key: string, value: unknown): Promise<ConversationState>;
  setTitle(title: string): Promise<ConversationState | undefined>;
  appendMessage(message: AppendWorkflowConversationMessageInput): Promise<ConversationState>;
} {
  async function readState(): Promise<ConversationState> {
    const value = await options.kv.conversation.getValue(CONVERSATION_STATE_KEY);
    if (isWorkflowConversationState(value)) {
      return value;
    }

    return createInitialConversationState(options.projectName, options.conversationId);
  }

  async function writeState(
    state: ConversationState,
  ): Promise<ConversationState> {
    await options.kv.conversation.setValue(CONVERSATION_STATE_KEY, state);
    return state;
  }

  return {
    readState,
    async setValue(key, value) {
      const normalizedKey = normalizeStateKey(key);
      const state = await readState();
      return writeState({
        ...state,
        updatedAt: new Date().toISOString(),
        values: {
          ...state.values,
          [normalizedKey]: value,
        },
      });
    },
    async setTitle(title) {
      const normalizedTitle = normalizeOptionalTitle(title);
      const state = await readState();
      const updatedAt = new Date().toISOString();
      const nextState: ConversationState = {
        ...state,
        updatedAt,
        ...(normalizedTitle === undefined ? {} : { title: normalizedTitle }),
      };
      if (normalizedTitle === undefined) {
        delete nextState.title;
      }

      // Core code may suggest a conversation title, while the host UI
      // remains responsible for lock policy and can ignore this update.
      const written = await writeState(nextState);
      await options.onTitleChange?.({
        conversationId: options.conversationId,
        title: written.title,
        updatedAt,
      });
      return written;
    },
    async appendMessage(message) {
      const id = message.id ?? randomUUID();
      return await options.kv.conversation.updateValue(CONVERSATION_STATE_KEY, current => {
        const state = isWorkflowConversationState(current) ? current
          : createInitialConversationState(options.projectName, options.conversationId);
        const existing = state.messages.findIndex(entry => entry.id === id);
        const now = new Date().toISOString();
        const next = { id, role: message.role, content: message.content,
          createdAt: existing < 0 ? now : state.messages[existing]!.createdAt, metadata: message.metadata };
        const messages = [...state.messages];
        if (existing < 0) messages.push(next); else messages[existing] = next;
        return { ...state, updatedAt: now, messages };
      }) as ConversationState;
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

function isWorkflowConversationState(
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
    value.messages.every(isWorkflowConversationMessage) &&
    isRecord(value.values)
  );
}

function isWorkflowConversationMessage(
  value: unknown,
): value is ConversationMessageContract {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isWorkflowConversationRole(value.role) &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string" &&
    (value.metadata === undefined || isRecord(value.metadata))
  );
}

function isWorkflowConversationRole(value: unknown): value is ConversationRole {
  return value === "user" || value === "assistant" || value === "system" || value === "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
