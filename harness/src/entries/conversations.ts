import type { EntryCallIdentity } from './index';

/** The native host owns execution and history; project code only receives this projection. */
export interface EntryConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  requestId?: string;
  runId?: string;
  error?: string;
  items?: unknown[];
  pendingInput?: { requestId: string; title: string; description?: string; metadata?: { type?: string; toolName?: string; toolArguments?: unknown }; params: unknown[]; defaultValues?: Record<string, unknown> };
}
export interface EntryConversationSnapshot {
  entryId: string;
  conversationId: string;
  title: string;
  ownerId: string;
  revision: number;
  running: boolean;
  queuePaused: boolean;
  messages: EntryConversationMessage[];
  queue: { id: string; text: string; position: number }[];
}
export interface EntryConversationSubmit {
  conversationId: string;
  requestId: string;
  text: string;
  params?: Record<string, string | string[]>;
}
export interface EntryConversationReceipt {
  conversationId: string;
  requestId: string;
  messageId: string;
  status: 'queued' | 'accepted';
}
export type EntryConversationAction = 'list' | 'submit' | 'snapshot' | 'resolveInput' | 'cancel' | 'resumeQueue';
export interface EntryConversationHost {
  invoke(entryId: string, action: EntryConversationAction, input: Record<string, unknown>, identity: EntryCallIdentity): Promise<unknown>;
}
export interface EntryConversationContext {
  list(): Promise<{ conversationId: string; title: string }[]>;
  submit(input: EntryConversationSubmit): Promise<EntryConversationReceipt>;
  snapshot(conversationId: string): Promise<EntryConversationSnapshot>;
  resolveInput(input: { conversationId: string; messageId: string; requestId: string; values: Record<string, unknown> }): Promise<void>;
  cancel(input: { conversationId: string; requestId: string }): Promise<void>;
  resumeQueue(input: { conversationId: string; requestId: string }): Promise<void>;
}
