import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AdapterRegistry, RefreshOrchestrator } from "../services/refresh.js";
import { ProjectRegistry } from "../services/project-registry.js";
import { ProjectQueryService } from "../services/query.js";
import { ObservatoryToolService } from "../mcp/tools.js";
import type { ProjectSource, SourceConfig, SourceType } from "../domain/types.js";

export interface ObservatoryHttpServices {
  registry: ProjectRegistry;
  refresh: RefreshOrchestrator;
  queries: ProjectQueryService;
  tools: ObservatoryToolService;
}

export function createHttpServer(services: ObservatoryHttpServices): Server {
  return createServer(async (request, response) => {
    await handleHttpRequest(request, response, services);
  });
}

/** Usable from Node's long-lived server and Vercel's one-invocation handler. */
export async function handleHttpRequest(request: IncomingMessage, response: ServerResponse, services: ObservatoryHttpServices): Promise<void> {
  try {
    await route(request, response, services);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    const status = /not found/i.test(message) ? 404 : /must|required|already exists|unsupported/i.test(message) ? 400 : 500;
    if (isBrowserPageRequest(request)) return sendHtml(response, browserNotFound(message), status);
    send(response, status, { error: message });
  }
}

async function route(request: IncomingMessage, response: ServerResponse, services: ObservatoryHttpServices): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (method === "GET" && path === "/health") return send(response, 200, { status: "ok", service: "project-observatory", version: "0.1.0" });
  if (method === "GET" && path === "/") return sendHtml(response, dashboard(services.queries.listProjects()));
  const browserSegments = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (method === "GET" && path === "/projects") return sendHtml(response, projectsIndex(services.queries.listProjects()));
  if (method === "GET" && browserSegments[0] === "projects" && browserSegments[1] && browserSegments.length <= 3) {
    const page = browserSegments[2] ?? "overview";
    return sendHtml(response, projectScreen(services.queries, browserSegments[1], page));
  }
  if (method === "GET" && path === "/mcp/tools") return send(response, 200, { tools: services.tools.listTools() });
  if (method === "POST" && path === "/mcp/call") {
    const body = await jsonBody(request);
    if (typeof body.name !== "string") throw new Error("'name' is required.");
    const input = isRecord(body.arguments) ? body.arguments : {};
    return send(response, 200, { result: services.tools.call(body.name, input) });
  }
  if (path === "/api/projects" && method === "GET") return send(response, 200, services.queries.listProjects());
  if (path === "/api/projects" && method === "POST") {
    assertOperator(request);
    const body = await jsonBody(request);
    return send(response, 201, await services.registry.createProject({ slug: stringField(body, "slug"), name: stringField(body, "name"), description: optionalStringField(body, "description") }, actor(request)));
  }
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== "api" || segments[1] !== "projects" || !segments[2]) {
    if (isBrowserPageRequest(request)) return sendHtml(response, browserNotFound(), 404);
    return send(response, 404, { error: "Route not found." });
  }
  const projectRef = segments[2];
  if (segments.length === 3 && method === "GET") return send(response, 200, services.queries.getProjectState(projectRef));
  if (segments.length === 3 && method === "PATCH") {
    assertOperator(request);
    const body = await jsonBody(request);
    return send(response, 200, await services.registry.updateProject(services.queries.getProject(projectRef).id, { name: optionalStringField(body, "name"), description: optionalStringField(body, "description") }, actor(request)));
  }
  const projectId = services.queries.getProject(projectRef).id;
  const resource = segments[3];
  if (resource === "sources" && method === "GET" && segments.length === 4) return send(response, 200, services.registry.getSources(projectId).map(publicSource));
  if (resource === "sources" && method === "POST" && segments.length === 4) {
    assertOperator(request);
    const body = await jsonBody(request);
    const type = stringField(body, "type");
    if (type !== "repository" && type !== "deployment") throw new Error("'type' must be repository or deployment.");
    return send(response, 201, publicSource(await services.registry.addSource(projectId, { type: type as SourceType, provider: stringField(body, "provider"), config: recordField(body, "config") as SourceConfig, enabled: optionalBooleanField(body, "enabled") }, actor(request))));
  }
  if (resource === "sources" && segments[4] && segments[5] === "health" && method === "POST") {
    assertOperator(request);
    return send(response, 200, await services.refresh.checkSource(projectId, segments[4]));
  }
  if (resource === "refresh" && method === "POST") {
    assertOperator(request);
    return send(response, 202, await services.refresh.refresh(projectId));
  }
  if (resource === "refresh-runs" && method === "GET") return send(response, 200, services.queries.getRefreshRuns(projectId));
  if (resource === "state" && method === "GET") return send(response, 200, services.queries.getProjectState(projectId));
  if (resource === "snapshots" && method === "GET" && segments.length === 4) return send(response, 200, services.queries.getSnapshots(projectId));
  if (resource === "snapshots" && method === "GET" && segments[4]) return send(response, 200, services.queries.getSnapshot(projectId, segments[4]));
  if (resource === "movements" && method === "GET") return send(response, 200, services.queries.getRecentChanges(projectId, url.searchParams.get("since") ?? undefined));
  if (resource === "conflicts" && method === "GET") return send(response, 200, services.queries.getConflicts(projectId));
  if (resource === "knowledge" && method === "GET" && segments.length === 4) return send(response, 200, services.queries.getKnowledge(projectId));
  if (resource === "knowledge" && method === "GET" && segments[4]) return send(response, 200, services.queries.getKnowledge(projectId, segments[4]));
  if (resource === "search" && method === "GET") return send(response, 200, services.queries.searchProject(projectId, url.searchParams.get("q") ?? "", { domain: url.searchParams.get("domain") ?? undefined, type: url.searchParams.get("type") as import("../domain/types.js").KnowledgeType | undefined, limit: numberQuery(url, "limit") }));
  if (resource === "deployments" && method === "GET") return send(response, 200, services.queries.getDeployments(projectId, url.searchParams.get("environment") ?? undefined, numberQuery(url, "limit")));
  return send(response, 404, { error: "Route not found." });
}

