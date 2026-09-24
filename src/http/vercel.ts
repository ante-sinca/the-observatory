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
    // A warm serverless instance may have served another invocation before a
    // different instance committed data. Rehydrate before every request so
    // response correctness never depends on sticky process memory.
    const initialized = await services;
    await initialized.store.reload();
    await handleHttpRequest(request, response, initialized);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unable to initialize durable storage." }));
  }
  };
}

// Vercel may reuse this promise between invocations. The handler still reloads
// canonical Neon state before serving each request.
export default function vercelHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  observatory ??= createObservatory();
  return createVercelHandler(observatory)(request, response);
}
