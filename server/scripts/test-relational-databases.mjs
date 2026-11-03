import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const name = `steamharness-relational-test-${randomUUID().slice(0, 8)}`;
const password = randomBytes(32).toString("hex");
let started = false;
try {
  await run("docker", ["run", "--detach", "--rm", "--name", name,
    "--env", "POSTGRES_DB=steamharness_test", "--env", "POSTGRES_USER=steamharness_test",
    "--env", `POSTGRES_PASSWORD=${password}`, "--publish", "127.0.0.1::5432", "postgres:17-alpine"]);
  started = true;
  const output = await run("docker", ["port", name, "5432/tcp"], { capture: true });
  const port = /:(\d+)\s*$/.exec(output)?.[1];
  if (!port) throw new Error("Unable to resolve the isolated PostgreSQL test port.");
  const connectionString = `postgresql://steamharness_test:${password}@127.0.0.1:${port}/steamharness_test`;
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ connectionString });
    try { await client.connect(); await client.query("select 1"); break; }
    catch { if (attempt >= 59) throw new Error("The isolated PostgreSQL test database did not become ready."); }
    finally { await client.end().catch(() => undefined); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await run(process.execPath, ["--import", "tsx", "--conditions=development", "--test", "--test-reporter=spec", "--test-concurrency=1",
    "src/__tests__/relational-databases-postgres.test.ts", "src/__tests__/relational-databases-http-postgres.test.ts"], {
    env: { ...process.env, STEAMHARNESS_TEST_RELATIONAL_DATABASE_URL: connectionString, STEAMHARNESS_AUTH_COOKIE_SECRET: randomBytes(32).toString("hex") },
  });
} finally {
  if (started) await run("docker", ["stop", "--time", "5", name]);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env ?? process.env, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    const output = [];
    if (options.capture) { child.stdout.on("data", value => output.push(value)); child.stderr.resume(); }
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(Buffer.concat(output).toString("utf8")) : reject(new Error(`Test process exited ${code ?? 1}.`)));
  });
}
