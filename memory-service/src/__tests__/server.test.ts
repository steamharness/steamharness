import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryHttpServer } from "../server.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("HTTP chunks may split a Chinese UTF-8 character without corrupting persisted memory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-http-"));
  const token = "test-only-internal-credential-32-characters";
  const server = createMemoryHttpServer({ root, token, automatic: false });
  const firstChunk = deferred<void>();
  server.on("request", req => req.once("data", () => firstChunk.resolve()));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const content = "用户希望使用中文交流 😀";
    const body = Buffer.from(JSON.stringify({
      account: "instance:user", method: "apply",
      operation: { operationId: "split-utf8", action: "remember", scope: "global", content },
    }));
    const split = body.indexOf(Buffer.from("中")) + 1;
    const result = deferred<{ status: number; body: any }>();
    const pending = request({
      hostname: "127.0.0.1", port: address.port, path: "/v1/call", method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": body.length },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        try { result.resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { result.reject(error); }
      });
      response.on("error", result.reject);
    });
    pending.on("error", result.reject);
    pending.write(body.subarray(0, split));
    await firstChunk.promise;
    pending.end(body.subarray(split));
    const response = await result.promise;
    assert.equal(response.status, 200);
    assert.equal(response.body.data.content, content);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
