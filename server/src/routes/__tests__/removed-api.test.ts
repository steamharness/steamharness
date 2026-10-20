import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import express from "express";
import type { Storage } from "../../storage";
import { createApiRouter } from "../api";
import { createRemovedApiRouter } from "../removed-api";

const html = '<!doctype html><div id="root"></div>';

async function startServer(t: TestContext): Promise<string> {
  const app = express();
  app.use(createRemovedApiRouter());
  app.use("/api", createApiRouter({} as Storage));
  app.get("*", (_req, res) => res.type("html").send(html));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("direct project Web requests reach the HTML fallback", async (t) => {
  const origin = await startServer(t);
  for (const pathname of ["/", "/projects", "/projects/", "/projects?search=demo", "/project/demo/project"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${origin}${pathname}`, { method, headers: { Accept: "text/html" } });
      assert.equal(response.status, 200, `${method} ${pathname}`);
      assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(await response.text(), method === "HEAD" ? "" : html);
    }
  }
});

test("removed API namespaces still return JSON 404 before the Web fallback", async (t) => {
  const origin = await startServer(t);
  for (const pathname of ["/v1", "/v1/projects/demo/run", "/webhooks", "/webhooks/demo", "/projects/demo/run"]) {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${origin}${pathname}`, { method, headers: { Accept: "text/html" } });
      assert.equal(response.status, 404, `${method} ${pathname}`);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal((await response.json() as { errCode: number }).errCode, 404);
    }
  }
  const response = await fetch(`${origin}/projects`, { method: "POST" });
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal((await response.json() as { errCode: number }).errCode, 404);
});

test("unknown API and removed execution routes do not fall back to HTML", async (t) => {
  const origin = await startServer(t);
  for (const pathname of ["/api/missing", "/api/projects/demo/runs"]) {
    const response = await fetch(`${origin}${pathname}`, { headers: { Accept: "text/html" } });
    assert.equal(response.status, 404, pathname);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal((await response.json() as { errCode: number }).errCode, 404);
  }
});
