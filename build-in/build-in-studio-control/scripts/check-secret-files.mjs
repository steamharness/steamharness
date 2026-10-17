import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|APIKEY|KEY|ACCESS_KEY(?:_ID|_SECRET)?|ANON_KEY|SERVICE_ROLE_KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE_KEY|DATABASE_URL|SESSDATA|BILI_JCT|BUVID3)(?:$|_)/iu;
const PLACEHOLDER_VALUE = /(?:replace(?:[-_ ]with)?|change[-_ ]?me|placeholder|example|your[-_ ]|<[^>]+>|\.\.\.)/iu;

export function isEnvironmentFile(filePath) {
  const name = path.posix.basename(normalizePath(filePath));
  return name === ".env" || name.startsWith(".env.");
}

export function isExampleEnvironmentFile(filePath) {
  return isEnvironmentFile(filePath) && path.posix.basename(normalizePath(filePath)).endsWith(".example");
}

export function findUnsafeEnvironmentPaths({ tracked = [], untracked = [], historical = [] }) {
  return [...new Set([...tracked, ...untracked, ...historical]
    .map(normalizePath)
    .filter((filePath) => isEnvironmentFile(filePath) && !isExampleEnvironmentFile(filePath)))]
    .sort();
}

export function findUnsafeExampleAssignments(contents) {
  const findings = [];
  for (const [index, line] of String(contents).split(/\r?\n/u).entries()) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match || !SENSITIVE_ENV_NAME.test(match[1])) continue;
    const value = stripQuotes(match[2].trim());
    if (value !== "" && !PLACEHOLDER_VALUE.test(value)) findings.push({ line: index + 1, name: match[1] });
  }
  return findings;
}

export async function findUnsafeHistoricalExampleAssignments(entries, readBlob) {
  const findings = [];
  const visited = new Set();
  for (const entry of entries) {
    const key = `${entry.objectId}\0${normalizePath(entry.filePath)}`;
    if (visited.has(key) || !isExampleEnvironmentFile(entry.filePath)) continue;
    visited.add(key);
    const matches = findUnsafeExampleAssignments(await readBlob(entry.objectId));
    findings.push(...matches.map((finding) => ({ filePath: normalizePath(entry.filePath), ...finding })));
  }
  return findings;
}

export async function auditSecretFiles(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const tracked = gitLines(root, ["ls-files"]);
  const untracked = gitLines(root, ["ls-files", "--others", "--exclude-standard"]);
  const historical = gitLines(root, ["log", "--all", "--format=", "--name-only", "--no-renames"]);
  const unsafePaths = findUnsafeEnvironmentPaths({ tracked, untracked, historical });
  const unsafeAssignments = [];
  const examples = [...new Set([...tracked, ...untracked].map(normalizePath))]
    .filter(isExampleEnvironmentFile)
    .sort();
  for (const filePath of examples) {
    const findings = findUnsafeExampleAssignments(await readFile(path.join(root, ...filePath.split("/")), "utf8"));
    unsafeAssignments.push(...findings.map((finding) => ({ filePath, ...finding })));
  }
  unsafeAssignments.push(...await findUnsafeHistoricalExampleAssignments(
    historicalExampleEntries(root),
    (objectId) => gitOutput(root, ["cat-file", "blob", objectId]),
  ));
  return { unsafePaths, unsafeAssignments };
}

function gitLines(root, args) {
  return gitOutput(root, args)
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function historicalExampleEntries(root) {
  const entries = [];
  for (const commit of gitLines(root, ["rev-list", "--all"])) {
    for (const line of gitLines(root, ["ls-tree", "-r", "--format=%(objectname)%x09%(path)", commit])) {
      const separator = line.indexOf("\t");
      if (separator < 1) continue;
      entries.push({ objectId: line.slice(0, separator), filePath: line.slice(separator + 1) });
    }
  }
  return entries;
}

function gitOutput(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function stripQuotes(value) {
  const quote = value[0];
  return value.length >= 2 && (quote === "\"" || quote === "'") && value.at(-1) === quote
    ? value.slice(1, -1)
    : value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await auditSecretFiles();
  for (const filePath of result.unsafePaths) console.error(`Credential-bearing env files must not be committed or retained in history: ${filePath}`);
  for (const finding of result.unsafeAssignments) console.error(`Sensitive example value must be empty or an explicit placeholder: ${finding.filePath}:${finding.line} ${finding.name}`);
  if (result.unsafePaths.length > 0 || result.unsafeAssignments.length > 0) process.exitCode = 1;
  else console.log("Secret file audit passed.");
}
