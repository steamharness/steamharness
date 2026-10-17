import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createWebDevServerOptions } from "../web-dev";

test("Server Web dev options enable HMR by default", () => {
  const server = createServer();
  const options = createWebDevServerOptions({ webRoot: "/repo/server/web", server, env: {} });

  assert.equal(options.root, "/repo/server/web");
  assert.equal(options.configFile, path.join("/repo/server/web", "vite.config.ts"));
  assert.deepEqual(options.server.hmr, { server });
  assert.equal(options.server.middlewareMode, true);
});

test("Server Web dev options disable HMR for the start mode", () => {
  const options = createWebDevServerOptions({
    webRoot: "/repo/server/web",
    server: createServer(),
    env: { STEAMHARNESS_SERVER_HMR: "0" },
  });

  assert.equal(options.server.hmr, false);
  assert.equal(options.server.middlewareMode, true);
  assert.equal(options.appType, "custom");
});
