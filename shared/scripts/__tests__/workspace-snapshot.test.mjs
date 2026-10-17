import assert from "node:assert/strict";
import test from "node:test";
import { updateWorkspaceAlphaSnapshot } from "../../release-tools/workspace-snapshot.mjs";

test("workspace snapshot captures push failures and retries a non-fast-forward update", async () => {
  let pushAttempts = 0;
  const commitSha = "a".repeat(40);
  const result = await updateWorkspaceAlphaSnapshot({
    workspaceProject: "workflow/workspace",
    submodule: "shared",
    commitSha,
    serverUrl: "http://yuhe.space:7201",
    token: "secret-sync-token",
    skipCi: true,
    attempts: 2,
    runCommand: async (_command, args, options) => {
      if (args.includes("--porcelain")) return "M  shared\n";
      if (args.includes("push")) {
        pushAttempts += 1;
        assert.equal(options.capture, true);
        assert.deepEqual(args.slice(0, 4), ["push", "-o", "ci.skip", "origin"]);
        if (pushAttempts === 1) throw new Error("git push exited 1: non-fast-forward");
      }
      return "";
    },
  });
  assert.equal(pushAttempts, 2);
  assert.deepEqual(result, { changed: true, commitSha });
});
