import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "dotenv";

const serverRoot = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(serverRoot, "docker/relational-dev");
const envFile = path.join(directory, ".env");

export async function relationalDevelopmentEnvironment() {
  let values;
  try { values = parse(await readFile(envFile, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    values = {
      STEAMHARNESS_SERVER_DEV_DATABASE_PASSWORD: randomBytes(32).toString("hex"),
      STEAMHARNESS_SERVER_ADMIN_KEY: randomBytes(32).toString("hex"),
      STEAMHARNESS_AUTH_COOKIE_SECRET: randomBytes(32).toString("hex"),
      STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL: "admin@relational.local",
      STEAMHARNESS_BOOTSTRAP_ADMIN_PASSWORD: randomBytes(24).toString("hex"),
    };
    await mkdir(directory, { recursive: true });
    await writeFile(envFile, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600, flag: "wx" });
  }
  if (!values.STEAMHARNESS_SERVER_DEV_DATABASE_PASSWORD) throw new Error("The isolated development database password is missing.");
  return {
    ...process.env, ...values,
    STEAMHARNESS_SKIP_ENV_FILES: "1",
    STEAMHARNESS_REPO_ROOT: serverRoot,
    STEAMHARNESS_SERVER_DATA_DIR: path.join(serverRoot, ".data/relational-dev"),
    STEAMHARNESS_DATABASE_URL: `postgresql://steamharness_dev:${encodeURIComponent(values.STEAMHARNESS_SERVER_DEV_DATABASE_PASSWORD)}@127.0.0.1:18125/steamharness_platform`,
    STEAMHARNESS_SERVER_DATABASE_ADMIN_URL: `postgresql://steamharness_dev:${encodeURIComponent(values.STEAMHARNESS_SERVER_DEV_DATABASE_PASSWORD)}@127.0.0.1:18125/steamharness_platform`,
    STEAMHARNESS_SERVER_HOST: "127.0.0.1",
    STEAMHARNESS_SERVER_PORT: "18126",
    STEAMHARNESS_SERVER_STRICT_PORT: "1",
    STEAMHARNESS_SERVER_DEV: "1",
    STEAMHARNESS_SERVER_WEB_DEV: "0",
    STEAMHARNESS_API_PUBLIC_BASE_URL: "http://127.0.0.1:18126",
    NODE_ENV: "development",
  };
}

async function main() {
  const action = process.argv[2] ?? "up";
  if (!["up", "down", "status", "server"].includes(action)) throw new Error("Usage: pnpm database:dev <up|down|status|server>");
  const env = await relationalDevelopmentEnvironment();
  if (action === "server") {
    await run(process.execPath, ["--import", "tsx", "--conditions=development", "src/index.ts"], env);
    return;
  }
  const args = ["compose", "--project-name", "steamharness-relational-dev", "--env-file", envFile, "--file", path.join(directory, "compose.yaml")];
  args.push(...(action === "up" ? ["up", "--detach", "--wait"] : action === "down" ? ["down"] : ["ps"]));
  await run("docker", args, env);
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: serverRoot, env, stdio: "inherit" });
    const forward = signal => child.kill(signal);
    process.once("SIGINT", forward); process.once("SIGTERM", forward);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", forward); process.removeListener("SIGTERM", forward);
      if (code === 0) resolve(); else reject(new Error(`Development process exited ${code ?? signal ?? 1}.`));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
