import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUILTIN_PROJECTS,
  VENDOR_CONSUMERS,
  checkVendorCopies,
  checkVendorExtras,
  formatVendorCopyDrift,
  hashContent,
  syncVendorCopies,
} from "../check-vendor-copies.mjs";

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vendor-copies-"));
  const shared = path.join(root, "shared/release-tools");
  await mkdir(shared, { recursive: true });
  await writeFile(path.join(shared, "release-gate.mjs"), "export const gate = 1;\n");
  await writeFile(path.join(shared, "release-notes.mjs"), "export const notes = 1;\n");
  await writeFile(path.join(shared, "npm-alpha-publish.mjs"), "export const publish = 1;\n");
  // 嵌套文件：曾经的枚举只返回文件名，导致 resources/ 这类路径从未被比较过。
  await mkdir(path.join(shared, "resources"), { recursive: true });
  await writeFile(path.join(shared, "resources", "labels.ts"), "export const labels = 1;\n");
  await mkdir(path.join(shared, "__tests__"), { recursive: true });
  await writeFile(path.join(shared, "__tests__", "gate.test.mjs"), "// not vendored\n");
  for (const consumer of VENDOR_CONSUMERS) {
    const directory = path.join(root, consumer, "vendor/shared/release-tools");
    await mkdir(directory, { recursive: true });
    for (const file of ["release-gate.mjs", "release-notes.mjs", "npm-alpha-publish.mjs"]) {
      await writeFile(path.join(directory, file), await readFile(path.join(shared, file), "utf8"), "utf8");
    }
    await mkdir(path.join(directory, "resources"), { recursive: true });
    await writeFile(path.join(directory, "resources", "labels.ts"), await readFile(path.join(shared, "resources", "labels.ts"), "utf8"), "utf8");
  }
  for (const project of BUILTIN_PROJECTS) {
    const directory = path.join(root, project, "scripts/__tests__");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, project, "scripts/release-gate.mjs"), "export const gate = 1;\n");
    await writeFile(path.join(root, project, "scripts/release-notes.mjs"), "export const notes = 1;\n");
    await writeFile(path.join(root, project, "scripts/prepare-local-siblings.mjs"), "export const prepare = 1;\n");
    await writeFile(path.join(root, project, "scripts/prepare-release.mjs"), "export const prepare = 1;\n");
    await writeFile(path.join(directory, "prepare-local-siblings.test.mjs"), "// test\n");
    await writeFile(path.join(root, project, "scripts/builtin-release.mjs"), "export const release = 1;\n");
  }
  return root;
}

test("hashContent normalises line endings and trailing newlines", () => {
  assert.equal(hashContent("a\nb\n"), hashContent("a\r\nb\r\n"));
  assert.notEqual(hashContent("a\nb\n"), hashContent("a\nc\n"));
});

