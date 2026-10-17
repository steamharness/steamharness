import assert from "node:assert/strict";
import test from "node:test";
import { decodeEcsKey } from "../ecs-ssh-key.mjs";

test("Docs supports masked Base64 SSH file variables", () => {
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----\n";
  assert.equal(decodeEcsKey(pem), pem);
  assert.equal(decodeEcsKey(Buffer.from(pem).toString("base64")), pem);
  assert.throws(() => decodeEcsKey("invalid"));
});
