import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const coreVersion = manifest.dependencies?.["workflow-code"];
if (typeof coreVersion !== "string" || !/^\d+\.\d+\.\d+(?:-\d{11})?$/.test(coreVersion)) {
  throw new Error("workflow-code must use an exact stable or dated alpha version.");
}

const commitSha = process.env.CI_COMMIT_SHA?.trim()
  || String((await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root })).stdout).trim();
const output = path.join(root, "dist", "build-info.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({
  productVersion: manifest.version,
  coreVersion,
  commitSha,
  nodeVersion: process.versions.node,
}, null, 2)}\n`, "utf8");
