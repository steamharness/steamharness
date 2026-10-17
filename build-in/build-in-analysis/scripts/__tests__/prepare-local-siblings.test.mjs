import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareLocalSiblings,
  readLocalSiblingNames,
  readPinnedSiblings,
  resolveReleaseTag,
  resolveRepositoryPrefix,
  resolveSiblingBranch,
  resolveSiblingWorkspaceRoot,
} from "../prepare-local-siblings.mjs";

const created = [];

async function createWorkspace(manifest, repositoryDirectory = "build-in-project") {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "local-siblings-"));
  created.push(workspace);
  const projectRoot = path.join(workspace, repositoryDirectory);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify(manifest), "utf8");
  return { workspace, projectRoot };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local sibling preparation", () => {
  it("reads only the relative sibling references", () => {
    expect(readLocalSiblingNames({
      devDependencies: {
        "workflow-code": "link:../core",
        "@workflow-code/cli": "file:../cli",
        vitest: "^4.1.7",
      },
      dependencies: { "@opencode-ai/sdk": "1.18.3" },
    })).toEqual(["cli", "core"]);
    expect(readLocalSiblingNames({ devDependencies: { "workflow-code": "0.2.4-20260921001" } })).toEqual([]);
  });

  it("derives the clone prefix from CI_REPOSITORY_URL", () => {
    expect(resolveRepositoryPrefix({})).toBeUndefined();
    expect(resolveRepositoryPrefix({
      CI_REPOSITORY_URL: "http://gitlab-ci-token:old@yuhe.space:7201/workflow/build-in-opencode.git",
      CI_JOB_TOKEN: "fresh",
    })).toBe("http://gitlab-ci-token:fresh@yuhe.space:7201/workflow");
    expect(resolveRepositoryPrefix({
      CI_REPOSITORY_URL: "https://yuhe.space/workflow/build-in-opencode.git",
      CI_JOB_TOKEN: "fresh",
    })).toBe("https://gitlab-ci-token:fresh@yuhe.space/workflow");
  });

  it("resolves nested local references and pinned aggregate checkouts", async () => {
    const manifest = { devDependencies: { "workflow-code": "link:../../core", "@workflow-code/cli": "file:../../cli" } };
    const { workspace, projectRoot } = await createWorkspace(manifest, "build-in/build-in-project");
    expect(readLocalSiblingNames(manifest)).toEqual(["cli", "core"]);
    expect(resolveSiblingWorkspaceRoot(projectRoot, manifest)).toBe(workspace);
    expect(resolveSiblingWorkspaceRoot(projectRoot, { devDependencies: { "workflow-code": "0.2.4" } })).toBe(workspace);
    expect(() => resolveSiblingWorkspaceRoot(projectRoot, {
      devDependencies: { "workflow-code": "link:../../core", "@workflow-code/cli": "link:../cli" },
    })).toThrow(/share one workspace root/);
  });

  it("clones nested dependencies at the declared paths in a standalone CI checkout", async () => {
    const { workspace, projectRoot } = await createWorkspace({
      devDependencies: { "workflow-code": "link:../../core", "@workflow-code/cli": "link:../../cli" },
    }, "checkouts/build-in-project");
    const calls = [];
    const { prepared } = prepareLocalSiblings({
      root: projectRoot,
      env: { CI_REPOSITORY_URL: "https://git.example/workflow/build-in-project.git", CI_COMMIT_BRANCH: "codex/studio-integration" },
      log: () => {},
      run: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (command !== "git") return;
        const target = args.at(-1);
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, "package.json"), JSON.stringify({ scripts: {} }));
      },
    });
    expect(prepared.map(entry => entry.target)).toEqual([path.join(workspace, "cli"), path.join(workspace, "core")]);
    expect(calls.filter(call => call.command === "git").map(call => call.cwd)).toEqual([workspace, workspace]);
  });

  it("checks siblings out at the branch the pipeline is building", () => {
    expect(resolveSiblingBranch({})).toBe("dev");
    expect(resolveSiblingBranch({ CI_COMMIT_BRANCH: "codex/pi-agent" })).toBe("codex/pi-agent");
    expect(resolveSiblingBranch({ CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "dev" })).toBe("dev");
    expect(resolveSiblingBranch({ WORKFLOW_SIBLING_BRANCH: "alpha", CI_COMMIT_BRANCH: "dev" })).toBe("alpha");
  });

  it("checks a pinned sibling out at its release tag, without installing or building it", async () => {
    const { workspace, projectRoot } = await createWorkspace({
      devDependencies: { "workflow-code": "0.2.4-20260922010", "@workflow-code/cli": "0.2.4-20260922002" },
    });
    const calls = [];
    const run = (command, args, options) => {
      calls.push([command, ...args]);
      if (command === "git" && args[0] === "ls-remote") {
        const tag = String(args.at(-1));
        return { status: tag.endsWith("alpha/v0.2.4-20260922010") || tag.endsWith("alpha/v0.2.4-20260922002") ? 0 : 2, stdout: "" };
      }
      if (command === "git" && args[0] === "clone") {
        // The clone would land in `../<name>`; create the manifest the script reads next.
        const target = args.at(-1);
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "sibling", scripts: {} }));
      }
      return { status: 0, stdout: "" };
    };

    const { prepared } = prepareLocalSiblings({
      root: projectRoot,
      env: { CI_REPOSITORY_URL: "https://git.example/workflow/build-in-developer-assistant.git", CI_JOB_TOKEN: "token" },
      run,
      log: () => {},
    });

    // The sources are what the generated index and the tool contract read; the
    // dependency a project installs is still the published package.
    expect(prepared.map((entry) => `${entry.name}:${entry.tag}`)).toEqual([
      "cli:alpha/v0.2.4-20260922002",
      "core:alpha/v0.2.4-20260922010",
    ]);
    expect(calls.filter((call) => call[0] === "pnpm")).toEqual([]);
    expect(calls.filter((call) => call[0] === "git" && call[1] === "clone").map((call) => call.at(call.indexOf("--branch") + 1)))
      .toEqual(["alpha/v0.2.4-20260922002", "alpha/v0.2.4-20260922010"]);
    expect(existsSync(path.join(workspace, "core", "package.json"))).toBe(true);
  });

  it("reads only exact versions as pinned siblings", () => {
    expect(readPinnedSiblings({
      devDependencies: {
        "workflow-code": "0.2.4-20260922010",
        "@workflow-code/cli": "^0.2.4",
        vitest: "^4.1.7",
      },
    })).toEqual([{ name: "core", version: "0.2.4-20260922010" }]);
    expect(readPinnedSiblings({ devDependencies: { "workflow-code": "link:../core" } })).toEqual([]);
  });

  it("prefers the channel tag that exists and says so when none does", () => {
    const seen = [];
    const log = [];
    const probe = (status) => (_command, args) => {
      seen.push(String(args.at(-1)));
      return { status, stdout: "" };
    };

    expect(resolveReleaseTag("0.2.4-20260922010", {
      sibling: "core",
      repositoryPrefix: "https://git.example/workflow",
      env: {},
      cwd: "/tmp",
      run: probe(2),
      log: (message) => log.push(message),
    })).toBeUndefined();
    expect(log.join(" ")).toMatch(/no release tag found for core/);
    // Every candidate was tried before giving up: a hand-published version has
    // no tag, and guessing one would check out a different commit.
    expect(seen).toEqual([
      "refs/tags/alpha/v0.2.4-20260922010",
      "refs/tags/dev/v0.2.4-20260922010",
      "refs/tags/v0.2.4-20260922010",
    ]);
  });

  it("refreshes an existing sibling in CI and leaves it alone locally", async () => {
    const { workspace, projectRoot } = await createWorkspace({
      devDependencies: { "workflow-code": "link:../core" },
    });
    // On a shell runner `../core` is the Core project's own build directory, so
    // whatever is there belongs to Core's last job — never assumed usable.
    await mkdir(path.join(workspace, "core"), { recursive: true });
    await writeFile(path.join(workspace, "core", "package.json"), JSON.stringify({
      name: "workflow-code",
      version: "0.0.0-stale",
      scripts: {},
    }), "utf8");

    const localCalls = [];
    const local = prepareLocalSiblings({
      root: projectRoot,
      env: {},
      run: (...args) => localCalls.push(args),
      log: () => {},
    });
    expect(local.prepared).toEqual([]);
    expect(localCalls).toEqual([]);

    const ciCalls = [];
    prepareLocalSiblings({
      root: projectRoot,
      env: { CI_REPOSITORY_URL: "http://yuhe.space:7201/workflow/build-in-project.git", CI_JOB_TOKEN: "t" },
      log: () => {},
      run: (command, args) => {
        ciCalls.push(`${command} ${args[0]}`);
        if (command !== "git") return;
        const target = args.at(-1);
        mkdirSync(path.join(target, "dist"), { recursive: true });
        writeFileSync(path.join(target, "package.json"), JSON.stringify({
          name: "workflow-code",
          version: "0.2.4",
          scripts: { bootstrap: "node scripts/bootstrap.mjs", build: "node scripts/build.mjs" },
        }));
      },
    });
    expect(ciCalls).toEqual(["git clone", "pnpm bootstrap", "pnpm build"]);
    // The stale checkout was replaced, not reused.
    const refreshed = JSON.parse(await readFile(path.join(workspace, "core", "package.json"), "utf8"));
    expect(refreshed.version).toBe("0.2.4");
  });

  it("clones, installs and builds each missing sibling", async () => {
    const { projectRoot } = await createWorkspace({
      devDependencies: { "workflow-code": "link:../core", "@workflow-code/cli": "link:../cli" },
    });

    const calls = [];
    const prepared = prepareLocalSiblings({
      root: projectRoot,
      env: {
        CI_REPOSITORY_URL: "http://yuhe.space:7201/workflow/build-in-project.git",
        CI_JOB_TOKEN: "t",
        CI_COMMIT_BRANCH: "codex/pi-agent",
      },
      log: () => {},
      run: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        // The clone is simulated by materialising the sibling's manifest. It
        // has to be synchronous: the script reads it right after cloning.
        if (command !== "git") return;
        const target = args.at(-1);
        mkdirSync(path.join(target, "dist"), { recursive: true });
        writeFileSync(path.join(target, "package.json"), JSON.stringify({
          name: target.endsWith("core") ? "workflow-code" : "@workflow-code/cli",
          // Only Core declares a build: its `dist/*.d.ts` is what the built-in
          // project's typecheck resolves against.
          scripts: target.endsWith("core")
            ? { bootstrap: "node scripts/bootstrap.mjs", build: "node scripts/build.mjs" }
            : { bootstrap: "node scripts/bootstrap.mjs" },
        }));
      },
    });

    expect(calls.map((call) => `${call.command} ${call.args.slice(0, 2).join(" ")}`)).toEqual([
      "git clone --quiet",
      "pnpm bootstrap",
      "git clone --quiet",
      "pnpm bootstrap",
      "pnpm build",
    ]);
    const clones = calls.filter((call) => call.command === "git");
    for (const clone of clones) {
      expect(clone.args[5]).toBe("codex/pi-agent");
      expect(clone.cwd).toBe(path.dirname(projectRoot));
    }
    // `readLocalSiblingNames` sorts, so the clones follow that order.
    expect(clones.map((clone) => path.basename(clone.args.at(-1)))).toEqual(["cli", "core"]);
    // A sibling that declares a build is always rebuilt: a stale `dist` would
    // typecheck the project against types that no longer match Core's source.
    const builds = calls.filter((call) => call.command === "pnpm" && call.args[0] === "build");
    expect(builds.map((call) => path.basename(call.cwd))).toEqual(["core"]);
    expect(prepared.prepared.map((entry) => entry.name)).toEqual(["cli", "core"]);
  });
});
