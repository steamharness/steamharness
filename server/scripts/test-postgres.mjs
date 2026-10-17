import { spawn } from "node:child_process";
import process from "node:process";
import pg from "pg";

const containerName = `workflow-code-postgres-test-${process.pid}`;
const password = "workflow-test-password";
let started = false;

try {
  await run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name", containerName,
    "--env", "POSTGRES_DB=workflow_test",
    "--env", "POSTGRES_USER=workflow_test",
    "--env", `POSTGRES_PASSWORD=${password}`,
    "--publish", "127.0.0.1::5432",
    "postgres:15-alpine",
  ]);
  started = true;
  const portOutput = await run("docker", ["port", containerName, "5432/tcp"], { capture: true });
  const port = /:(\d+)\s*$/u.exec(portOutput)?.[1];
  if (!port) throw new Error("Unable to resolve the isolated PostgreSQL port.");
  const databaseUrl = `postgresql://workflow_test:${password}@127.0.0.1:${port}/workflow_test`;
  await waitForPostgres(databaseUrl);
  await run("pnpm", [
    "exec",
    "tsx",
    "--conditions=development",
    "--test",
    "--test-reporter=spec",
    "--test-concurrency=1",
    "src/__tests__/storage-postgres.test.ts",
    "src/__tests__/account-auth-postgres.test.ts",
  ], {
    env: { ...process.env, WORKFLOW_TEST_DATABASE_URL: databaseUrl },
  });
} finally {
  if (started) {
    await run("docker", ["stop", "--time", "5", containerName], { ignoreFailure: true });
  }
}

async function waitForPostgres(connectionString) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Isolated PostgreSQL did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (options.capture) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      if (options.ignoreFailure) {
        resolve("");
        return;
      }
      const details = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(`${command} exited ${code ?? signal ?? 1}${details ? `: ${details}` : ""}`));
    });
  });
}
