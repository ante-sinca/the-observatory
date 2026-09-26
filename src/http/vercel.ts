import type { IncomingMessage, ServerResponse } from "node:http";
import { createObservatory } from "../index.js";
import { handleHttpRequest } from "./server.js";

type Observatory = Awaited<ReturnType<typeof createObservatory>>;
let observatory: Promise<Observatory> | undefined;

/** Restores the public path after Vercel rewrites it to the thin /api adapter. */
export function restoreVercelRequestUrl(requestUrl: string | undefined, host = "localhost"): string {
  const rewritten = new URL(requestUrl ?? "/", `http://${host}`);
  const originalPath = rewritten.searchParams.get("__observatory_path");
  if (originalPath === null) return `${rewritten.pathname}${rewritten.search}`;
  rewritten.searchParams.delete("__observatory_path");
  return `${originalPath.startsWith("/") ? originalPath : `/${originalPath}`}${rewritten.search}`;
}

export function createVercelHandler(services: Promise<Observatory>) {
  return async function vercelHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    // vercel.json rewrites every public path to /api and carries the original
    // path in a reserved query parameter so the framework-neutral router sees
    // /health, /, and all API/MCP paths exactly as it does under node:http.
    request.url = restoreVercelRequestUrl(request.url, request.headers.host ?? "localhost");
    // Reads use request-scoped, targeted PostgreSQL queries. A warm instance
    // therefore observes canonical state without rehydrating the database
    // (and every artifact body) into process memory before each invocation.
    const initialized = await services;
    await handleHttpRequest(request, response, initialized);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unable to initialize durable storage." }));
  }
  };
}

// Vercel may reuse this promise between invocations; read services query
// current canonical rows for every request rather than reuse array state.
export default function vercelHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  observatory ??= createObservatory();
  return createVercelHandler(observatory)(request, response);
}
