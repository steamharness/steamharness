import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import express from "express";
import { configureWorkflowAuthContext, requireAuthenticatedPrincipal } from "../../auth";
import type { Storage } from "../../storage";
import { createKanbanPreviewAssetRouter } from "../kanban-preview-assets";

test.afterEach(() => {
  configureWorkflowAuthContext({});
});

test("sandboxed Kanban JS and CSS use preview capability without an App login", async () => {
  const requests: Array<Parameters<Storage["getKanbanAsset"]>[0]> = [];
  const storage = {
    async getKanbanAsset(options) {
      requests.push(options);
      const javascript = options.assetPath.endsWith(".js");
      const content = Buffer.from(javascript ? "export const board = true;" : "body { color: black; }");
      return {
        content,
        contentType: javascript ? "application/javascript; charset=utf-8" : "text/css; charset=utf-8",
        contentLength: content.byteLength,
        contentSecurityPolicy: "default-src 'self'; connect-src 'self' data: blob:",
      };
    },
  } as Storage;
  const server = await listen(storage);

  try {
    const paths = ["assets/index.js", "assets/index.css"];
    for (const assetPath of paths) {
      const response = await fetch(server.url(
        `/api/projects/demo/kanban/previews/preview-capability/preview-nonce/1.0.0/${assetPath}`,
      ), {
        headers: { Origin: "null" },
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }

    assert.deepEqual(requests, paths.map((assetPath) => ({
      projectName: "demo",
      target: "1.0.0",
      previewCapabilityToken: "preview-capability",
      assetPath,
      nonce: "preview-nonce",
    })));

    const protectedResponse = await fetch(server.url("/api/projects/demo/kanban"), {
      headers: { Origin: "null" },
    });
    assert.equal(protectedResponse.status, 401);
    assert.deepEqual(await protectedResponse.json(), { errCode: 401, errMessage: "Unauthorized." });
  } finally {
    await server.close();
  }
});

test("production mounts preview capabilities before authenticated API routes", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../../index.ts"), "utf8");
  const capabilityRouter = source.indexOf('app.use("/api", createKanbanPreviewAssetRouter(storage));');
  const apiAuthentication = source.indexOf('app.use("/api", createApiRouter(storage));');

  assert.notEqual(capabilityRouter, -1);
  assert.notEqual(apiAuthentication, -1);
  assert.ok(capabilityRouter < apiAuthentication);
});

async function listen(storage: Storage): Promise<{
  close: () => Promise<void>;
  url: (pathname: string) => string;
}> {
  configureWorkflowAuthContext({});
  const app = express();
  // Keep this order aligned with the production entrypoint regression above.
  app.use("/api", createKanbanPreviewAssetRouter(storage));
  app.get("/api/projects/demo/kanban", requireAuthenticatedPrincipal(), (_req, res) => {
    res.json({ errCode: 0, errMessage: "", data: {} });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    url: (pathname) => `http://127.0.0.1:${address.port}${pathname}`,
  };
}