function assertOperator(request: IncomingMessage): void {
  const configuredToken = process.env.OBSERVATORY_OPERATOR_TOKEN;
  if (configuredToken && request.headers.authorization !== `Bearer ${configuredToken}`) throw new Error("Operator authorization is required.");
  if (!configuredToken && process.env.NODE_ENV === "production") throw new Error("OBSERVATORY_OPERATOR_TOKEN is required for production administration.");
}

function actor(request: IncomingMessage): string | undefined { return typeof request.headers["x-observatory-actor"] === "string" ? request.headers["x-observatory-actor"] : undefined; }
function publicSource(source: ProjectSource) { return { id: source.id, projectId: source.projectId, type: source.type, provider: source.provider, enabled: source.enabled, lastHealth: source.lastHealth, lastCheckedAt: source.lastCheckedAt }; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function stringField(value: Record<string, unknown>, key: string): string { const field = value[key]; if (typeof field !== "string" || !field.trim()) throw new Error(`'${key}' must be a non-empty string.`); return field; }
function optionalStringField(value: Record<string, unknown>, key: string): string | undefined { const field = value[key]; if (field === undefined) return undefined; if (typeof field !== "string") throw new Error(`'${key}' must be a string.`); return field; }
function optionalBooleanField(value: Record<string, unknown>, key: string): boolean | undefined { const field = value[key]; if (field === undefined) return undefined; if (typeof field !== "boolean") throw new Error(`'${key}' must be a boolean.`); return field; }
function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> { const field = value[key]; if (!isRecord(field)) throw new Error(`'${key}' must be an object.`); return field; }
function numberQuery(url: URL, key: string): number | undefined { const value = url.searchParams.get(key); if (value === null) return undefined; const parsed = Number(value); if (!Number.isInteger(parsed)) throw new Error(`'${key}' must be an integer.`); return parsed; }
async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); } if (chunks.length === 0) return {}; const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!isRecord(parsed)) throw new Error("Request body must be a JSON object."); return parsed; }
function send(response: ServerResponse, status: number, data: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(data)); }
function sendHtml(response: ServerResponse, html: string, status = 200): void { response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(html); }
function isBrowserPageRequest(request: IncomingMessage): boolean { const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname; return request.method === "GET" && path !== "/api" && !path.startsWith("/api/") && path !== "/mcp" && !path.startsWith("/mcp/"); }
function projectCards(projects: ReturnType<ProjectQueryService["listProjects"]>): string { return projects.map((project) => `<article><h2><a href="/projects/${encodeURIComponent(project.slug)}">${escapeHtml(project.name)}</a></h2><p><code>${escapeHtml(project.slug)}</code></p><dl><dt>Repository</dt><dd>${escapeHtml(project.repositoryRevision ?? "Not observed")}</dd><dt>Deployment</dt><dd>${escapeHtml(project.deploymentRevision ?? "Not observed")}</dd><dt>Conflicts</dt><dd>${project.unresolvedConflictCount}</dd><dt>Recent movements</dt><dd>${project.recentMovementCount}</dd></dl></article>`).join("") || "<p>No projects registered. Use <code>POST /api/projects</code> to register one.</p>"; }
function dashboard(projects: ReturnType<ProjectQueryService["listProjects"]>): string { return layout("Project Observatory", `<h1>Project Observatory</h1><p>Evidence-backed, read-only project intelligence.</p><p><a href="/projects">Browse all registered projects</a></p><main>${projectCards(projects)}</main>`); }
function projectsIndex(projects: ReturnType<ProjectQueryService["listProjects"]>): string { return layout("Projects — Project Observatory", `<h1>Projects</h1><p>Registered projects and their observed evidence summaries.</p><main>${projectCards(projects)}</main>`); }
function browserNotFound(message = "The requested browser page was not found."): string { return layout("Page not found — Project Observatory", `<h1>Page not found</h1><p>${escapeHtml(message)}</p><p><a href="/">Return to Project Observatory</a> or <a href="/projects">browse projects</a>.</p>`); }
function projectScreen(queries: ProjectQueryService, projectRef: string, page: string): string { const state = queries.getProjectState(projectRef); const project = state.project; const base = `/projects/${encodeURIComponent(project.slug)}`; const nav = ["overview", "state", "knowledge", "movements", "sources"].map((item) => `<a class="${page === item ? "active" : ""}" href="${base}${item === "overview" ? "" : `/${item}`}">${item.replace(/^./, (char) => char.toUpperCase())}</a>`).join(""); let content: string; switch (page) { case "overview": content = `<h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.description ?? "No project description.")}</p><section><h2>Current snapshot</h2><dl><dt>Repository head</dt><dd>${escapeHtml(state.snapshot?.repositoryRevision ?? "Unknown")}</dd><dt>Production deployment</dt><dd>${escapeHtml(state.snapshot?.deploymentRevision ?? "Unknown")}</dd><dt>Knowledge items</dt><dd>${state.summary?.knowledgeCount ?? 0}</dd><dt>Resolution</dt><dd>${escapeHtml(state.summary?.resolution ?? "No snapshot")}</dd></dl></section><section><h2>Unresolved conflicts</h2>${list(state.unresolvedConflicts.map((conflict) => `${conflict.severity}: ${conflict.title}`))}</section><section><h2>Recent movements</h2>${list(state.latestMovements.slice(0, 8).map((movement) => `${movement.movementType}: ${movement.entityKey}`))}</section>`; break; case "state": content = `<h1>Current State</h1>${json(state)}`; break; case "knowledge": content = `<h1>Knowledge</h1>${list(queries.getKnowledge(project.id).map((record) => `${record.item.type}: ${record.item.title} — ${record.provenance.map((provenance) => provenance.path ?? provenance.sourceRef).join(", ")}`))}`; break; case "movements": content = `<h1>Movements</h1>${list(queries.getRecentChanges(project.id).map((movement) => `${movement.createdAt}: ${movement.movementType} ${movement.entityKey}`))}`; break; case "sources": content = `<h1>Sources</h1>${json(state.sourceHealth)}`; break; default: throw new Error("Browser page not found."); } return layout(`${project.name} — Project Observatory`, `<nav class="project-nav">${nav}</nav>${content}`); }
function list(values: string[]): string { return values.length ? `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : "<p>None.</p>"; }
function json(value: unknown): string { return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`; }
function layout(title: string, content: string): string { return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:960px;margin:3rem auto;padding:0 1rem;background:#08111b;color:#e8f0f7}article,section{display:inline-block;vertical-align:top;width:260px;min-height:150px;margin:0 1rem 1rem 0;padding:1.25rem;background:#122232;border:1px solid #28465e;border-radius:12px}section{width:calc(50% - 3rem)}h1{font-size:2rem}h2{margin-top:0}dt{color:#9eb6ca}dd{margin:0 0 .7rem}code,a{color:#7cdbff}a{font-weight:600}.site-nav,.project-nav{display:flex;gap:1rem;margin:1.25rem 0}.site-nav{margin-top:0;padding-bottom:1rem;border-bottom:1px solid #28465e}.project-nav .active{color:#fff;text-decoration-thickness:3px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#122232;padding:1rem;border-radius:8px}li{margin:.5rem 0}@media(max-width:640px){section,article{box-sizing:border-box;width:100%;margin-right:0}.site-nav,.project-nav{flex-wrap:wrap}}</style><nav class="site-nav" aria-label="Primary"><a href="/">Home</a><a href="/projects">Projects</a></nav>${content}</html>`; }
function escapeHtml(value: string): string { return value.replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character); }
