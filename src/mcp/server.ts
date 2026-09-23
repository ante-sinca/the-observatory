import { createInterface } from "node:readline";
import { ObservatoryToolService } from "./tools.js";

interface JsonRpcRequest { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown>; }

/** Minimal stdio MCP JSON-RPC transport suitable for local MCP clients. */
export function runMcpStdioServer(tools: ObservatoryToolService): void {
  const lineReader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lineReader.on("line", (line) => {
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const result = handle(request, tools);
      if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: error instanceof Error ? error.message : "MCP request failed." } })}\n`);
    }
  });
}

function handle(request: JsonRpcRequest, tools: ObservatoryToolService): unknown {
  switch (request.method) {
    case "initialize": return { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "project-observatory", version: "0.1.0" } };
    case "tools/list": return { tools: tools.listTools() };
    case "tools/call": {
      const name = request.params?.name;
      if (typeof name !== "string") throw new Error("MCP tools/call requires params.name.");
      const argumentsValue = request.params?.arguments;
      const args = argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue) ? argumentsValue as Record<string, unknown> : {};
      return { content: [{ type: "text", text: JSON.stringify(tools.call(name, args)) }] };
    }
    case "notifications/initialized": return {};
    default: throw new Error(`Unsupported MCP method '${request.method}'.`);
  }
}
