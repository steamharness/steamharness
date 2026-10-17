import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertChannelVersion,
  assertNoLocalReference,
  assertPublishedVersion,
  assertVersionAdvance,
  classifyVersionReference,
  findVersionReferences,
  formatReleaseGateDotenv,
  resolveReleaseChannel,
  resolveReleaseMode,
  resolveVersionReference,
  verifyPublisherGate,
  verifyReleaseGate,
} from "../../release-tools/release-gate.mjs";

function manifest(core, cli = core) {
  return { devDependencies: { "steamharness": core, "@steamharness/cli": cli } };
}

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-gate-"));
  await mkdir(path.join(root, "build-in-codex"));
  await mkdir(path.join(root, "core"));
  await writeFile(path.join(root, "build-in-codex", "package.json"), JSON.stringify(manifest("link:../core")));
  await writeFile(path.join(root, "core", "package.json"), JSON.stringify({ name: "steamharness", version: "0.2.4-20260921001" }));
  return root;
}

test("release mode treats main, alpha, tags and the fail-closed override as release", () => {
  assert.equal(resolveReleaseMode({ env: {} }), "dev");
  assert.equal(resolveReleaseMode({ env: { CI_COMMIT_BRANCH: "dev" } }), "dev");
  assert.equal(resolveReleaseMode({ env: { CI_COMMIT_BRANCH: "codex/pi-agent" } }), "dev");
  // alpha publishes; it must not be classified as a development branch.
  assert.equal(resolveReleaseMode({ env: { CI_COMMIT_BRANCH: "alpha" } }), "main");
  assert.equal(resolveReleaseMode({ env: { CI_COMMIT_BRANCH: "main" } }), "main");
  assert.equal(resolveReleaseMode({ env: { CI_COMMIT_TAG: "steamharness/v0.2.4" } }), "main");
  assert.equal(resolveReleaseMode({ env: { STEAMHARNESS_REPOSITORY_MODE: "main" }, branch: "dev" }), "main");
  assert.throws(() => resolveReleaseMode({ env: { STEAMHARNESS_REPOSITORY_MODE: "dev" } }), /fail-closed override/u);
});

test("release channel follows the branch and the feature tag", () => {
  assert.equal(resolveReleaseChannel({ env: { CI_COMMIT_BRANCH: "alpha" } }), "alpha");
  assert.equal(resolveReleaseChannel({ env: { CI_COMMIT_BRANCH: "dev" } }), "dev");
  assert.equal(resolveReleaseChannel({ env: { CI_COMMIT_BRANCH: "main" } }), "latest");
  // Must match feature-release.mjs: tag `feat/v<version>`, dist-tag `feat-<slug>`.
  assert.equal(
    resolveReleaseChannel({ env: { CI_COMMIT_TAG: "feat/v0.2.4-20260920004.codex-pi-agent" } }),
    "feat-codex-pi-agent",
  );
  assert.equal(resolveReleaseChannel({ env: { CI_COMMIT_TAG: "steamharness/v0.2.4" } }), "latest");
});

test("classifyVersionReference separates exact versions from local sibling references", () => {
  assert.deepEqual(classifyVersionReference(manifest("0.2.4-20260921001"), "steamharness"), {
    kind: "exact",
    version: "0.2.4-20260921001",
    specifier: "0.2.4-20260921001",
  });
  for (const specifier of ["link:../core", "file:./core", "link:../../shared"]) {
    const reference = classifyVersionReference(manifest(specifier), "steamharness");
    assert.equal(reference.kind, "local", specifier);
  }
  for (const specifier of ["^0.1.0", ">=0.1.0 <0.2.0", "workspace:*", "v0.1.2", "file:core", "file:/abs/core", ""]) {
    assert.throws(
      () => classifyVersionReference(manifest(specifier), "steamharness"),
      /exact SemVer|relative file|as an exact version/u,
      specifier,
    );
  }
  assert.throws(() => classifyVersionReference({}, "steamharness"), /devDependencies\.steamharness/u);
});

