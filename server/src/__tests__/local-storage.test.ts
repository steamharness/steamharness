import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isWorkflowStorageNotFoundError } from "../object-storage";
import { WorkflowLocalStorage } from "../local-storage";

const PUBLIC_BASE_URL = "https://storage.example.com/";
const SAMPLE_KEY = "workflows/demo/1.0.0/hash/source.tar.gz";

function createStorage(root: string): WorkflowLocalStorage {
  return new WorkflowLocalStorage({ root, publicBaseUrl: PUBLIC_BASE_URL });
}

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-local-storage-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("local object paths use the documented key contract", () => {
  const storage = createStorage(path.join(os.tmpdir(), "workflow-local-key-parity"));

  // The key layout is part of the backend contract, so an object tree can be
  // rsynced between the two backends without rewriting keys.
  assert.equal(storage.objectKey(SAMPLE_KEY), `storage/${SAMPLE_KEY}`);
  assert.equal(
    storage.publicUrl("avatars/user id/hash.png"),
    "https://storage.example.com/storage/avatars/user%20id/hash.png",
  );
  assert.throws(() => storage.objectKey("../release.json"), /invalid/u);
  assert.throws(() => storage.objectKey("workflows//release.json"), /invalid/u);
  assert.throws(() => storage.objectKey("workflows\\release.json"), /invalid/u);
  assert.throws(() => storage.objectKey(""), /invalid/u);
});

test("local private buffers round-trip under the storage prefix", async () => {
  await withTempRoot(async (root) => {
    const storage = createStorage(root);
    const payload = Buffer.from("archive");

    await storage.uploadPrivateBuffer(SAMPLE_KEY, payload, "application/gzip");
    assert.deepEqual(await storage.downloadPrivateBuffer(SAMPLE_KEY), payload);
    await assert.doesNotReject(storage.assertPrivateObject(SAMPLE_KEY));

    // On-disk layout keeps the storage/ prefix of the object key contract.
    assert.deepEqual(await readFile(path.join(root, "storage", SAMPLE_KEY)), payload);
  });
});

test("local misses produce the shared not-found shape", async () => {
  await withTempRoot(async (root) => {
    const storage = createStorage(root);
    const missingKey = "workflows/demo/missing/source.tar.gz";

    // This predicate gates the 404-vs-500 distinction for artifact reads, so a
    // regression here turns every missing artifact into a server error.
    await assert.rejects(
      storage.downloadPrivateBuffer(missingKey),
      (error: unknown) => {
        assert.equal(isWorkflowStorageNotFoundError(error), true);
        assert.equal((error as { status?: number }).status, 404);
        assert.equal((error as { code?: string }).code, "NoSuchKey");
        assert.match((error as Error).message, /not found/u);
        return true;
      },
    );
    await assert.rejects(
      storage.assertPrivateObject(missingKey),
      (error: unknown) => isWorkflowStorageNotFoundError(error),
    );
  });
});

test("local writes are write-once for content-addressed keys", async () => {
  await withTempRoot(async (root) => {
    const storage = createStorage(root);

    await storage.uploadPrivateBuffer(SAMPLE_KEY, Buffer.from("first"));
    // The key embeds the content hash, so an existing target already holds these
    // bytes: a content-addressed key is written once and never overwritten.
    await assert.doesNotReject(storage.uploadPrivateBuffer(SAMPLE_KEY, Buffer.from("second")));
    assert.equal((await storage.downloadPrivateBuffer(SAMPLE_KEY)).toString(), "first");
  });
});

test("concurrent local writes of one key leave a single intact file", async () => {
  await withTempRoot(async (root) => {
    const storage = createStorage(root);
    const payload = Buffer.from("runtime");

    await Promise.all(Array.from({ length: 8 }, () => storage.uploadPrivateBuffer(SAMPLE_KEY, payload)));

    assert.deepEqual(await storage.downloadPrivateBuffer(SAMPLE_KEY), payload);
    const keyDirectory = path.dirname(path.join(root, "storage", SAMPLE_KEY));
    const entries = await readdir(keyDirectory);
    assert.deepEqual(entries, ["source.tar.gz"]);
  });
});

