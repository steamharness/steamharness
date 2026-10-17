import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { installWorkflowRuntimeGlobal } from "steamharness/runtime-api";

it.each(["workspace", "read-only", "auto"])("exposes the Workflow through real stdio MCP with the %s policy and authenticated host", async permissionPolicy => {
  const calls: unknown[] = [];
  const token = "isolated-mcp-test-token";
  const dataDir = await mkdtemp(path.join(tmpdir(), "studio-control-mcp-"));
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end(JSON.stringify({ ok: false })); return; }
    response.end(JSON.stringify({ ok: true, value: { marker: "studio-mcp-result" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  const runtime = installWorkflowRuntimeGlobal();
  const cliManifest = createRequire(import.meta.url).resolve("@steamharness/cli/package.json");
  const cli = JSON.parse(await readFile(cliManifest, "utf8"));
  const keys = ["STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL", "STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN"];
  let connection;
  try {
    connection = await runtime.connectMcpServer({
      id: "workflow-studio", command: [process.execPath, path.resolve(path.dirname(cliManifest), cli.bin["steamharness"]), "mcp", path.resolve(import.meta.dirname, ".."), "--data-dir", dataDir],
      inheritEnvironment: keys,
      environment: { STEAMHARNESS_STUDIO_CONTROL_PERMISSION_POLICY: permissionPolicy },
    }, { allowedInheritedEnvKeys: keys, env: {
      STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL: `http://127.0.0.1:${address.port}/studio-control`, STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN: token,
    } });
    expect(connection.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      "studio_state", "get_related_projects", "open_file", "get_diagnostics", "set_theme", "open_terminal", "show_view",
    ]));
    const result = await connection.callTool("studio_state", {});
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("studio-mcp-result");
    expect(calls).toContainEqual({ operation: "studio.state.get", input: {}, permissionPolicy });
    await connection.callTool("open_file", { filePath: "index.ts", line: 2, column: 3 });
    expect(calls).toContainEqual({ operation: "studio.file.open", input: { filePath: "index.ts", line: 2, column: 3 }, permissionPolicy });
    const related = await connection.callTool("get_related_projects", { projectDir: "projects/notes" });
    expect(related.isError).toBe(false);
    expect(JSON.stringify(related.content)).toContain("studio-mcp-result");
    expect(calls).toContainEqual({ operation: "studio.relatedProjects.get", input: { projectDir: "projects/notes" }, permissionPolicy });
    for (const [tool, input, operation] of [
      ["get_related_projects", {}, "studio.relatedProjects.get"],
      ["get_diagnostics", {}, "studio.diagnostics.get"],
      ["get_diagnostics", { filePath: "index.ts" }, "studio.diagnostics.get"],
      ["set_theme", { theme: "Dark" }, "studio.theme.set"],
      ["open_terminal", {}, "studio.terminal.open"],
      ["open_terminal", { cwd: "src" }, "studio.terminal.open"],
      ["show_view", { view: "explorer" }, "studio.view.show"],
    ] as const) {
      const response = await connection.callTool(tool, input);
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      expect(calls).toContainEqual({ operation, input, permissionPolicy });
    }
  } finally {
    await connection?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
