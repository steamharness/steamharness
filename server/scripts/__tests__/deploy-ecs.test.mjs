import assert from "node:assert/strict";
import test from "node:test";

import { buildFallbackSshArgs, decodePrivateKey, getEcsComposeSource, getImageFallbackConfig, getImageSaveCommand, normalizeImageFingerprint } from "../deploy-ecs.mjs";

const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nkey-material\n-----END OPENSSH PRIVATE KEY-----";

test("cached local images are exported locally and SSH images from the selected host", () => {
  assert.deepEqual(getImageSaveCommand(true, ["source-host"], "postgres:15-alpine"), { command: "docker", args: ["save", "postgres:15-alpine"] });
  assert.deepEqual(getImageSaveCommand(false, ["source-host"], "postgres:15-alpine"), { command: "ssh", args: ["source-host", "docker save 'postgres:15-alpine'"] });
});

test("ECS SSH key accepts PEM and Base64 file variable contents", () => {
  assert.equal(decodePrivateKey(PEM), `${PEM}\n`);
  assert.equal(decodePrivateKey(Buffer.from(PEM).toString("base64")), `${PEM}\n`);
  assert.throws(() => decodePrivateKey("not-a-key"), /PEM key or Base64-encoded PEM key/u);
});

test("ECS bootstrap uploads Compose files into the configured Compose root", () => {
  assert.equal(getEcsComposeSource("/srv/workflow"), "/srv/workflow/docker/ecs/");
});

test("ECS image fallback can use an explicit CI SSH target", () => {
  assert.deepEqual(buildFallbackSshArgs({
    host: "yuhe.space",
    port: "7200",
    user: "root",
    keyPath: "/tmp/fallback-key",
  }), [
    "-i", "/tmp/fallback-key",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", "7200",
    "root@yuhe.space",
]);
});

test("ECS image fallback compares image config and layers independent of JSON key order", () => {
  const layers = JSON.stringify(["sha256:layer"]);
  const first = `${layers}\n${JSON.stringify({ Cmd: ["postgres"], Env: ["PATH=/usr/bin"] })}`;
  const second = `${layers}\n${JSON.stringify({ Env: ["PATH=/usr/bin"], Cmd: ["postgres"] })}`;
  assert.equal(normalizeImageFingerprint(first), normalizeImageFingerprint(second));
});

test("ECS image fallback reads an explicit source host and credentials", () => {
  assert.deepEqual(getImageFallbackConfig({
    WORKFLOW_IMAGE_FALLBACK_HOST: "yuhe.space",
    WORKFLOW_IMAGE_FALLBACK_PORT: "22",
    WORKFLOW_IMAGE_FALLBACK_USER: "root",
    WORKFLOW_IMAGE_FALLBACK_SSH_KEY: "encoded-key",
  }), {
    host: "yuhe.space",
    port: "22",
    user: "root",
    key: "encoded-key",
  });
});
