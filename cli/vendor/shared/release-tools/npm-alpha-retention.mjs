import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const ALPHA_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-(\d{11})$/u;

export function selectSupersededAlphaVersions(versions, retain = 3) {
  return versions
    .filter((version) => ALPHA_VERSION_PATTERN.test(String(version)))
    .sort(compareAlphaVersions)
    .slice(0, -retain);
}

export async function deprecateSupersededAlphaVersions({ packageName, currentVersion, retain = 3, runCommand = run }) {
  const output = await runCommand("npm", ["view", packageName, "versions", "--json"], { capture: true });
  const versions = normalizeVersions(JSON.parse(output));
  if (!versions.includes(currentVersion)) {
    throw new Error(`${packageName}@${currentVersion} is not visible from npm after publication.`);
  }
  const superseded = selectSupersededAlphaVersions(versions, retain);
  const updated = [];
  const alreadyDeprecated = [];
  for (const version of superseded) {
    const message = `Superseded alpha release; use ${packageName}@alpha.`;
    if (await readDeprecationMessage(packageName, version, runCommand) !== undefined) {
      alreadyDeprecated.push(version);
      continue;
    }
    try {
      await runCommand("npm", ["deprecate", `${packageName}@${version}`, message]);
    } catch (error) {
      // npm returns 422 when an equivalent deprecation is already present.
      // Confirm registry state before treating that idempotent write as success.
      if (await readDeprecationMessage(packageName, version, runCommand) === undefined) throw error;
    }
    updated.push(version);
  }
  return {
    retained: versions.filter((version) => ALPHA_VERSION_PATTERN.test(version)).sort(compareAlphaVersions).slice(-retain),
    deprecated: superseded,
    updated,
    alreadyDeprecated,
  };
}

async function readDeprecationMessage(packageName, version, runCommand) {
  const output = await runCommand(
    "npm",
    ["view", `${packageName}@${version}`, "deprecated", "--json"],
    { capture: true },
  );
  const normalized = String(output).trim();
  if (normalized === "") return undefined;
  const value = JSON.parse(normalized);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function normalizeVersions(value) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("npm versions response is invalid.");
  }
  return value;
}

function compareAlphaVersions(left, right) {
  const leftParts = ALPHA_VERSION_PATTERN.exec(left).slice(1).map(Number);
  const rightParts = ALPHA_VERSION_PATTERN.exec(right).slice(1).map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
  const packageName = process.argv[2];
  const currentVersion = process.argv[3];
  if (!packageName || !currentVersion) {
    throw new Error("Usage: npm-alpha-retention.mjs <package-name> <current-version>");
  }
  const result = await deprecateSupersededAlphaVersions({ packageName, currentVersion });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
