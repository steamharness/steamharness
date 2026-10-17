import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { runTestToolRequest } from "../test-tool";

interface ReceivedRequest {
  method: string | undefined;
  url: string | undefined;
  testHeader: string | undefined;
  body: string;
}

describe("test_tool", () => {
  it("sends a network request and returns the response preview", async () => {
    let resolveReceived: (request: ReceivedRequest) => void;
    const received = new Promise<ReceivedRequest>((resolve) => {
      resolveReceived = resolve;
    });
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const requestSnapshot = {
          method: request.method,
          url: request.url,
          testHeader: request.headers["x-test-tool"] as string | undefined,
          body,
        };
        resolveReceived(requestSnapshot);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          receivedBody: body,
          path: request.url,
        }));
      });
    });

    await listen(server);
    try {
      const address = server.address() as AddressInfo;
      const result = await runTestToolRequest({
        url: `http://127.0.0.1:${address.port}/probe?mode=tool`,
        method: "POST",
        headers: {
          "x-test-tool": "network",
        },
        body: "ping",
      });

      expect(await received).toEqual({
        method: "POST",
        url: "/probe?mode=tool",
        testHeader: "network",
        body: "ping",
      });
      expect(result).toMatchObject({
        ok: true,
        method: "POST",
        status: 201,
        contentType: "application/json",
      });
      expect(result.bodyPreview).toContain("\"receivedBody\":\"ping\"");
    } finally {
      await closeServer(server);
    }
  });

  it("rejects non-http URLs before fetching", async () => {
    await expect(runTestToolRequest({ url: "file:///tmp/example.txt" })).rejects.toThrow(/http and https/);
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