test("dev mode resolves a sibling reference to the sibling's declared version", async () => {
  const root = await createWorkspace();
  try {
    const repoRoot = path.join(root, "build-in-codex");
    const resolved = await resolveVersionReference(manifest("link:../core"), "steamharness", { mode: "dev", repoRoot });
    assert.equal(resolved.version, "0.2.4-20260921001");
    assert.equal(resolved.origin, "sibling");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release mode refuses a sibling reference instead of resolving it", async () => {
  const root = await createWorkspace();
  try {
    const repoRoot = path.join(root, "build-in-codex");
    await assert.rejects(
      resolveVersionReference(manifest("link:../core"), "steamharness", { mode: "main", repoRoot }),
      /must declare an exact published version on main and alpha/u,
    );
    assert.throws(
      () => assertNoLocalReference(manifest("link:../core"), "steamharness", { mode: "main" }),
      /must declare an exact published version on main and alpha/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sibling resolution refuses to escape the workspace root", async () => {
  const root = await createWorkspace();
  try {
    const repoRoot = path.join(root, "build-in-codex");
    for (const relative of ["link:../../etc", "link:../.."]) {
      await assert.rejects(
        resolveVersionReference(manifest(relative), "steamharness", { mode: "dev", repoRoot }),
        /must stay inside the workspace root/u,
        relative,
      );
    }
    // A sibling that is itself a symlink out of the workspace is refused too.
    await symlink(os.tmpdir(), path.join(root, "escaping"));
    await assert.rejects(
      resolveVersionReference(manifest("link:../escaping"), "steamharness", { mode: "dev", repoRoot }),
      /must stay inside the workspace root/u,
    );
    // A sibling whose package.json declares another package is refused.
    await assert.rejects(
      resolveVersionReference(manifest("link:../build-in-codex"), "steamharness", { mode: "dev", repoRoot }),
      /must point at a sibling repository/u,
    );
    await assert.rejects(
      resolveVersionReference(manifest("link:../missing"), "steamharness", { mode: "dev", repoRoot }),
      /does not resolve to an existing sibling repository/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feature-branch versions cannot be pinned on a release channel", () => {
  assert.doesNotThrow(() => assertChannelVersion("steamharness", "0.2.4-20260921001", { channel: "alpha" }));
  assert.throws(
    () => assertChannelVersion("steamharness", "0.2.4-20260920004.codex-pi-agent", { channel: "main" }),
    /feature-branch version/u,
  );
});

test("published-version and version-advance checks read the registry", async () => {
  const published = (outputs) => (args) => {
    const key = args.filter((arg) => !arg.startsWith("-")).join(" ");
    if (!(key in outputs)) throw new Error("E404 No match found for version");
    return outputs[key];
  };

  await assert.doesNotReject(() => assertPublishedVersion("steamharness", "0.2.4-20260921001", {
    runCommand: published({ "view steamharness@0.2.4-20260921001 version": "0.2.4-20260921001\n" }),
    attempts: 1,
  }));
  await assert.rejects(() => assertPublishedVersion("steamharness", "0.2.4-20260921001", {
    runCommand: published({}),
    attempts: 2,
    retryDelayMs: 1,
  }), /is not published/u);

  await assert.rejects(() => assertVersionAdvance("steamharness", "0.2.4-20260920001", {
    runCommand: published({ "view steamharness dist-tags.alpha": "0.2.4-20260921001\n" }),
    distTag: "alpha",
  }), /must be higher than the alpha channel/u);
  await assert.doesNotReject(() => assertVersionAdvance("steamharness", "0.2.5-20260922001", {
    runCommand: published({ "view steamharness dist-tags.alpha": "0.2.4-20260921001\n" }),
    distTag: "alpha",
  }));
  // A channel with nothing published yet cannot be behind.
  await assert.doesNotReject(() => assertVersionAdvance("steamharness", "0.1.0", { runCommand: published({}) }));
});

test("verifyReleaseGate runs every check on a release manifest", async () => {
  // The pinned version is the one the channel currently serves: a promotion
  // pins exactly what it just published, so no version advance is expected of a
  // consumer. Demanding one is what the publisher gate is for.
  const registry = {
    "view steamharness@0.2.5-20260922001 version": "0.2.5-20260922001\n",
    "view steamharness dist-tags.alpha": "0.2.5-20260922001\n",
  };
  const report = await verifyReleaseGate({
    manifest: manifest("0.2.5-20260922001"),
    packageNames: ["steamharness"],
    mode: "main",
    channel: "alpha",
    runCommand: (args) => {
      const key = args.filter((arg) => !arg.startsWith("-")).join(" ");
      if (!(key in registry)) throw new Error("E404 No match found");
      return registry[key];
    },
  });
  assert.deepEqual(report.packages, [{
    packageName: "steamharness",
    section: "devDependencies",
    version: "0.2.5-20260922001",
    checked: true,
  }]);
  assert.equal(
    formatReleaseGateDotenv(report),
    "STEAMHARNESS_RELEASE_GATE_OK=true\nSTEAMHARNESS_RELEASE_GATE_CHANNEL=alpha\nSTEAMHARNESS_RELEASE_GATE_STEAMHARNESS_DEVDEPENDENCIES_VERSION=0.2.5-20260922001\n",
  );
});

test("verifyReleaseGate reads the dependencies a consumer actually declares", async () => {
  const registry = {
    "view steamharness@0.2.4 version": "0.2.4\n",
    "view @steamharness/cli@0.2.4 version": "0.2.4\n",
  };
  const runCommand = (args) => {
    const key = args.filter((arg) => !arg.startsWith("-")).join(" ");
    if (!(key in registry)) throw new Error("E404 No match found");
    return registry[key];
  };

  // Server and Desktop declare Core as a runtime dependency while the CLI stays
  // a dev dependency; both positions have to be checked, not just the default.
  const report = await verifyReleaseGate({
    manifest: {
      dependencies: { "steamharness": "0.2.4" },
      devDependencies: { "@steamharness/cli": "0.2.4" },
    },
    packageNames: ["steamharness", "@steamharness/cli"],
    mode: "main",
    channel: "latest",
    runCommand,
  });
  assert.deepEqual(report.packages.map((entry) => [entry.section, entry.version]), [
    ["dependencies", "0.2.4"],
    ["devDependencies", "0.2.4"],
  ]);

  // Same package in two sections: both are judged, and a release channel
  // refuses the one that carries a sibling reference.
  await assert.rejects(verifyReleaseGate({
    manifest: {
      dependencies: { "steamharness": "0.2.4" },
      devDependencies: { "steamharness": "link:../core" },
    },
    packageNames: ["steamharness"],
    mode: "main",
    channel: "latest",
    runCommand,
  }), /devDependencies\.steamharness must declare an exact published version/u);
  assert.deepEqual(
    findVersionReferences({ dependencies: { "steamharness": "0.2.4" } }, "steamharness").map((entry) => entry.section),
    ["dependencies"],
  );

  // Declaring it nowhere is a failure, not a pass.
  await assert.rejects(verifyReleaseGate({
    manifest: { dependencies: {} },
    packageNames: ["steamharness"],
    mode: "main",
    channel: "latest",
    runCommand,
  }), /must be declared in dependencies or devDependencies/u);
});

test("verifyReleaseGate refuses a feature-branch version before touching the registry", async () => {
  await assert.rejects(
    verifyReleaseGate({
      manifest: manifest("0.2.4-20260920004.codex-pi-agent"),
      mode: "main",
      channel: "latest",
      runCommand: () => {
        throw new Error("the registry must not be queried for a feature version");
      },
    }),
    /feature-branch version/u,
  );
});

test("verifyPublisherGate refuses a republish and requires stable versions to advance", async () => {
  const registry = (outputs) => (args) => {
    const key = args.filter((arg) => !arg.startsWith("-")).join(" ");
    if (!(key in outputs)) throw new Error("E404 No match found");
    return outputs[key];
  };
  const empty = registry({});

  // A fresh version is what a release looks like.
  await assert.doesNotReject(() => verifyPublisherGate({
    manifest: { version: "0.2.5" },
    packageName: "steamharness",
    channel: "latest",
    runCommand: empty,
  }));
  await assert.rejects(() => verifyPublisherGate({
    manifest: { version: "0.2.4" },
    packageName: "steamharness",
    channel: "latest",
    runCommand: registry({ "view steamharness@0.2.4 version": "0.2.4\n" }),
  }), /is already published/u);
  // A stable release must still move `latest` forward.
  await assert.rejects(() => verifyPublisherGate({
    manifest: { version: "0.2.4" },
    packageName: "steamharness",
    channel: "latest",
    runCommand: registry({ "view steamharness dist-tags.latest": "0.2.4\n" }),
  }), /must be higher than the latest channel/u);
  // Dated Alpha and Dev versions are monotonic by construction.
  await assert.doesNotReject(() => verifyPublisherGate({
    manifest: { version: "0.2.4-20260921001" },
    packageName: "steamharness",
    channel: "alpha",
    runCommand: empty,
  }));
  // A dated version already on the registry is a re-run, not a republish: the tag
  // ledger hands out one version per commit, and the publish tool re-verifies the
  // tarball integrity before reusing it. A stable version stays strict.
  await assert.doesNotReject(() => verifyPublisherGate({
    manifest: { version: "0.2.4-20260921001" },
    packageName: "steamharness",
    channel: "alpha",
    runCommand: registry({ "view steamharness@0.2.4-20260921001 version": "0.2.4-20260921001\n" }),
  }));
});

test("verifyReleaseGate reports a local reference as unchecked on dev", async () => {
  const report = await verifyReleaseGate({
    manifest: manifest("link:../core"),
    packageNames: ["steamharness"],
    mode: "dev",
    channel: "dev",
    runCommand: () => {
      throw new Error("the registry must not be queried for a local reference");
    },
  });
  assert.deepEqual(report.packages, [{
    packageName: "steamharness",
    section: "devDependencies",
    version: undefined,
    checked: false,
  }]);
});
