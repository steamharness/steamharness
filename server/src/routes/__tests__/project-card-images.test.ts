import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { fail, toHttpError } from "../../protocol";
import type { WorkflowStorage } from "../../storage";
import { createProjectCardImageRouter } from "../project-card-images";

test("public project card image route serves immutable WebP assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-project-card-route-"));
  const filePath = path.join(root, "image.webp");
  const body = Buffer.from("RIFF0000WEBPproject-card", "ascii");
  const hash = "a".repeat(64);
  await writeFile(filePath, body);

  const app = express();
  app.use("/project-card-images", createProjectCardImageRouter({
    getProjectCardImage: async (workflowId, requestedHash) => {
      assert.equal(workflowId, "00000000-0000-4000-8000-000000000001");
      assert.equal(requestedHash, hash);
      return { filePath, size: body.byteLength, hash };
    },
  } as WorkflowStorage));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const httpError = toHttpError(error);
    res.status(httpError.statusCode).json(fail(httpError.errCode, httpError.message));
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/project-card-images/00000000-0000-4000-8000-000000000001/${hash}.webp`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
