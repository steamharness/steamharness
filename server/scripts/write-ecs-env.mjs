import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COMPOSE_KEYS = Object.freeze([
  "STEAMHARNESS_RELEASE_STORAGE_ROOT", "STEAMHARNESS_POSTGRES_DB", "STEAMHARNESS_POSTGRES_USER", "STEAMHARNESS_POSTGRES_PASSWORD",
  "TZ",
]);

const RUNTIME_KEYS = Object.freeze([
  "STEAMHARNESS_SERVER_ADMIN_KEY", "STEAMHARNESS_AUTH_COOKIE_SECRET", "STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL", "STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD",
  "STEAMHARNESS_DATABASE_URL", "STEAMHARNESS_POSTGRES_DB", "STEAMHARNESS_POSTGRES_USER", "STEAMHARNESS_POSTGRES_PASSWORD",
  // Objects live on the host under STEAMHARNESS_LOCAL_STORAGE_ROOT; empty values are
  // dropped when the file is written.
  "STEAMHARNESS_STORAGE_DRIVER", "STEAMHARNESS_LOCAL_STORAGE_ROOT",
  "STEAMHARNESS_PUBLIC_BASE_URL", "STEAMHARNESS_API_PUBLIC_BASE_URL",
  "STEAMHARNESS_STORAGE_BUCKET", "STEAMHARNESS_STORAGE_FILE_SIZE_LIMIT_BYTES", "STEAMHARNESS_DOWNLOAD_PUBLIC_BASE_URL", "STEAMHARNESS_UPDATES_PUBLIC_BASE_URL",
  "STEAMHARNESS_DOCS_PUBLIC_BASE_URL", "STEAMHARNESS_DOCS_API_PUBLIC_BASE_URL",
]);

const REQUIRED = Object.freeze({
  compose: ["STEAMHARNESS_RELEASE_STORAGE_ROOT", "STEAMHARNESS_POSTGRES_PASSWORD"],
  stable: ["STEAMHARNESS_SERVER_ADMIN_KEY", "STEAMHARNESS_DATABASE_URL", "STEAMHARNESS_POSTGRES_PASSWORD"],
  alpha: ["STEAMHARNESS_SERVER_ADMIN_KEY", "STEAMHARNESS_DATABASE_URL", "STEAMHARNESS_POSTGRES_PASSWORD"],
});

export function buildEcsEnv({ kind, env = process.env } = {}) {
  if (!(kind in REQUIRED)) throw new Error(`Unknown ECS env kind: ${kind}`);
  const keys = kind === "compose" ? COMPOSE_KEYS : RUNTIME_KEYS;
  const values = Object.fromEntries(keys.map((key) => [key, String(env[key] ?? "").trim()]));
  for (const key of REQUIRED[kind]) if (!values[key]) throw new Error(`Missing ${key} for ECS ${kind} environment.`);
  values.STEAMHARNESS_RELEASE_STORAGE_ROOT = "/srv/workflow-release";
  if (kind !== "compose") {
    values.STEAMHARNESS_DATABASE_URL = buildLocalDatabaseUrl(values, env);
    values.STEAMHARNESS_RELEASE_CHANNEL = kind;
    values.STEAMHARNESS_SERVER_PORT = kind === "alpha" ? "7140" : "7130";
    values.STEAMHARNESS_SERVER_DATA_DIR = `/srv/workflow-release/server-data/${kind}`;
  }
  return serializeEnvValues(kind, values);
}

function serializeEnvValues(kind, values) {
  const entries = Object.entries(values).filter(([, value]) => value !== "");
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => `${key}=${quoteEnvValue(kind === "compose" ? value.replaceAll("$", "$$") : value)}`).join("\n") + "\n";
}

function buildLocalDatabaseUrl(values, env) {
  const user = values.STEAMHARNESS_POSTGRES_USER || "workflow";
  const password = String(env.STEAMHARNESS_POSTGRES_PASSWORD ?? "");
  const database = values.STEAMHARNESS_POSTGRES_DB || "workflow";
  if (!password) throw new Error("Missing STEAMHARNESS_POSTGRES_PASSWORD for ECS runtime environment.");
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:7125/${encodeURIComponent(database)}`;
}

function quoteEnvValue(value) {
  if (/^[A-Za-z0-9_./:@%+,-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}

async function writeEcsEnv({ kind, output, env = process.env }) {
  const target = path.resolve(output);
  await writeFile(target, buildEcsEnv({ kind, env }), { mode: 0o600 });
  await chmod(target, 0o600);
  return target;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--kind") options.kind = argv[++index];
    else if (argv[index] === "--output") options.output = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.kind || !options.output) throw new Error("Usage: write-ecs-env.mjs --kind <compose|stable|alpha> --output <file>");
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await writeEcsEnv(parseArgs(process.argv.slice(2)));
