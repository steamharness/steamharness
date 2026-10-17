import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import test from "node:test";
import { createPublicSystemAiUnavailableHandler } from "../public-system-ai";

test("public Server reports that system AI is unavailable", async () => {
  const app = express();
  app.use("/api/ai", createPublicSystemAiUnavailableHandler());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${origin}/${["api", "ai", "models"].join("/")}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      errCode: 404,
      errMessage: "System AI is unavailable on the public Server.",
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
