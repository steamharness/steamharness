import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import {
  appendHistory,
  assertHistoryParity,
  assertNextParity,
  parseNext,
  readHistoryVersions,
} from "../vendor/shared/release-tools/release-notes.mjs";

export async function prepareRelease(options) {
  const root = path.resolve(options.root);
  const version = String(options.version ?? "").trim();
  if (!semver.valid(version) || semver.prerelease(version)) {
    throw new Error("Release version must be a stable X.Y.Z SemVer.");
  }

  const manifestPath = path.join(root, "package.json");
  const zhHistoryPath = path.join(root, "CHANGELOG.md");
  const enHistoryPath = path.join(root, "CHANGELOG.en.md");
  const zhNextPath = path.join(root, "CHANGELOG.next.md");
  const enNextPath = path.join(root, "CHANGELOG.next.en.md");
  const workspacePackages = await collectWorkspacePackageFiles(root);
  const workspaceLockPath = path.join(root, "workspace", "pnpm-lock.yaml");
  const paths = [
    manifestPath,
    zhHistoryPath,
    enHistoryPath,
    zhNextPath,
    enNextPath,
    ...workspacePackages,
    workspaceLockPath,
  ];
  const snapshots = await captureSnapshots(paths);
  const manifest = JSON.parse(snapshots.get(manifestPath).toString("utf8"));
  if (!semver.valid(manifest.version) || version !== manifest.version) {
    throw new Error(`Core package.json must be changed to ${version} before release preparation (found ${manifest.version}).`);
  }

  const zhHistory = snapshots.get(zhHistoryPath).toString("utf8");
  const enHistory = snapshots.get(enHistoryPath).toString("utf8");
  assertHistoryParity(zhHistory, enHistory);
  if (readHistoryVersions(zhHistory).some((release) => release.version === version)) {
    throw new Error(`${version} already exists in CHANGELOG.md.`);
  }
  const zhNext = parseNext(snapshots.get(zhNextPath).toString("utf8"), "zh-CN");
  const enNext = parseNext(snapshots.get(enNextPath).toString("utf8"), "en");
  assertNextParity(zhNext, enNext);

  const synchronizedPackages = [];
  try {
    for (const packageFile of workspacePackages) {
      const packageJson = JSON.parse(snapshots.get(packageFile).toString("utf8"));
      if (synchronizeDependency(packageJson, "workflow-code", version)) {
        await writeJson(packageFile, packageJson);
        synchronizedPackages.push(path.relative(root, packageFile));
      }
    }

    const date = options.date ?? new Date().toISOString().slice(0, 10);
    await Promise.all([
      writeFile(zhHistoryPath, appendHistory(zhHistory, version, date, zhNext.body), "utf8"),
      writeFile(enHistoryPath, appendHistory(enHistory, version, date, enNext.body), "utf8"),
      writeFile(zhNextPath, "# Unreleased\n", "utf8"),
      writeFile(enNextPath, "# Unreleased\n", "utf8"),
    ]);

    if (options.updateLockfile !== false) {
      const run = options.runCommand ?? runCommand;
      await run("corepack", ["pnpm", "install", "--lockfile-only"], {
        cwd: path.join(root, "workspace"),
      });
    }
  } catch (error) {
    await restoreSnapshots(snapshots);
    throw error;
  }

  return {
    unit: "workflow-code",
    version,
    tag: `workflow-code/v${version}`,
    synchronizedPackages: synchronizedPackages.sort(),
  };
}

async function collectWorkspacePackageFiles(root) {
  const files = [path.join(root, "workspace", "package.json")];
  for (const group of ["workflow", "conversation"]) {
    const groupRoot = path.join(root, "workspace", group);
    let entries = [];
    try {
      entries = await readdir(groupRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packageFile = path.join(groupRoot, entry.name, "package.json");
      try {
        if ((await stat(packageFile)).isFile()) files.push(packageFile);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return files.sort();
}

function synchronizeDependency(manifest, packageName, version) {
  let changed = false;
  for (const field of ["dependencies", "devDependencies"]) {
    if (manifest[field] && Object.hasOwn(manifest[field], packageName)) {
      manifest[field][packageName] = version;
      changed = true;
    }
  }
  return changed;
}

async function captureSnapshots(paths) {
  const snapshots = new Map();
  for (const filePath of new Set(paths)) {
    try {
      snapshots.set(filePath, await readFile(filePath));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      snapshots.set(filePath, undefined);
    }
  }
  return snapshots;
}

async function restoreSnapshots(snapshots) {
  for (const [filePath, contents] of snapshots) {
    if (contents === undefined) {
      await rm(filePath, { force: true });
      continue;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runCommand(command, args, options) {
  const invocation = resolveSpawnInvocation(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}.`)));
  });
}

export function resolveSpawnInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && command === "corepack") {
    const executable = path.win32.join(
      path.win32.dirname(options.execPath ?? process.execPath),
      "corepack.cmd",
    );
    return {
      command: options.comSpec ?? process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "call", executable, ...args],
    };
  }
  return { command, args };
}

function parseArgs(argv) {
  let version;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--version") {
      version = argv[index + 1];
      index += 1;
      continue;
    }
    if (!token.startsWith("--") && version === undefined) {
      version = token;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!version) throw new Error("Usage: pnpm release:prepare -- --version X.Y.Z");
  return { version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await prepareRelease({
    root: path.resolve(import.meta.dirname, ".."),
    ...parseArgs(process.argv.slice(2)),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
