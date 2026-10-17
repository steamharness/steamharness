import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGitAuthenticationEnv } from "./alpha-release.mjs";

const ALPHA_VERSION_PATTERN = /^\d+\.\d+\.\d+-\d{11}$/u;

export function parseDependencyTarget(value) {
  const [project, manifestPath = "package.json", section = "dependencies"] = String(value).split("|");
  if (!project?.trim() || !manifestPath.trim() || !["dependencies", "devDependencies", "peerDependencies"].includes(section)) {
    throw new Error(`Invalid dependency target: ${value}`);
  }
  const normalizedProject = project.trim().replace(/^\/+|\/+$/gu, "");
  const normalizedManifestPath = manifestPath.trim().replaceAll("\\", "/");
  if (!normalizedProject.split("/").every((segment) => /^[a-z0-9][a-z0-9._-]*$/iu.test(segment))) {
    throw new Error(`Invalid dependency target project: ${project}`);
  }
  if (path.posix.isAbsolute(normalizedManifestPath) || normalizedManifestPath.split("/").some((segment) => segment === "..")) {
    throw new Error(`Invalid dependency target manifest: ${manifestPath}`);
  }
  return { project: normalizedProject, manifestPath: normalizedManifestPath, section };
}

export async function updateExactDependency({ root, manifestPath = "package.json", section, dependency, version }) {
  if (!ALPHA_VERSION_PATTERN.test(version)) throw new Error(`Alpha dependency version is invalid: ${version}`);
  const filePath = path.resolve(root, manifestPath);
  const manifest = JSON.parse(await readFile(filePath, "utf8"));
  if (!manifest[section] || typeof manifest[section][dependency] !== "string") {
    throw new Error(`${manifestPath} does not declare ${dependency} in ${section}.`);
  }
  if (manifest[section][dependency] === version) return false;
  manifest[section][dependency] = version;
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return true;
}

export async function synchronizeAlphaDependencies(options) {
  const targets = options.targets.map((target) => typeof target === "string" ? parseDependencyTarget(target) : target);
  const projects = groupDependencyTargets(targets);
  const results = [];
  for (const [project, projectTargets] of projects) {
    results.push(await synchronizeProject({ ...options, project, targets: projectTargets }));
  }
  return results;
}

export function groupDependencyTargets(targets) {
  const projects = new Map();
  for (const target of targets) {
    const existing = projects.get(target.project) ?? [];
    existing.push(target);
    projects.set(target.project, existing);
  }
  return projects;
}

async function synchronizeProject(options) {
  const runCommand = options.runCommand ?? run;
  const attempts = options.attempts ?? 5;
  const serverUrl = resolveGitLabServerUrl(options.serverUrl);
  const remote = `${serverUrl}/${options.project}.git`;
  const gitEnv = createGitAuthenticationEnv(options.token, options.tokenUsername);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const checkout = await mkdtemp(path.join(os.tmpdir(), "workflow-alpha-dependency-"));
    try {
      await runCommand("git", ["clone", "--branch", "alpha", "--depth", "1", remote, checkout], {
        cwd: process.cwd(),
        env: gitEnv,
      });
      const changedTargets = [];
      for (const target of options.targets) {
        const changed = await updateExactDependency({
          root: checkout,
          manifestPath: target.manifestPath,
          section: target.section,
          dependency: options.dependency,
          version: options.version,
        });
        if (changed) changedTargets.push(target);
      }
      if (changedTargets.length === 0) return { project: options.project, changed: false };

      await prepareTargetWorkspace({ root: checkout, runCommand });
      await runCommand("corepack", ["pnpm", "install", "--lockfile-only", "--ignore-scripts"], {
        cwd: checkout,
        env: { ...process.env, CI: "true" },
      });
      const manifestPaths = [...new Set(changedTargets.map((target) => target.manifestPath))];
      await runCommand("git", ["add", ...manifestPaths, "pnpm-lock.yaml"], { cwd: checkout });
      await runCommand("git", ["config", "user.name", "Workflow Alpha Release"], { cwd: checkout });
      await runCommand("git", ["config", "user.email", "workflow-alpha@localhost"], { cwd: checkout });
      await runCommand("git", ["commit", "-m", options.message], { cwd: checkout });
      await runCommand("git", ["push", ...(options.skipCi ? ["-o", "ci.skip"] : []), "origin", "HEAD:alpha"], {
        cwd: checkout,
        env: gitEnv,
        capture: true,
      });
      return { project: options.project, changed: true, targets: changedTargets };
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !/rejected|fetch first|non-fast-forward|failed to push/u.test(String(error))) throw error;
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  }
  throw lastError;
}

export async function prepareTargetWorkspace({ root, runCommand = run }) {
  for (const scriptPath of ["scripts/prepare-siblings.mjs", "scripts/prepare-shared.mjs"]) {
    try {
      await access(path.join(root, scriptPath));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    await runCommand(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, CI: "true", WORKFLOW_REPOSITORY_MODE: "main" },
    });
    return scriptPath;
  }
  return undefined;
}

export function resolveGitLabServerUrl(value = process.env.CI_SERVER_URL) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("CI_SERVER_URL is required for alpha dependency synchronization.");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("CI_SERVER_URL must be an HTTP(S) URL without credentials.");
  }
  return url.href.replace(/\/$/u, "");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
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

function parseArgs(argv) {
  const result = { targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--skip-ci") {
      result.skipCi = true;
      continue;
    }
    if (["--dependency", "--version", "--target", "--message"].includes(token)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${token} requires a value.`);
      if (token === "--target") result.targets.push(value);
      else result[token.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!result.dependency || !result.version || result.targets.length === 0) {
    throw new Error("Usage: alpha-dependencies.mjs --dependency <name> --version <version> --target <project|manifest|section>.");
  }
  result.message ||= `chore: update ${result.dependency} to ${result.version}`;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await synchronizeAlphaDependencies(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
