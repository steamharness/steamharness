import assert from "node:assert/strict";
import test from "node:test";
import {
  pruneAlphaReleaseHistory,
  selectAlphaTagsToPrune,
  selectArtifactJobsToErase,
} from "../../release-tools/alpha-retention.mjs";

test("alpha retention keeps the newest three version tags", () => {
  assert.deepEqual(selectAlphaTagsToPrune([
    "0.1.5-20260814003",
    "0.1.5-20260813009",
    "0.1.5-20260814001",
    "0.1.5-20260814002",
    "not-an-alpha",
  ]), ["0.1.5-20260813009"]);
});

test("alpha retention erases only older successful release artifacts", () => {
  const jobs = [
    { id: 10, ref: "alpha", name: "release:alpha", status: "success", artifacts_file: { filename: "10.zip" } },
    { id: 9, ref: "alpha", name: "release:alpha", status: "success", artifacts_file: { filename: "9.zip" } },
    { id: 8, ref: "alpha", name: "release:alpha", status: "success", artifacts_file: { filename: "8.zip" } },
    { id: 7, ref: "alpha", name: "release:alpha", status: "success", artifacts_file: { filename: "7.zip" } },
    { id: 6, ref: "dev", name: "release:alpha", status: "success", artifacts_file: { filename: "6.zip" } },
    { id: 5, ref: "alpha", name: "validate", status: "success", artifacts_file: { filename: "5.zip" } },
  ];
  assert.deepEqual(selectArtifactJobsToErase(jobs, { jobName: "release:alpha", retain: 3 }).map((job) => job.id), [7]);
});

test("alpha retention deletes protected tags through the GitLab API", async () => {
  const requests = [];
  const sha = "a".repeat(40);
  const versions = [
    "0.1.5-20260814004",
    "0.1.5-20260814003",
    "0.1.5-20260814002",
    "0.1.5-20260814001",
  ];
  const result = await pruneAlphaReleaseHistory({
    root: "/tmp/workflow-alpha-retention-test",
    retain: 3,
    token: "private-token",
    projectId: 43,
    apiUrl: "https://gitlab.example/api/v4",
    jobName: "release:alpha",
    runCommand: async (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["ls-remote", "--tags", "origin", "refs/tags/alpha/v*"]);
      return versions.map((version) => `${sha}\trefs/tags/alpha/v${version}`).join("\n");
    },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (options.method === "DELETE") return new Response(null, { status: 204 });
      return new Response("[]", { status: 200 });
    },
  });

  assert.deepEqual(result, {
    retained: 3,
    prunedTags: ["alpha/v0.1.5-20260814001"],
    erasedArtifactJobIds: [],
  });
  assert.equal(
    requests[0].url,
    "https://gitlab.example/api/v4/projects/43/repository/tags/alpha%2Fv0.1.5-20260814001",
  );
  assert.deepEqual(requests[0].options, {
    method: "DELETE",
    headers: { "PRIVATE-TOKEN": "private-token" },
  });
});
