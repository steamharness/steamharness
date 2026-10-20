import assert from "node:assert/strict";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRemoteProjectFileStoreFromEnv,
  createServerProjectFileStore,
  createProjectFileStore,
  createFileInputNode,
  createProjectKVContext,
  createLocalProjectKVStore,
  createProjectRelatedProjectsContext,
  createDisabledProjectConversationContext,
  createDisabledProjectTokenUsageContext,
  parseProjectFileReferences,
  RemoteProjectFileStore,
} from "../index";

test("video paths and managed references retain MIME type and bytes through file storage", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-video-files-"));
  try {
    const store = createProjectFileStore({});
    const kv = createProjectKVContext({ store: createLocalProjectKVStore({ rootDir }), projectId: "media-test" });
    const storage = { kv, persistentValue: kv, relatedProjects: createProjectRelatedProjectsContext() };
    const context = {
      files: store, config: {}, providers: {}, storage: { local: storage, server: storage },
      conversation: createDisabledProjectConversationContext(), tokenUsage: createDisabledProjectTokenUsageContext(),
    };
    const node = createFileInputNode({ accept: ["image/*", "video/*"] });
    for (const [extension, mimeType] of Object.entries({
      MP4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", avi: "video/x-msvideo",
      mkv: "video/x-matroska", webm: "video/webm", ogv: "video/ogg", mpg: "video/mpeg", mpeg: "video/mpeg",
    })) {
      const filePath = path.join(rootDir, `clip.${extension}`);
      const bytes = Buffer.from(`video-${extension}`);
      await writeFile(filePath, bytes);
      const [reference] = parseProjectFileReferences(filePath);
      assert.equal(reference!.mimeType, mimeType);
      assert.equal(reference!.kind, "file");
      const [roundTrip] = parseProjectFileReferences(JSON.stringify([reference]));
      assert.deepEqual(JSON.parse(JSON.stringify(roundTrip)), reference);
      const [resolved] = await node.run([roundTrip], context);
      assert.ok(resolved);
      assert.deepEqual(await resolved.readBuffer(), bytes);
      assert.equal(await resolved.readDataUrl(), `data:${mimeType};base64,${bytes.toString("base64")}`);
      await assert.rejects(() => resolved.toLLMImagePart(), /not an image/);
    }

    const serverStore = createServerProjectFileStore({ rootDir: path.join(rootDir, "managed"), projectName: "demo" });
    const audio = await serverStore.createFile!({ name: "recording.webm", mimeType: "audio/webm", buffer: Buffer.from("audio") });
    assert.equal(audio.mimeType, "audio/webm");
    assert.equal((await serverStore.resolveFile(audio)).mimeType, "audio/webm");
    await assert.rejects(() => node.run(audio, { ...context, files: serverStore }), /not accepted/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("server workflow file store writes generated files into the server file namespace", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-created-files-"));
  try {
    const store = createServerProjectFileStore({
      rootDir,
      projectName: "demo",
      conversationId: "thread-1",
    });

    const reference = await store.createFile!({
      name: "../frame.png",
      mimeType: "image/png",
      buffer: Buffer.from("png-bytes"),
      kind: "image",
    });

    assert.match(reference.id, /^wf_[a-f0-9]+$/);
    assert.equal(reference.name, "frame.png");
    assert.equal(reference.mimeType, "image/png");
    assert.equal(reference.kind, "image");
    assert.equal(reference.storage, "server");
    assert.equal(reference.projectId, "demo");
    assert.equal(reference.conversationId, "thread-1");
    assert.equal(reference.url, `/api/projects/files/${encodeURIComponent(reference.id)}`);
    assert.equal(await readFile(path.join(rootDir, reference.id, "content"), "utf8"), "png-bytes");

    const resolved = await store.resolveFile(reference);
    assert.equal(await resolved.readBuffer().then((buffer) => buffer.toString("utf8")), "png-bytes");

    const metadata = JSON.parse(
      await readFile(path.join(rootDir, reference.id, "metadata.json"), "utf8"),
    ) as unknown;
    assert.deepEqual(metadata, JSON.parse(JSON.stringify(reference)));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("workflow file store requires a configured file creator", async () => {
  const store = createProjectFileStore({});

  await assert.rejects(
    () => store.createFile!({ name: "frame.png", buffer: Buffer.from("png") }),
    /requires a configured file store/,
  );
});

test("remote workflow file store uploads generated files through the server file API", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      errCode: 0,
      errMessage: "",
      data: [{
        id: "wf_remote",
        name: "frame.png",
        mimeType: "image/png",
        size: 3,
        kind: "image",
        storage: "server",
        projectId: "demo",
        createdAt: "2026-06-03T00:00:00.000Z",
      }],
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const store = new RemoteProjectFileStore({
      serverUrl: "http://localhost:7125/",
      token: "token",
      projectName: "demo",
      conversationId: "thread-1",
    });

    const reference = await store.createFile({
      name: "frame.png",
      mimeType: "image/png",
      buffer: Buffer.from("png"),
      kind: "image",
    });

    assert.equal(
      calls[0]?.url,
      "http://localhost:7125/api/projects/demo/files?fileName=frame.png&mimeType=image%2Fpng&conversationId=thread-1",
    );
    assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer token");
    assert.equal(reference.url, "/api/projects/files/wf_remote");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote workflow file store from env falls back to saved CLI auth file", async () => {
  const authDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-files-auth-"));
  try {
    await writeFile(
      path.join(authDir, "workflow-auth.json"),
      JSON.stringify({
        serverUrl: "http://localhost:7125",
        apiKey: "saved-api-key",
        source: "device_flow",
      }),
      "utf8",
    );

    const store = createRemoteProjectFileStoreFromEnv({
      env: {
        STEAMHARNESS_CLI_AUTH_DIR: authDir,
      } as NodeJS.ProcessEnv,
      projectName: "demo",
      conversationId: "thread-1",
    });

    assert.ok(store instanceof RemoteProjectFileStore);
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
});

test("remote uploaded files are read with authentication from the managed endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(bytes, { status: 200 });
  }) as typeof fetch;
  try {
    const store = new RemoteProjectFileStore({ serverUrl: "https://server.example/", token: "file-token", projectName: "demo" });
    const reference = {
      id: "wf_abc123", name: "image.png", mimeType: "image/png", size: bytes.length,
      kind: "image" as const, storage: "server" as const, projectId: "demo", createdAt: "2026-10-08T00:00:00Z",
      url: "https://untrusted.example/image.png", path: "/private/file",
    };
    const file = await store.resolveFile(reference);
    assert.deepEqual(await file.readBuffer(), bytes);
    assert.equal(calls[0]?.url, "https://server.example/api/projects/files/wf_abc123");
    assert.deepEqual(calls[0]?.init?.headers, { Authorization: "Bearer file-token" });
    assert.equal(calls[0]?.init?.redirect, "error");
    await assert.rejects(store.resolveFile({ ...reference, projectId: "other-project" }), /another project/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote file read failures do not return an API error document as file bytes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ errCode: 403, errMessage: "File access denied." }), { status: 403 })) as typeof fetch;
  try {
    const store = new RemoteProjectFileStore({ serverUrl: "https://server.example", token: "token", projectName: "demo" });
    const file = await store.resolveFile({
      id: "wf_abc123", name: "image.png", mimeType: "image/png", size: 4,
      kind: "image", storage: "server", projectId: "demo", createdAt: "2026-10-08T00:00:00Z",
    });
    await assert.rejects(file.readBuffer(), /File access denied/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
