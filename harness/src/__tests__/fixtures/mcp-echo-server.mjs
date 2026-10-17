// A minimal stdio MCP server used by the agent MCP tests.
//
// It exists so the client can be exercised against a real child process and a
// real handshake, rather than against a hand-written stub of the SDK. It uses
// the low-level `Server` so the tool schemas are plain JSON Schema, exactly the
// shape a real server publishes.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "echo",
    description: "Echo the given text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "fail",
    description: "Always reports an error.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "inherited",
    description: "Report the inherited environment value.",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  if (name === "echo") {
    return { content: [{ type: "text", text: `echo:${request.params.arguments?.text ?? ""}` }] };
  }
  if (name === "fail") {
    return { isError: true, content: [{ type: "text", text: "it broke" }] };
  }
  if (name === "inherited") {
    // The client passes this through by name, so the server is the only place
    // its arrival is observable.
    return { content: [{ type: "text", text: process.env.MCP_TEST_INHERITED ?? "(missing)" }] };
  }
  return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
});

await server.connect(new StdioServerTransport());