test("an in-sync tree reports no drift", async () => {
  const root = await createFixture();
  try {
    const { drift } = await checkVendorCopies(root);
    assert.deepEqual(drift, []);
    assert.deepEqual(await checkVendorExtras(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local builds and coverage reports never enter vendor copies", async () => {
  const root = await createFixture();
  try {
    for (const directory of ["dist", "coverage", ".release"]) {
      await mkdir(path.join(root, "shared", directory), { recursive: true });
      await writeFile(path.join(root, "shared", directory, "generated.html"), "local artifact\n");
    }
    const { drift, copies } = await checkVendorCopies(root);
    assert.deepEqual(drift, []);
    assert.ok(copies.every(copy => !/vendor\/shared\/(?:dist|coverage|\.release)\//u.test(copy.copy)));
    assert.deepEqual(await syncVendorCopies(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("drift is reported per copy and file", async () => {
  const root = await createFixture();
  try {
    await writeFile(
      path.join(root, "build-in/build-in-analysis/scripts/release-gate.mjs"),
      "export const gate = 2;\n",
    );
    const { drift, copies } = await checkVendorCopies(root);
    assert.deepEqual(drift, [{
      copy: "build-in/build-in-analysis/scripts/release-gate.mjs",
      source: "shared/release-tools/release-gate.mjs",
      kind: "different",
    }]);
    const message = formatVendorCopyDrift(drift, copies);
    assert.match(message, /build-in-analysis\/scripts\/release-gate\.mjs is different/u);
    assert.match(message, /check-vendor-copies\.mjs --fix/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested source files are compared, and tests stay out of the mirror", async () => {
  const root = await createFixture();
  try {
    const { drift, copies } = await checkVendorCopies(root);
    assert.deepEqual(drift, []);
    assert.ok(copies.some((copy) => copy.copy === "harness/vendor/shared/release-tools/resources/labels.ts"));
    assert.ok(!copies.some((copy) => copy.copy.startsWith("harness/vendor/") && copy.copy.includes("__tests__")));

    await writeFile(path.join(root, "harness/vendor/shared/release-tools/resources/labels.ts"), "stale\n", "utf8");
    const afterEdit = await checkVendorCopies(root);
    assert.deepEqual(afterEdit.drift.map((entry) => entry.copy),
      ["harness/vendor/shared/release-tools/resources/labels.ts"]);
    assert.equal(afterEdit.drift[0].kind, "different");

    await syncVendorCopies(root);
    assert.deepEqual((await checkVendorCopies(root)).drift, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a shared source that disappears is reported instead of skipped", async () => {
  const root = await createFixture();
  try {
    await rm(path.join(root, "shared/release-tools/release-gate.mjs"));
    const { drift } = await checkVendorCopies(root);
    assert.ok(drift.some((entry) => entry.kind === "source-missing"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vendored copies drift against shared like any other consumer", async () => {
  const root = await createFixture();
  try {
    await writeFile(path.join(root, "cli/vendor/shared/release-tools/release-gate.mjs"), "export const gate = 2;\n");
    const { drift } = await checkVendorCopies(root);
    assert.deepEqual(drift.map((entry) => [entry.copy, entry.kind]), [
      ["cli/vendor/shared/release-tools/release-gate.mjs", "different"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a vendored file without a shared source is reported as an extra", async () => {
  const root = await createFixture();
  try {
    await writeFile(path.join(root, "server/vendor/shared/release-tools/stray.mjs"), "// stray\n");
    assert.deepEqual(await checkVendorExtras(root), ["server/vendor/shared/release-tools/stray.mjs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--fix rewrites every copy from its source", async () => {
  const root = await createFixture();
  try {
    await writeFile(path.join(root, "build-in/build-in-analysis/scripts/release-gate.mjs"), "export const gate = 2;\n");
    await writeFile(
      path.join(root, "build-in/build-in-developer-assistant/scripts/prepare-local-siblings.mjs"),
      "export const prepare = 2;\n",
    );
    await rm(path.join(root, "harness/vendor/shared/release-tools/release-notes.mjs"));

    await syncVendorCopies(root);

    const { drift } = await checkVendorCopies(root);
    assert.deepEqual(drift, []);
    assert.equal(
      await readFile(path.join(root, "build-in/build-in-analysis/scripts/release-gate.mjs"), "utf8"),
      "export const gate = 1;\n",
    );
    assert.equal(
      await readFile(path.join(root, "harness/vendor/shared/release-tools/release-notes.mjs"), "utf8"),
      "export const notes = 1;\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files without a shared source are never touched by the guard", async () => {
  const root = await createFixture();
  try {
    await writeFile(path.join(root, "build-in/build-in-developer-assistant/scripts/builtin-release.mjs"), "export const release = 9;\n");
    await syncVendorCopies(root);
    assert.equal(
      await readFile(path.join(root, "build-in/build-in-developer-assistant/scripts/builtin-release.mjs"), "utf8"),
      "export const release = 9;\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
