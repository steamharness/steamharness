import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SKILL_COPY_ROOTS,
  SKILL_RELATIVE_PATH,
  checkSkillCopies,
  compareSkillCopies,
  formatSkillCopyDrift,
  syncSkillCopies,
} from "../check-skill-copies.mjs";

function copyDirectory(root, copyRoot) {
  return path.join(root, copyRoot, SKILL_RELATIVE_PATH);
}

async function writeSharedCopy(root, copyRoot, files) {
  const directory = copyDirectory(root, copyRoot);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

async function createMonorepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-copies-"));
  const shared = {
    "SKILL.md": "shared skill\n",
    "references/harness-api.md": "shared api reference\n",
    "scripts/create_workflow.py": "print('shared')\n",
    "assets/kanban/default/index.html": "<html></html>\n",
  };
  await writeSharedCopy(root, SKILL_COPY_ROOTS.source, shared);
  for (const target of SKILL_COPY_ROOTS.targets) await writeSharedCopy(root, target, shared);
  return { root, shared };
}

test("identical copies report no differences", async () => {
  const { root } = await createMonorepo();
  try {
    const result = await checkSkillCopies({ root });
    assert.deepEqual(formatSkillCopyDrift(result), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects missing, modified and stale shared files per copy", async () => {
  const { root } = await createMonorepo();
  const copyDirectoryPath = copyDirectory(root, SKILL_COPY_ROOTS.targets[0]);
  try {
    await rm(path.join(copyDirectoryPath, "scripts", "create_workflow.py"));
    await writeFile(path.join(copyDirectoryPath, "SKILL.md"), "stale skill\n", "utf8");
    // 共享目录里的多余文件同样要报出来；references/ 下允许各仓库自有文档，不做该检查。
    await writeFile(path.join(copyDirectoryPath, "assets", "kanban", "legacy.html"), "obsolete\n", "utf8");

    const result = await checkSkillCopies({ root });
    const drift = formatSkillCopyDrift(result);
    assert.ok(drift.includes(`${SKILL_COPY_ROOTS.targets[0]}: scripts/create_workflow.py is missing`));
    assert.ok(drift.includes(`${SKILL_COPY_ROOTS.targets[0]}: SKILL.md is different`));
    assert.ok(drift.includes(`${SKILL_COPY_ROOTS.targets[0]}: assets/kanban/legacy.html is extra`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sync mirrors the shared payload and leaves repository-specific files alone", async () => {
  const { root } = await createMonorepo();
  const copyDirectoryPath = copyDirectory(root, SKILL_COPY_ROOTS.targets[0]);
  try {
    await writeFile(path.join(copyDirectoryPath, "SKILL.md"), "stale skill\n", "utf8");
    await writeFile(path.join(copyDirectoryPath, "AGENTS.md"), "harness specific rules\n", "utf8");
    await writeFile(path.join(copyDirectoryPath, "references", "project-repair.md"), "harness specific\n", "utf8");

    await syncSkillCopies({ root });

    assert.equal(await readFile(path.join(copyDirectoryPath, "SKILL.md"), "utf8"), "shared skill\n");
    assert.equal(
      await readFile(path.join(copyDirectoryPath, "references", "harness-api.md"), "utf8"),
      "shared api reference\n",
    );
    // 仓库特有文件不属于共享载荷，必须原样保留。
    assert.equal(await readFile(path.join(copyDirectoryPath, "AGENTS.md"), "utf8"), "harness specific rules\n");
    assert.equal(
      await readFile(path.join(copyDirectoryPath, "references", "project-repair.md"), "utf8"),
      "harness specific\n",
    );
    const drift = formatSkillCopyDrift(await checkSkillCopies({ root }));
    assert.deepEqual(drift, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new shared file reaches every copy without being listed anywhere", async () => {
  // The failure this guards: a reference added at the source stays there
  // because a hand-kept allowlist did not know it, and the runtime that ships
  // the other copy cannot open a file it never received.
  const { root } = await createMonorepo();
  const sourceDirectory = copyDirectory(root, SKILL_COPY_ROOTS.source);
  try {
    await writeFile(path.join(sourceDirectory, "references", "runtime-api-index.md"), "generated index\n", "utf8");

    await syncSkillCopies({ root });

    for (const target of SKILL_COPY_ROOTS.targets) {
      assert.equal(
        await readFile(path.join(copyDirectory(root, target), "references", "runtime-api-index.md"), "utf8"),
        "generated index\n",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sync drops a copy of a file the source no longer has", async () => {
  const { root } = await createMonorepo();
  const copyDirectoryPath = copyDirectory(root, SKILL_COPY_ROOTS.targets[0]);
  try {
    await writeFile(path.join(copyDirectoryPath, "references", "retired.md"), "gone upstream\n", "utf8");

    await syncSkillCopies({ root });

    await assert.rejects(() => readFile(path.join(copyDirectoryPath, "references", "retired.md"), "utf8"));
    assert.deepEqual(formatSkillCopyDrift(await checkSkillCopies({ root })), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compareSkillCopies reports content differences by hash", () => {
  const differences = compareSkillCopies(
    new Map([["SKILL.md", Buffer.from("a")], ["extra.md", Buffer.from("b")]]),
    new Map([["SKILL.md", Buffer.from("c")], ["legacy.md", Buffer.from("d")]]),
  );
  assert.deepEqual(differences, [
    { path: "extra.md", kind: "missing" },
    { path: "legacy.md", kind: "extra" },
    { path: "SKILL.md", kind: "different" },
  ]);
});
