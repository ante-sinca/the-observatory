import { createInterface } from "node:readline";
import { McpToolError, ObservatoryToolService } from "./tools.js";

export interface McpJsonRpcRequest { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown>; }

/** Minimal stdio MCP JSON-RPC transport suitable for local MCP clients. */
export function runMcpStdioServer(tools: ObservatoryToolService): void {
  const lineReader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lineReader.on("line", (line) => {
    void handleLine(line, tools);
  });
}

async function handleLine(line: string, tools: ObservatoryToolService): Promise<void> {
  try {
    const request = JSON.parse(line) as McpJsonRpcRequest;
    const result = await handleMcpRequest(request, tools);
    if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: error instanceof Error ? error.message : "MCP request failed." } })}\n`);
  }
}

/** Shared by the local stdio server and the authenticated remote HTTP transport. */
export async function handleMcpRequest(request: McpJsonRpcRequest, tools: ObservatoryToolService): Promise<unknown> {
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") throw new McpToolError("invalid_query");
  switch (request.method) {
    case "initialize": return { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "project-observatory", version: "0.1.0" } };
    case "tools/list": return { tools: tools.listTools() };
    case "tools/call": {
      const name = request.params?.name;
      if (typeof name !== "string") throw new McpToolError("invalid_query");
      const argumentsValue = request.params?.arguments;
      if (argumentsValue !== undefined && (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue))) throw new McpToolError("invalid_query");
      const args = argumentsValue as Record<string, unknown> | undefined ?? {};
      const result = await tools.call(name, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    }
    case "notifications/initialized": return {};
    default: throw new McpToolError("invalid_query");
  }
}
