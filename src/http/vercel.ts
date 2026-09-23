import type { IncomingMessage, ServerResponse } from "node:http";
import { createObservatory } from "../index.js";
import { handleHttpRequest } from "./server.js";

type Observatory = Awaited<ReturnType<typeof createObservatory>>;
let observatory: Promise<Observatory> | undefined;

export function createVercelHandler(services: Promise<Observatory>) {
  return async function vercelHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    // vercel.json rewrites every public path to /api and carries the original
    // path in a reserved query parameter so the framework-neutral router sees
    // /health, /, and all API/MCP paths exactly as it does under node:http.
    const rewritten = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const originalPath = rewritten.searchParams.get("__observatory_path");
    if (originalPath) {
      rewritten.searchParams.delete("__observatory_path");
      const query = rewritten.searchParams.toString();
      request.url = `${originalPath.startsWith("/") ? originalPath : `/${originalPath}`}${query ? `?${query}` : ""}`;
    }
    await handleHttpRequest(request, response, await services);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unable to initialize durable storage." }));
  }
  };
}

// Vercel may reuse this promise between invocations, but correctness never
// relies on that reuse: its first initialization hydrates state from Neon.
export default function vercelHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  observatory ??= createObservatory();
  return createVercelHandler(observatory)(request, response);
}
