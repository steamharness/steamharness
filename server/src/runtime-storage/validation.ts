import { z } from "zod";
import type { RuntimeStorageOperation, RuntimeWorkspaceInput } from "steamharness/runtime-storage";

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const version = z.number().int().positive().max(2_147_483_647);
const plainText = z.string().min(1).max(512).refine(value => !value.includes("\0"));
const scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session") }).strict(),
  z.object({ kind: z.literal("conversation"), conversationId: id }).strict(),
  z.object({ kind: z.literal("task"), taskId: id }).strict(),
]);
const point = z.union([z.literal("current"), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)]);
const json = z.json();
const object = z.record(z.string(), json);
const base = z.object({ kind: z.literal("base"), version, value: object }).strict();
const content = z.discriminatedUnion("kind", [base, z.object({ kind: z.literal("delta"), version, ops: z.array(json).max(100_000) }).strict()]);
const address = z.object({ kind: z.string(), scope, key: z.string().optional() }).strict();
const document = address.extend({ id, history: z.enum(["latest", "rewindable"]).optional(), fork: z.enum(["asOf", "current", "initial"]).optional() }).superRefine((value, ctx) => {
  if (value.scope.kind === "conversation") {
    if (!value.history || !value.fork || value.history === "latest" && value.fork === "asOf") ctx.addIssue({ code: "custom", message: "Invalid conversation document semantics." });
  } else if (value.history !== undefined || value.fork !== undefined) ctx.addIssue({ code: "custom", message: "Session and task documents do not declare history or fork semantics." });
});
const conversation = z.object({ id, parent: z.object({ conversationId: id, at: id }).strict().optional(), owner: z.object({ conversationId: id, taskId: id }).strict().optional() }).strict();
const entry = z.object({ id, conversationId: id, kind: z.string(), data: json.optional(), model: z.array(json).optional(), head: id.optional(), byTaskId: id.optional(), edits: z.array(json).optional() }).strict();
const state = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), checkpoint: json }).strict(),
  z.object({ status: z.literal("running"), checkpoint: json }).strict(),
  z.object({ status: z.literal("waiting"), checkpoint: json, on: z.array(id), policy: z.enum(["failFast", "allSettled"]) }).strict(),
  z.object({ status: z.literal("completing"), outcome: json }).strict(),
  z.object({ status: z.literal("terminal"), outcome: json }).strict(),
]);
const task = z.object({
  id, conversationId: id, kind: z.string(), version, input: json, state, background: z.boolean(), abortRequested: z.boolean(),
  owner: id.optional(), abortReason: z.literal("restart").optional(), abandonOnRestart: z.literal(true).optional(),
  startedAt: z.number().finite().optional(), endedAt: z.number().finite().optional(), memos: object.optional(),
}).strict();
const submission = z.object({
  id, conversationId: id, requestId: z.string().optional(), type: z.enum(["input", "write"]),
  status: z.enum(["queued", "placed", "done", "unanswered"]), entry: id.optional(), answer: id.optional(), reason: z.string().optional(), detail: json.optional(),
}).strict();
const write = z.discriminatedUnion("type", [
  z.object({ type: z.literal("conversation"), value: conversation }).strict(),
  z.object({ type: z.literal("entry"), value: entry }).strict(),
  z.object({ type: z.literal("task"), value: task }).strict(),
  z.object({ type: z.literal("submission"), value: submission }).strict(),
  z.object({ type: z.literal("document.create"), record: document, content: base }).strict(),
  z.object({ type: z.literal("document.copy"), record: document, source: z.object({ id, at: point }).strict() }).strict(),
  z.object({ type: z.literal("document.change"), id, content }).strict(),
  z.object({ type: z.literal("document.retire"), id }).strict(),
]);
const scan = { limit: z.number().int().min(1).max(10_000), cursor: object.optional() };
// Order and cursor diagnostics are produced by the storage contract itself.
const order = z.string().optional();
const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), requestId: z.uuid(), writes: z.array(write).max(10_000) }).strict(),
  z.object({ kind: z.literal("mintId"), requestId: z.uuid() }).strict(),
  z.object({ kind: z.literal("renew") }).strict(), z.object({ kind: z.literal("release") }).strict(),
  z.object({ kind: z.literal("conversation"), id }).strict(), z.object({ kind: z.literal("task"), id }).strict(),
  z.object({ kind: z.literal("submission"), id }).strict(),
  z.object({ kind: z.literal("entry"), id, conversationId: id.optional() }).strict(),
  z.object({ kind: z.literal("head"), conversationId: id, atOrBeforeEntryId: id.optional() }).strict(),
  z.object({ kind: z.literal("conversations"), ...scan, query: z.object({ ownerConversationId: id.optional(), ownerTaskId: id.optional(), order }).strict() }).strict(),
  z.object({ kind: z.literal("entries"), ...scan, query: z.object({ conversationId: id, minEntryId: id.optional(), maxEntryId: id.optional(), order }).strict() }).strict(),
  z.object({ kind: z.literal("tasks"), ...scan, query: z.object({ conversationId: id.optional(), kind: z.string().optional(), status: z.enum(["pending", "running", "waiting", "completing", "terminal"]).optional(), abortRequested: z.boolean().optional(), background: z.boolean().optional(), order }).strict() }).strict(),
  z.object({ kind: z.literal("submissions"), ...scan, query: z.object({ conversationId: id.optional(), status: z.enum(["queued", "placed", "done", "unanswered"]).optional(), order }).strict() }).strict(),
  z.object({ kind: z.literal("submissionByRequest"), conversationId: id, requestId: z.string() }).strict(),
  z.object({ kind: z.literal("findDocument"), address, at: point }).strict(),
  z.object({ kind: z.literal("document"), id, at: point }).strict(),
  z.object({ kind: z.literal("documents"), ...scan, query: z.object({ scope, at: point, kind: z.string().optional() }).strict() }).strict(),
]);

const workspaceFields = { projectId: z.uuid(), entryId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) };
const workspaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), ...workspaceFields }).strict(),
  z.object({ kind: z.literal("local"), ...workspaceFields, localKey: plainText }).strict(),
  z.object({ kind: z.literal("assistant"), ...workspaceFields, localKey: plainText }).strict(),
]);
export function readRuntimeWorkspace(input: unknown): RuntimeWorkspaceInput { return workspaceSchema.parse(input); }
export const readRuntimeId = (input: unknown): string => z.uuid().parse(input);
export const openRuntimeSessionSchema = z.object({ sessionKey: plainText, ownerToken: z.string().min(32).max(128) }).strict();
export function readRuntimeOperation(input: unknown): { ownerToken: string; fence: number; operation: RuntimeStorageOperation } {
  z.object({ ownerToken: z.string().min(32).max(128), fence: id, operation: operationSchema }).strict().parse(input);
  // Zod's detached object output omits prototype-like JSON keys. Validation
  // must not rewrite the runtime's opaque JSON payloads; the HTTP parser and
  // database serialization already provide their ownership boundary.
  return input as { ownerToken: string; fence: number; operation: RuntimeStorageOperation };
}
