// A stdio MCP server whose tool listing never ends.
//
// It exists so the client's pagination guard is exercised against a real
// handshake rather than a stub. The argument picks the shape of the lie:
//
//   repeat (default) - the same non-empty cursor forever
//   empty            - the empty string, which a careful server uses to mean
//                      "no more", but which the schema allows as a cursor
//
// A client that only stops on `undefined` would keep asking in both cases,
// paying the per-request timeout over and over.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2] === "empty" ? "empty" : "repeat";
const server = new Server({ name: "loop", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "ping",
    description: "Ping.",
    inputSchema: { type: "object", properties: {} },
  }],
  nextCursor: mode === "empty" ? "" : "again",
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: "pong" }],
}));

await server.connect(new StdioServerTransport());
