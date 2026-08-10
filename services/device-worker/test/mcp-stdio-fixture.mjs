import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const assignmentKey = "44444444-4444-4444-8444-444444444444";
const invocationKey = "33333333-3333-4333-8333-333333333333";
const inputSchema = {
  type: "object",
  properties: {
    target: { type: "string", title: "目标环境", writeOnly: false },
  },
  required: ["target"],
  additionalProperties: false,
};

const server = new Server(
  { name: "forgex-mcp-stdio-fixture", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "notifications.send",
      description: "测试用团队通知",
      inputSchema,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.arguments?.target === "error") {
    throw new Error("Authorization: Bearer local-mcp-secret-marker");
  }
  const valid =
    request.params.name === "notifications.send" &&
    request.params.arguments?.target === "production" &&
    request.params._meta?.["forgex/invocationKey"] === invocationKey &&
    request.params._meta?.["forgex/assignmentKey"] === assignmentKey &&
    request.params._meta?.["forgex/fencingToken"] === 7;
  return {
    content: [{ type: "text", text: valid ? "accepted" : "rejected" }],
    isError: !valid,
  };
});

await server.connect(new StdioServerTransport());
