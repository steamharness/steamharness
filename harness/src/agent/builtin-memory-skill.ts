import { readFileSync } from "node:fs";
export const AGENT_MEMORY_SKILL_PROMPT = readFileSync(
  new URL("./skills/steamharness-memory/SKILL.md", import.meta.url),
  "utf8",
)
  .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/u, "")
  .trim();
