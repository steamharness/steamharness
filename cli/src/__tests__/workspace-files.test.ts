// @vitest-environment node
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initI18n } from "@steamharness/i18n";
import { main } from "../workspace";

const projectId = "11111111-1111-4111-8111-111111111111";
const connection = ["--server", "https://server.example", "--token", "test-token"];
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workflow-cli-files-"));
  initI18n({ preference: "en" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

it("uploads a business image, reads the original bytes back, and deletes only its file id", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
  const source = join(root, "map.png");
  const output = join(root, "download.png");
  await writeFile(source, bytes);
  const reference = { id: "wf_abc123", name: "map.png", mimeType: "image/png", size: bytes.length, kind: "image", storage: "server", workflowId: projectId, createdAt: "2026-10-08T00:00:00Z" };
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ errCode: 0, errMessage: "", data: [reference] })))
    .mockResolvedValueOnce(new Response(bytes))
    .mockResolvedValueOnce(new Response(JSON.stringify({ errCode: 0, errMessage: "", data: { id: reference.id } })));
  vi.stubGlobal("fetch", fetch);

  await main(["file-upload", projectId, "--file", source, ...connection]);
  expect(fetch.mock.calls[0]![0]).toBe(`https://server.example/api/projects/${projectId}/files?fileName=map.png&mimeType=image%2Fpng`);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer test-token" } });
  expect(Buffer.from(fetch.mock.calls[0]![1].body)).toEqual(bytes);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"storage": "server"'));

  await main(["file-download", reference.id, "--output", output, ...connection]);
  expect(await readFile(output)).toEqual(bytes);
  expect(fetch.mock.calls[1]![1]).toMatchObject({ headers: { Authorization: "Bearer test-token" }, redirect: "error" });
  await main(["file-delete", reference.id, ...connection]);
  expect(fetch.mock.calls[2]![0]).toBe("https://server.example/api/projects/files/wf_abc123");
  expect(fetch.mock.calls[2]![1].method).toBe("DELETE");
});

it("keeps existing download destinations intact and never writes an access error as image content", async () => {
  const output = join(root, "image.png");
  await writeFile(output, "existing data");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("new data")));
  await expect(main(["file-download", "wf_abc123", "--output", output, ...connection])).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(output, "utf8")).toBe("existing data");

  const denied = join(root, "denied.png");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ errCode: 403, errMessage: "File access denied." }), { status: 403 })));
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await main(["file-download", "wf_abc123", "--output", denied, ...connection]);
  expect(process.exitCode).toBe(1);
  await expect(stat(denied)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects oversized files before sending bytes to the server", async () => {
  const source = join(root, "large.png");
  await writeFile(source, "");
  await truncate(source, 50 * 1024 * 1024 + 1);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(main(["file-upload", projectId, "--file", source, ...connection])).rejects.toThrow(/50 MiB/);
  expect(fetch).not.toHaveBeenCalled();
});
