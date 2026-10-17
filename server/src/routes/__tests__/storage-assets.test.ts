import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { WorkflowLocalStorage, isWorkflowLocalStorage } from "../../local-storage";
import { fail, toHttpError } from "../../protocol";
import { createStorageAssetRouter } from "../storage-assets";

const USER_ID = "3f2a1b4c-0000-4000-8000-000000000001";
const AVATAR_HASH = "a".repeat(64);

async function withServer<T>(
  run: (request: (pathname: string) => Promise<Response>, root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-storage-assets-"));
  const objectStorage = new WorkflowLocalStorage({ root, publicBaseUrl: "https://storage.example.com/" });

  const app = express();
  app.use("/storage", createStorageAssetRouter(objectStorage));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const httpError = toHttpError(error);
    res.status(httpError.statusCode).json(fail(httpError.errCode, httpError.message));
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address() as AddressInfo;
    return await run(
      (pathname) => fetch(`http://127.0.0.1:${address.port}${pathname}`),
      root,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

test("storage asset route serves immutable local avatars", async () => {
  await withServer(async (request, root) => {
    const body = Buffer.from("RIFF0000WEBPavatar", "ascii");
    const avatarDirectory = path.join(root, "storage", "avatars", USER_ID);
    await mkdir(avatarDirectory, { recursive: true });
    await writeFile(path.join(avatarDirectory, `${AVATAR_HASH}.webp`), body);

    const response = await request(`/storage/avatars/${USER_ID}/${AVATAR_HASH}.webp`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("content-length"), String(body.byteLength));
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("etag"), `"${AVATAR_HASH}"`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  });
});

test("storage asset route rejects malformed and missing avatars", async () => {
  await withServer(async (request, root) => {
    const avatarDirectory = path.join(root, "storage", "avatars", USER_ID);
    await mkdir(avatarDirectory, { recursive: true });
    await writeFile(path.join(avatarDirectory, `${AVATAR_HASH}.png`), "png");

    for (const pathname of [
      // Percent-encoded traversal is decoded after routing, so the param pattern is
      // the only thing standing between it and the filesystem.
      `/storage/avatars/%2e%2e%2f%2e%2e/${AVATAR_HASH}.png`,
      `/storage/avatars/${USER_ID}/..`,
      `/storage/avatars/${USER_ID}/${AVATAR_HASH}`,
      `/storage/avatars/${USER_ID}/${"a".repeat(63)}.png`,
      `/storage/avatars/${USER_ID}/${AVATAR_HASH}.svg`,
      `/storage/avatars/user-1/${AVATAR_HASH}.png`,
      `/storage/avatars/${USER_ID}/${"b".repeat(64)}.png`,
    ]) {
      const response = await request(pathname);
      assert.equal(response.status, 404, `expected 404 for ${pathname}`);
    }
  });
});

test("storage asset route cannot serve private objects", async () => {
  await withServer(async (request, root) => {
    // Objects that live in the same tree but must stay behind their own gates:
    // version artifacts and runner artifacts are capability-checked elsewhere.
    const privatePaths = [
      path.join(root, "storage", "workflows", "demo", "1.0.0", "hash", "source.tar.gz"),
      path.join(root, "storage", "runner-artifacts", "sha256", "c".repeat(64)),
    ];
    for (const privatePath of privatePaths) {
      await mkdir(path.dirname(privatePath), { recursive: true });
      await writeFile(privatePath, "private");
    }

    for (const pathname of [
      `/storage/workflows/demo/1.0.0/hash/source.tar.gz`,
      `/storage/runner-artifacts/sha256/${"c".repeat(64)}`,
      `/storage/avatars/workflows/1.0.0/source.tar.gz`,
    ]) {
      const response = await request(pathname);
      assert.equal(response.status, 404, `expected 404 for ${pathname}`);
    }
  });
});

test("storage asset router only mounts for local object storage", () => {
  assert.equal(isWorkflowLocalStorage(new WorkflowLocalStorage({
    root: path.join(tmpdir(), "workflow-storage-assets-gate"),
    publicBaseUrl: "https://storage.example.com/",
  })), true);
});
