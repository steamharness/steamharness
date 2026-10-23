import { readFileSync } from "node:fs";

// This path is relative to src/agent in development and dist after bundling.
// Keep the upstream guide as a file so its attribution and original content
// travel with the package instead of maintaining a rewritten copy in code.
const guide = readFileSync(new URL("./skills/i-have-adhd/SKILL.md", import.meta.url), "utf8")
  .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/u, "")
  .trim();

export const BUILTIN_AGENT_SKILLS_PROMPT = [
  "## Built-in communication skill: i-have-adhd",
  "Use the i-have-adhd skill below by default for user-facing responses. Its full instructions are already loaded; no installation, slash command or tool call is needed.",
  "Treat it as a communication preference, not a diagnosis of the user. Follow the user's language, explicit formatting and detail requests, and honor requests to stop this style.",
  "The guide shapes presentation only. The agent's task, plan-mode constraints, tool permissions and required progress updates take precedence. Complete authorized work without adding confirmation steps or handing it back to the user.",
  guide,
].join("\n\n");