test("local private files stream both directions with exclusive destinations", async () => {
  await withTempRoot(async (root) => {
    const storage = createStorage(root);
    const sourcePath = path.join(root, "source.tar.gz");
    const targetPath = path.join(root, "nested", "restored.tar.gz");
    await writeFile(sourcePath, "archive", "utf8");

    await storage.uploadPrivateFile(SAMPLE_KEY, sourcePath, "application/gzip");
    await storage.downloadPrivateFile(SAMPLE_KEY, targetPath);
    assert.equal(await readFile(targetPath, "utf8"), "archive");

    // `wx` semantics are what callers rely on when extracting into a fresh dir.
    await assert.rejects(storage.downloadPrivateFile(SAMPLE_KEY, targetPath));

    await assert.rejects(
      storage.downloadPrivateFile("workflows/demo/missing/source.tar.gz", path.join(root, "missing.tar.gz")),
      (error: unknown) => isWorkflowStorageNotFoundError(error),
    );
  });
});

test("local storage cannot mint signed URLs", async () => {
  await withTempRoot(async (root) => {
    const storage = createStorage(root);
    // Undefined is the signal to fall back to the Server's capability-checked
    // artifact endpoint rather than an error.
    assert.equal(storage.privateDownloadUrl("runner-artifacts/sha256/abc"), undefined);
  });
});

test("local public uploads return a URL under the storage prefix", async () => {
  await withTempRoot(async (root) => {
    const storage = createStorage(root);
    const hash = "a".repeat(64);

    const url = await storage.uploadBuffer(`avatars/user-1/${hash}.webp`, Buffer.from("avatar"), "image/webp");

    assert.equal(url, `https://storage.example.com/storage/avatars/user-1/${hash}.webp`);
    assert.equal(await readFile(path.join(root, "storage", "avatars", "user-1", `${hash}.webp`), "utf8"), "avatar");
  });
});

test("local storage rejects paths that escape the root", async () => {
  await withTempRoot(async (root) => {
    const storage = createStorage(root);

    await assert.rejects(storage.downloadPrivateBuffer("../../etc/passwd"), /invalid/u);
    await assert.rejects(storage.uploadPrivateBuffer("workflows/../../escape", Buffer.from("x")), /invalid/u);
    await assert.rejects(storage.resolvePublicAvatar("../../x", `${"a".repeat(64)}.png`), /does not exist/u);
  });
});

test("local avatars resolve only for regular files inside the root", async () => {
  await withTempRoot(async (root) => {
    const storage = createStorage(root);
    // User ids are UUIDs, which is what the avatar URL validator accepts.
    const userId = "3f2a1b4c-0000-4000-8000-000000000001";
    const hash = "b".repeat(64);
    const fileName = `${hash}.webp`;
    const avatarRoot = path.join(root, "storage", "avatars", userId);

    await assert.rejects(storage.resolvePublicAvatar(userId, fileName), /does not exist/u);

    await mkdir(avatarRoot, { recursive: true });
    await writeFile(path.join(avatarRoot, fileName), "avatar", "utf8");

    const asset = await storage.resolvePublicAvatar(userId, fileName);
    assert.equal(asset.size, 6);
    assert.equal(asset.contentType, "image/webp");
    assert.equal(asset.hash, hash);
    assert.equal(await readFile(asset.filePath, "utf8"), "avatar");

    // A directory is not servable, and the route's filename and user-id shapes are
    // enforced here too — they must match what the avatar URL validator accepts.
    await assert.rejects(storage.resolvePublicAvatar(userId, ".."), /does not exist/u);
    await assert.rejects(storage.resolvePublicAvatar("user-1", fileName), /does not exist/u);
    assert.throws(() => storage.objectKey(`avatars/${userId}/..`), /invalid/u);

    // Symlinks are never written by this store, and this is the unauthenticated path.
    const outside = path.join(root, "outside.webp");
    await writeFile(outside, "secret", "utf8");
    const linkedName = `${"c".repeat(64)}.webp`;
    await symlink(outside, path.join(avatarRoot, linkedName));
    await assert.rejects(storage.resolvePublicAvatar(userId, linkedName), /does not exist/u);
  });
});
