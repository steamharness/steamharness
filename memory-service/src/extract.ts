import {
  getExtractMemoriesSystemPrompt,
  formatExtractionPrompt,
} from "../vendor/tencent/l1-extraction.js";
import {
  getConflictDetectionSystemPrompt,
  formatBatchConflictPrompt,
} from "../vendor/tencent/l1-dedup.js";
import type { MemoryStore, MemoryScope, MemoryItem } from "./store.js";
export interface Turn {
  turnId: string;
  scope: MemoryScope;
  messages: {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }[];
}
async function model(system: string, prompt: string): Promise<unknown[]> {
  const url = process.env.STEAMHARNESS_MEMORY_MODEL_BASE_URL,
    key = process.env.STEAMHARNESS_MEMORY_MODEL_API_KEY,
    name = process.env.STEAMHARNESS_MEMORY_MODEL;
  if (!url || !key || !name)
    throw new Error("Memory extraction model is not configured.");
  const response = await fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(120000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: name,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(
      `Memory extraction model returned HTTP ${response.status}.`,
    );
  const body = (await response.json()) as any;
  const raw = String(body.choices?.[0]?.message?.content ?? "").replace(
    /<think>[\s\S]*?<\/think>/g,
    "",
  );
  const array = raw.match(/\[[\s\S]*\]/)?.[0];
  if (!array) throw new Error("Invalid extraction response.");
  const result = JSON.parse(array);
  if (!Array.isArray(result)) throw new Error("Invalid extraction response.");
  return result;
}
/** Extraction never commits: Server revalidates authorization and scope versions before apply. */
export async function extract(store: MemoryStore, turn: Turn) {
  const scenes = await model(
    getExtractMemoriesSystemPrompt("chat") +
      "\nOnly extract durable facts explicitly supported by the user. Assistant claims are not evidence. Never extract credentials. For a lasting personal preference set metadata.personal_preference=true and metadata.explicit_user_preference=true; never set these for project facts or uncertain classifications.",
    formatExtractionPrompt({ newMessages: turn.messages }),
  );
  const allowed = new Map(
    turn.messages.filter((m) => m.role === "user").map((m) => [m.id, m]),
  );
  const candidates: {
    content: string;
    scope: MemoryScope;
    sources: MemoryItem["sources"];
    type: string;
    priority: number;
    record_id: string;
  }[] = [];
  // Leave room for the apply envelope under the internal HTTP request limit.
  let candidateBytes = 2;
  scenes: for (const scene of scenes as any[])
    for (const m of Array.isArray(scene?.memories) ? scene.memories : []) {
      if (
        !m ||
        typeof m.content !== "string" ||
        !m.content.trim() ||
        m.content.length > 16000
      )
        continue;
      const ids = Array.isArray(m.source_message_ids)
        ? [...new Set(m.source_message_ids)]
        : [];
      if (
        !ids.length ||
        ids.some((id: unknown) => typeof id !== "string" || !allowed.has(id))
      )
        continue;
      // Only explicit, durable personal preferences may leave the current project.
      const global =
        m.type === "persona" &&
        m.metadata?.personal_preference === true &&
        m.metadata?.explicit_user_preference === true;
      if (turn.scope === "global" && !global) continue;
      const candidate: (typeof candidates)[number] = {
        content: m.content.trim(),
        scope: global ? "global" : turn.scope,
        sources: ids.slice(0, 8).map((id) => {
          const source = allowed.get(String(id))!;
          return {
            id: source.id,
            role: source.role,
            content: source.content.slice(0, 4000),
          };
        }),
        type: String(m.type),
        priority: Math.min(10, Math.max(1, Number(m.priority) || 5)),
        record_id: `${turn.turnId}:${candidates.length}`,
      };
      const bytes = Buffer.byteLength(JSON.stringify(candidate)) + 1;
      if (candidateBytes + bytes > 220000) continue;
      candidates.push(candidate);
      candidateBytes += bytes;
      if (candidates.length >= 20) break scenes;
    }
  const matches = candidates.map((c) => ({
    newMemory: c,
    candidates: store
      .recall([c.scope], c.content, 5)
      .map((m) => ({ ...m, type: "instruction", priority: 5 })),
  }));
  if (!matches.some((m) => m.candidates.length)) return candidates;
  const decisions = await model(
    getConflictDetectionSystemPrompt("chat"),
    formatBatchConflictPrompt(matches),
  );
  // Existing records (especially manual records) are immutable to automatic jobs.
  const skip = new Set(
    (decisions as any[])
      .filter(
        (d) =>
          d.action === "skip" || d.action === "merge" || d.action === "update",
      )
      .map((d) => d.record_id ?? d.new_memory_id),
  );
  return candidates.filter((c) => !skip.has(c.record_id));
}
