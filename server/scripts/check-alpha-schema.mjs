import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DESTRUCTIVE_SCHEMA_PATTERNS = [
  /\bdrop\s+(?:table|column|constraint|type|schema)\b/iu,
  /\btruncate\b/iu,
  /\balter\s+table[\s\S]{0,240}\balter\s+column[\s\S]{0,120}\b(?:type|set\s+not\s+null)\b/iu,
  /\balter\s+column[\s\S]{0,120}\b(?:type|set\s+not\s+null)\b/iu,
  /\brename\s+(?:to|table|column)\b/iu,
];

export function addedDiffText(diff) {
  return String(diff)
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

export function findDestructiveSchemaChanges(diff) {
  const added = addedDiffText(diff);
  return DESTRUCTIVE_SCHEMA_PATTERNS
    .filter((pattern) => pattern.test(added))
    .map((pattern) => pattern.source);
}

export async function checkAlphaSchema({ root, base = "origin/main", runCommand = run }) {
  const diff = await runCommand("git", [
    "diff",
    "--unified=0",
    `${base}...HEAD`,
    "--",
    "src/account-db.ts",
    "src/persistence.ts",
  ], { cwd: path.resolve(root), capture: true });
  const violations = findDestructiveSchemaChanges(diff);
  if (violations.length > 0) {
    throw new Error(
      "Alpha and main share PostgreSQL. Alpha only permits expand-only schema changes; destructive DDL was added.",
    );
  }
  return { base, checkedFiles: ["src/account-db.ts", "src/persistence.ts"] };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const baseIndex = process.argv.indexOf("--base");
  const result = await checkAlphaSchema({
    root: path.resolve(import.meta.dirname, ".."),
    base: baseIndex >= 0 ? process.argv[baseIndex + 1] : "origin/main",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
