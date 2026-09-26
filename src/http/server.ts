import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ConfigCipher, sha256 } from "../core/security.js";
import { AdapterRegistry, RefreshOrchestrator } from "../services/refresh.js";
import { ProjectRegistry } from "../services/project-registry.js";
import { ProjectQueryService } from "../services/query.js";
import { AskProjectService } from "../services/ask-project.js";
import { ObservatoryAgentService } from "../intelligence/agent.js";
import { handleMcpRequest, type McpJsonRpcRequest } from "../mcp/server.js";
import { MCP_READ_SCOPES, oauthMcpConfiguration, oauthScopeForTool, protectedResourceMetadata, verifyOAuthMcpAccessToken, type McpReadScope } from "../mcp/oauth.js";
import { McpToolError, ObservatoryToolService } from "../mcp/tools.js";
import type { ObservatoryStore } from "../core/store.js";
import type { ProjectSource, SourceConfig, SourceType } from "../domain/types.js";

export interface ObservatoryHttpServices {
  /** Present in production; optional to retain the small in-memory test seam. */
  store?: ObservatoryStore;
  registry: ProjectRegistry;
  refresh: RefreshOrchestrator;
  queries: ProjectQueryService;
  ask: AskProjectService;
  /** Optional: AI is deliberately absent when disabled or misconfigured. */
  agent?: ObservatoryAgentService;
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
    const status = /not found/i.test(message) ? 404 : /must|required|already exists|unsupported|too large/i.test(message) ? 400 : 500;
    if (isBrowserPageRequest(request)) return sendHtml(response, browserNotFound(message), status);
    send(response, status, { error: message });
  }
}

async function route(request: IncomingMessage, response: ServerResponse, services: ObservatoryHttpServices): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (method === "GET" && path === "/health") return send(response, 200, { status: "ok", service: "project-observatory", version: "0.1.0" });
  if (method === "GET" && path === "/.well-known/oauth-protected-resource") return sendProtectedResourceMetadata(request, response);
  if (method === "GET" && path === "/") return sendHtml(response, dashboard(services.queries.listProjects()));
  const browserSegments = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (method === "GET" && path === "/projects/new") {
    const csrf = issueCsrfToken(request);
    const authenticated = hasOnboardingOperatorAccess(request);
    return sendHtml(response, authenticated ? onboardingForm(csrf.token) : operatorSignIn(csrf.token), 200, csrf.headers);
  }
  if (method === "POST" && path === "/projects/new/auth") return authenticateOnboardingOperator(request, response);
  if (method === "POST" && path === "/projects/new/test") return testOnboardingConnection(request, response, services);
  if (method === "POST" && path === "/projects/new/create") return createOnboardedProject(request, response, services);
  if (method === "GET" && path === "/projects") return sendHtml(response, projectsIndex(services.queries.listProjects()));
  if (method === "POST" && browserSegments[0] === "projects" && browserSegments[1] && browserSegments[2] === "sources" && browserSegments[3] && browserSegments[4] === "test" && browserSegments.length === 5) {
    return testExistingSource(request, response, services, browserSegments[1], browserSegments[3]);
  }
  if (method === "POST" && browserSegments[0] === "projects" && browserSegments[1] && browserSegments[2] === "sources" && browserSegments[3] && browserSegments[4] === "credential" && browserSegments.length === 5) {
    return replaceExistingSourceCredential(request, response, services, browserSegments[1], browserSegments[3]);
  }
  if (method === "POST" && browserSegments[0] === "projects" && browserSegments[1] && browserSegments[2] === "refresh" && browserSegments.length === 3) {
    return refreshExistingProject(request, response, services, browserSegments[1]);
  }
  if (method === "GET" && browserSegments[0] === "projects" && browserSegments[1] && browserSegments.length <= 3) {
    const page = browserSegments[2] ?? "overview";
    const csrf = issueCsrfToken(request);
    return sendHtml(response, projectScreen(services, browserSegments[1], page, url.searchParams.get("onboarding") === "complete", csrf.token, hasOnboardingOperatorAccess(request)), 200, csrf.headers);
  }
  if (path === "/mcp") return handleRemoteMcp(request, response, services);
  if (path === "/mcp/tools") return handleLegacyMcpTools(request, response, services);
  if (path === "/mcp/call") return handleLegacyMcpCall(request, response, services);
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
  if (resource === "ask" && method === "POST" && segments.length === 4) {
    const body = await jsonBody(request, 12_000);
    return send(response, 200, await services.ask.ask(projectId, stringField(body, "question")));
  }
  if (resource === "assistant" && method === "POST" && segments.length === 4) {
    const body = await jsonBody(request, 12_000);
    const question = assistantQuestion(body);
    if (!services.agent) {
      const project = services.queries.getProject(projectId);
      return send(response, 503, {
        answer: "The Observatory assistant is not available. Deterministic Ask Project remains available.",
        status: "insufficient_evidence",
        project: project.slug,
        evidence: [],
        toolCalls: [],
        availability: "unavailable",
      });
    }
    const result = await services.agent.answer(projectId, question);
    return send(response, result.availability === "available" ? 200 : 503, result);
  }
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

type McpErrorCode = "unauthorized" | "project_not_found" | "invalid_question" | "invalid_query" | "evidence_not_found" | "evidence_not_in_project" | "invalid_path" | "excerpt_range_too_large" | "insufficient_evidence" | "internal_error";
type McpReadPrincipal = { credentialClass: "mcp_read"; authMethod: "fixed_bearer" | "oauth"; scopes: ReadonlySet<McpReadScope> };

async function handleRemoteMcp(request: IncomingMessage, response: ServerResponse, services: ObservatoryHttpServices): Promise<void> {
  const principal = await authenticateMcpRead(request);
  if (!principal) {
    await recordMcpAuthenticationFailure(services.store, request);
    return sendUnauthenticatedMcpResponse(request, response);
  }
  if (request.method !== "POST") return sendMcpError(response, null, "invalid_query", 405);
  let rpcRequest: McpJsonRpcRequest;
  try {
    rpcRequest = await jsonBody(request, 64_000) as unknown as McpJsonRpcRequest;
    if (rpcRequest.jsonrpc !== "2.0" || typeof rpcRequest.method !== "string") throw new Error("invalid request");
  } catch {
    return sendMcpError(response, null, "invalid_query", 400);
  }
  const id = validMcpId(rpcRequest.id);
  const requiredScope = requiredToolScope(rpcRequest);
  if (requiredScope && !principal.scopes.has(requiredScope)) {
    await recordMcpRead(services.store, rpcRequest, principal, "unauthorized");
    return sendMcpAuthenticationResult(response, id, mcpChallengeHeaders(request, requiredScope, "insufficient_scope"));
  }
  try {
    const result = await handleMcpRequest(rpcRequest, services.tools);
    if (rpcRequest.method === "tools/call") await recordMcpRead(services.store, rpcRequest, principal);
    return send(response, 200, { jsonrpc: "2.0", id, result });
  } catch (error) {
    const code = mcpErrorCode(error);
    if (rpcRequest.method === "tools/call") await recordMcpRead(services.store, rpcRequest, principal, code);
    return sendMcpError(response, id, code, 200);
  }
}

async function handleLegacyMcpTools(request: IncomingMessage, response: ServerResponse, services: ObservatoryHttpServices): Promise<void> {
  if (!await authenticateMcpRead(request)) return send(response, 401, { error: { code: "unauthorized" } }, mcpChallengeHeaders(request));
  if (request.method !== "GET") return send(response, 405, { error: { code: "invalid_query" } });
  return send(response, 200, { tools: services.tools.listTools() });
}

async function handleLegacyMcpCall(request: IncomingMessage, response: ServerResponse, services: ObservatoryHttpServices): Promise<void> {
  const principal = await authenticateMcpRead(request);
  if (!principal) return send(response, 401, { error: { code: "unauthorized" } }, mcpChallengeHeaders(request));
  if (request.method !== "POST") return send(response, 405, { error: { code: "invalid_query" } });
  try {
    const body = await jsonBody(request, 64_000);
    if (typeof body.name !== "string" || !isRecord(body.arguments ?? {})) throw new McpToolError("invalid_query");
    const requiredScope = oauthScopeForTool(body.name);
    if (requiredScope && !principal.scopes.has(requiredScope)) return send(response, 401, { error: { code: "unauthorized" } }, mcpChallengeHeaders(request, requiredScope));
    const result = await services.tools.call(body.name, body.arguments as Record<string, unknown>);
    await recordMcpRead(services.store, { jsonrpc: "2.0", method: "tools/call", params: { name: body.name, arguments: body.arguments } }, principal);
    return send(response, 200, { result });
  } catch (error) {
    const code = mcpErrorCode(error);
    return send(response, 400, { error: { code } });
  }
}

function sendProtectedResourceMetadata(request: IncomingMessage, response: ServerResponse): void {
  const resource = publicMcpResource(request);
  const configuration = oauthMcpConfiguration(resource);
  if (!configuration) return send(response, 503, { error: "OAuth discovery is not configured." });
  return send(response, 200, protectedResourceMetadata(resource, configuration));
}

async function authenticateMcpRead(request: IncomingMessage): Promise<McpReadPrincipal | undefined> {
  if (process.env.NODE_ENV === "production" && !isHttpsRequest(request)) return undefined;
  const configuredToken = process.env.OBSERVATORY_MCP_READ_TOKEN;
  const authorization = request.headers.authorization;
  if (configuredToken && typeof authorization === "string" && sameSecret(authorization, `Bearer ${configuredToken}`)) {
    return { credentialClass: "mcp_read", authMethod: "fixed_bearer", scopes: new Set(MCP_READ_SCOPES) };
  }
  const configuration = oauthMcpConfiguration(publicMcpResource(request));
  return configuration ? verifyOAuthMcpAccessToken(typeof authorization === "string" ? authorization : undefined, configuration) : undefined;
}

function isHttpsRequest(request: IncomingMessage): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  return typeof forwarded === "string" && forwarded.split(",")[0]?.trim() === "https";
}

function validMcpId(id: McpJsonRpcRequest["id"]): string | number | null {
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function sendMcpError(response: ServerResponse, id: string | number | null, code: McpErrorCode, status: number, headers: Record<string, string> = {}): void {
  send(response, status, { jsonrpc: "2.0", id, error: { code: -32_000, message: "MCP request failed.", data: { code } } }, headers);
}

/**
 * A 401 header starts protocol discovery. For a real tool invocation, the MCP
 * result also carries the runtime signal ChatGPT uses to show its OAuth link
 * UI. Neither response includes token or claim information.
 */
async function sendUnauthenticatedMcpResponse(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") return sendMcpError(response, null, "unauthorized", 401, mcpChallengeHeaders(request, undefined, "invalid_token"));
  try {
    const rpcRequest = await jsonBody(request, 64_000) as unknown as McpJsonRpcRequest;
    if (rpcRequest.jsonrpc === "2.0" && rpcRequest.method === "tools/call") {
      return sendMcpAuthenticationResult(response, validMcpId(rpcRequest.id), mcpChallengeHeaders(request, requiredToolScope(rpcRequest), "invalid_token"));
    }
  } catch {
    // Deliberately keep the same generic 401 response for malformed requests.
  }
  return sendMcpError(response, null, "unauthorized", 401, mcpChallengeHeaders(request, undefined, "invalid_token"));
}

function sendMcpAuthenticationResult(response: ServerResponse, id: string | number | null, headers: Record<string, string>): void {
  send(response, 401, {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: "Authentication is required to use this tool." }],
      isError: true,
      _meta: { "mcp/www_authenticate": [headers["www-authenticate"]] },
    },
  }, headers);
}

function mcpErrorCode(error: unknown): McpErrorCode {
  if (error instanceof McpToolError) return error.code;
  return "internal_error";
}

function requiredToolScope(request: McpJsonRpcRequest): McpReadScope | undefined {
  return request.method === "tools/call" ? oauthScopeForTool(request.params?.name) : undefined;
}

function mcpChallengeHeaders(request: IncomingMessage, scope?: McpReadScope, error: "invalid_token" | "insufficient_scope" = "invalid_token"): Record<string, string> {
  const metadata = `${publicMcpResource(request)}/.well-known/oauth-protected-resource`;
  const requestedScopes = scope ?? MCP_READ_SCOPES.join(" ");
  const description = error === "insufficient_scope" ? "An OAuth scope required by this tool is missing." : "Authentication is required.";
  return { "www-authenticate": `Bearer resource_metadata="${metadata}", scope="${requestedScopes}", error="${error}", error_description="${description}"` };
}

function publicMcpResource(request: IncomingMessage): string {
  const configured = process.env.OBSERVATORY_MCP_PUBLIC_ORIGIN;
  if (configured) {
    const parsed = new URL(configured);
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") throw new Error("OBSERVATORY_MCP_PUBLIC_ORIGIN must use HTTPS in production.");
    return parsed.toString().replace(/\/$/, "");
  }
  if (process.env.NODE_ENV === "production") return "https://the-observatory-blue.vercel.app";
  const protocol = isHttpsRequest(request) ? "https" : "http";
  return `${protocol}://${request.headers.host ?? "localhost"}`;
}

async function recordMcpAuthenticationFailure(store: ObservatoryStore | undefined, request: IncomingMessage): Promise<void> {
  if (!store || typeof request.headers.authorization !== "string" || !oauthMcpConfiguration(publicMcpResource(request))) return;
  try {
    store.auditEvents.push({ id: randomUUID(), actorId: "mcp_read", action: "mcp.oauth_token_validation_failed", metadata: { credentialClass: "mcp_read", authMethod: "oauth" }, createdAt: new Date().toISOString() });
    await store.flush();
  } catch { /* Audit failure must not alter authentication behavior. */ }
}

async function recordMcpRead(store: ObservatoryStore | undefined, request: McpJsonRpcRequest, principal: McpReadPrincipal, outcome: McpErrorCode | "success" = "success"): Promise<void> {
  if (!store) return;
  try {
    const name = request.params?.name;
    store.auditEvents.push({
      id: randomUUID(),
      actorId: "mcp_read",
      action: "mcp.read",
      metadata: { credentialClass: principal.credentialClass, authMethod: principal.authMethod, scopes: [...principal.scopes].sort(), tool: typeof name === "string" ? name.slice(0, 120) : request.method, outcome },
      createdAt: new Date().toISOString(),
    });
    await store.flush();
  } catch {
    // Observability must never turn a successful, bounded read into a failure.
  }
}

function assertOperator(request: IncomingMessage): void {
  const configuredToken = process.env.OBSERVATORY_OPERATOR_TOKEN;
  if (configuredToken && request.headers.authorization !== `Bearer ${configuredToken}`) throw new Error("Operator authorization is required.");
  if (!configuredToken && process.env.NODE_ENV === "production") throw new Error("OBSERVATORY_OPERATOR_TOKEN is required for production administration.");
}

function actor(request: IncomingMessage): string | undefined { return typeof request.headers["x-observatory-actor"] === "string" ? request.headers["x-observatory-actor"] : undefined; }
type OnboardingFields = { name: string; slug: string; description?: string; repository: string; branch: string; token: string };
type OnboardingTicket = OnboardingFields & { expiresAt: number; revision: string };
type OperatorSession = { expiresAt: number; tokenHash: string };
type CsrfIssue = { token: string; headers?: Record<string, string | string[]> };

function issueCsrfToken(request: IncomingMessage): CsrfIssue {
  const current = cookieValue(request, "observatory_csrf");
  if (current && /^[A-Za-z0-9_-]{32,}$/.test(current)) return { token: current };
  const token = randomBytes(32).toString("base64url");
  return { token, headers: { "set-cookie": cookie("observatory_csrf", token, "/projects", 900) } };
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const entry of header.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(value.join("=")); } catch { return undefined; }
    }
  }
  return undefined;
}

function cookie(name: string, value: string, path: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function clearCookie(name: string, path: string): string { return cookie(name, "", path, 0); }

function seal(value: unknown): string { return ConfigCipher.fromEnvironment().encrypt(value); }
function unseal<T>(request: IncomingMessage, name: string): T | undefined {
  const value = cookieValue(request, name);
  if (!value) return undefined;
  try { return ConfigCipher.fromEnvironment().decrypt<T>(value); } catch { return undefined; }
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hasOnboardingOperatorAccess(request: IncomingMessage): boolean {
  const expected = process.env.OBSERVATORY_OPERATOR_TOKEN;
  if (!expected) return false;
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && sameSecret(authorization, `Bearer ${expected}`)) return true;
  const session = unseal<OperatorSession>(request, "observatory_operator");
  return Boolean(session && session.expiresAt > Date.now() && sameSecret(session.tokenHash, sha256(expected)));
}

function sameOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || !host) throw new Error("Onboarding requests must come from the same origin.");
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol = (typeof forwarded === "string" ? forwarded.split(",")[0] : undefined) === "https" ? "https" : "http";
  if (origin !== `${protocol}://${host}`) throw new Error("Onboarding requests must come from the same origin.");
}

function secureCredentialTransport(request: IncomingMessage): void {
  if (process.env.NODE_ENV !== "production") return;
  const forwarded = request.headers["x-forwarded-proto"];
  if (typeof forwarded !== "string" || forwarded.split(",")[0] !== "https") throw new Error("Credentials may only be submitted over HTTPS.");
}

function assertCsrf(request: IncomingMessage, form: Record<string, string>): void {
  const supplied = form.csrf;
  const expected = cookieValue(request, "observatory_csrf");
  if (!supplied || !expected || !sameSecret(supplied, expected)) throw new Error("Invalid onboarding form token.");
}

async function formBody(request: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  return Object.fromEntries(fields.entries());
}

function formField(form: Record<string, string>, name: string): string { return form[name]?.trim() ?? ""; }
function slugify(value: string): string { return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "project"; }

function onboardingFields(form: Record<string, string>, services: ObservatoryHttpServices): OnboardingFields {
  const name = formField(form, "name");
  const slug = (formField(form, "slug") || slugify(name)).toLowerCase();
  const repository = formField(form, "repository");
  const branch = formField(form, "branch") || "main";
  const token = formField(form, "token");
  if (!name) throw new Error("Project name is required.");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Project slug must be kebab-case.");
  if (services.registry.listProjects().some((project) => project.slug === slug)) throw new Error(`Project slug '${slug}' already exists.`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub repository must use owner/repository format.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) throw new Error("Default branch is invalid.");
  if (!token) throw new Error("A fine-grained GitHub token is required.");
  return { name, slug, description: formField(form, "description") || undefined, repository, branch, token };
}

function repositoryConfig(fields: OnboardingFields): SourceConfig { return { repository: fields.repository, defaultBranch: fields.branch, token: fields.token, readOnly: true }; }
function valuesWithoutToken(fields: Partial<OnboardingFields>): Omit<OnboardingFields, "token"> { return { name: fields.name ?? "", slug: fields.slug ?? "", description: fields.description, repository: fields.repository ?? "", branch: fields.branch ?? "main" }; }
function onboardingError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/Project name|required|slug|owner\/repository|Default branch/i.test(message)) return message;
  return "Repository not accessible with supplied credential.";
}

function operatorRequiredPage(): string { return layout("Operator authorization required — Project Observatory", `<h1>Operator authorization required</h1><p>Use the existing Observatory operator token to access onboarding.</p><p><a href="/projects/new">Return to onboarding</a></p>`); }

async function authenticateOnboardingOperator(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const form = await formBody(request);
  sameOrigin(request);
  assertCsrf(request, form);
  secureCredentialTransport(request);
  const expected = process.env.OBSERVATORY_OPERATOR_TOKEN;
  if (!expected || !sameSecret(formField(form, "operatorToken"), expected)) return sendHtml(response, operatorSignIn(formField(form, "csrf"), "Operator authorization was not accepted."), 403);
  const session = seal({ expiresAt: Date.now() + 15 * 60_000, tokenHash: sha256(expected) } satisfies OperatorSession);
  sendRedirect(response, "/projects/new", [cookie("observatory_operator", session, "/projects", 900)]);
}

async function testOnboardingConnection(request: IncomingMessage, response: ServerResponse, services: ObservatoryHttpServices): Promise<void> {
  const form = await formBody(request);
  sameOrigin(request);
  assertCsrf(request, form);
  secureCredentialTransport(request);
  if (!hasOnboardingOperatorAccess(request)) return sendHtml(response, operatorRequiredPage(), 403);
  let fields: OnboardingFields | undefined;
  try {
    fields = onboardingFields(form, services);
    const tested = await services.refresh.testRepositoryConnection("github", repositoryConfig(fields));
    if (tested.health.state !== "healthy" || !tested.revision) throw new Error("Repository not accessible with supplied credential.");
    const ticket = seal({ ...fields, revision: tested.revision, expiresAt: Date.now() + 10 * 60_000 } satisfies OnboardingTicket);
    return sendHtml(response, onboardingReady(valuesWithoutToken(fields), tested.revision, formField(form, "csrf")), 200, { "set-cookie": cookie("observatory_onboarding", ticket, "/projects/new", 600) });
  } catch (error) {
    return sendHtml(response, onboardingForm(formField(form, "csrf"), valuesWithoutToken(fields ?? { name: formField(form, "name"), slug: formField(form, "slug"), description: formField(form, "description") || undefined, repository: formField(form, "repository"), branch: formField(form, "branch") || "main", token: "" }), onboardingError(error)), 400);
  }
}

async function createOnboardedProject(request: IncomingMessage, response: ServerResponse, services: ObservatoryHttpServices): Promise<void> {
  const form = await formBody(request);
  sameOrigin(request);
  assertCsrf(request, form);
  secureCredentialTransport(request);
  if (!hasOnboardingOperatorAccess(request)) return sendHtml(response, operatorRequiredPage(), 403);
  const ticket = unseal<OnboardingTicket>(request, "observatory_onboarding");
  if (!ticket || ticket.expiresAt <= Date.now()) return sendHtml(response, onboardingForm(formField(form, "csrf"), {}, "Connection confirmation expired. Test the connection again."), 400, { "set-cookie": clearCookie("observatory_onboarding", "/projects/new") });
  try {
    const tested = await services.refresh.testRepositoryConnection("github", repositoryConfig(ticket));
    if (tested.health.state !== "healthy") throw new Error("Repository not accessible with supplied credential.");
  } catch {
    return sendHtml(response, onboardingForm(formField(form, "csrf"), valuesWithoutToken(ticket), "Repository not accessible with supplied credential."), 400, { "set-cookie": clearCookie("observatory_onboarding", "/projects/new") });
  }
  let project: { id: string; slug: string };
  let source: { id: string };
  try {
    ({ project, source } = await services.registry.createProjectWithSource({ name: ticket.name, slug: ticket.slug, description: ticket.description }, { type: "repository", provider: "github", config: repositoryConfig(ticket) }, actor(request)));
  } catch (error) {
    return sendHtml(response, onboardingForm(formField(form, "csrf"), valuesWithoutToken(ticket), onboardingError(error)), 400, { "set-cookie": clearCookie("observatory_onboarding", "/projects/new") });
  }
  try {
    await services.refresh.checkSource(project.id, source.id);
    const result = await services.refresh.refresh(project.id);
    if (result.run.status === "failed") return sendHtml(response, onboardingIncomplete(project.slug, formField(form, "csrf")), 202, { "set-cookie": clearCookie("observatory_onboarding", "/projects/new") });
  } catch {
    return sendHtml(response, onboardingIncomplete(project.slug, formField(form, "csrf")), 202, { "set-cookie": clearCookie("observatory_onboarding", "/projects/new") });
  }
  sendRedirect(response, `/projects/${encodeURIComponent(project.slug)}?onboarding=complete`, [clearCookie("observatory_onboarding", "/projects/new")]);
}

async function testExistingSource(request: IncomingMessage, response: ServerResponse, services: ObservatoryHttpServices, projectRef: string, sourceId: string): Promise<void> {
  const form = await formBody(request);
  sameOrigin(request);
  assertCsrf(request, form);
  if (!hasOnboardingOperatorAccess(request)) return sendHtml(response, operatorRequiredPage(), 403);
  const project = services.queries.getProject(projectRef);
  const health = await services.refresh.checkSource(project.id, sourceId);
  return sendHtml(response, sourceActionPage(project.slug, `Connection test: ${health.state}.`, formField(form, "csrf")));
}

async function replaceExistingSourceCredential(request: IncomingMessage, response: ServerResponse, services: ObservatoryHttpServices, projectRef: string, sourceId: string): Promise<void> {
  const form = await formBody(request);
  sameOrigin(request);
  assertCsrf(request, form);
  secureCredentialTransport(request);
  if (!hasOnboardingOperatorAccess(request)) return sendHtml(response, operatorRequiredPage(), 403);
  const project = services.queries.getProject(projectRef);
  const source = services.registry.getSources(project.id).find((candidate) => candidate.id === sourceId);
  if (!source || source.provider !== "github") return sendHtml(response, sourceActionPage(project.slug, "Credential replacement is not available for this source.", formField(form, "csrf")), 400);
  await services.registry.replaceSourceCredential(project.id, sourceId, formField(form, "token"), actor(request));
  return sendHtml(response, sourceActionPage(project.slug, "Credential replaced securely. Test the connection before refreshing.", formField(form, "csrf")));
}

async function refreshExistingProject(request: IncomingMessage, response: ServerResponse, services: ObservatoryHttpServices, projectRef: string): Promise<void> {
  const form = await formBody(request);
  sameOrigin(request);
  assertCsrf(request, form);
  if (!hasOnboardingOperatorAccess(request)) return sendHtml(response, operatorRequiredPage(), 403);
  const project = services.queries.getProject(projectRef);
  const result = await services.refresh.refresh(project.id);
  if (result.run.status === "failed") return sendHtml(response, onboardingIncomplete(project.slug, formField(form, "csrf")), 202);
  return sendHtml(response, sourceActionPage(project.slug, `Refresh ${result.run.status}.`, formField(form, "csrf")));
}

function publicSource(source: ProjectSource) { return { id: source.id, projectId: source.projectId, type: source.type, provider: source.provider, enabled: source.enabled, lastHealth: source.lastHealth, lastCheckedAt: source.lastCheckedAt }; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function stringField(value: Record<string, unknown>, key: string): string { const field = value[key]; if (typeof field !== "string" || !field.trim()) throw new Error(`'${key}' must be a non-empty string.`); return field; }
function assistantQuestion(value: Record<string, unknown>): string { const question = stringField(value, "question"); if (question.trim().length > 2_000) throw new Error("'question' must be at most 2000 characters."); return question; }
function optionalStringField(value: Record<string, unknown>, key: string): string | undefined { const field = value[key]; if (field === undefined) return undefined; if (typeof field !== "string") throw new Error(`'${key}' must be a string.`); return field; }
function optionalBooleanField(value: Record<string, unknown>, key: string): boolean | undefined { const field = value[key]; if (field === undefined) return undefined; if (typeof field !== "boolean") throw new Error(`'${key}' must be a boolean.`); return field; }
function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> { const field = value[key]; if (!isRecord(field)) throw new Error(`'${key}' must be an object.`); return field; }
function numberQuery(url: URL, key: string): number | undefined { const value = url.searchParams.get(key); if (value === null) return undefined; const parsed = Number(value); if (!Number.isInteger(parsed)) throw new Error(`'${key}' must be an integer.`); return parsed; }
async function jsonBody(request: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length; if (size > maxBytes) throw new Error("Request body is too large."); chunks.push(part); } if (chunks.length === 0) return {}; const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!isRecord(parsed)) throw new Error("Request body must be a JSON object."); return parsed; }
function send(response: ServerResponse, status: number, data: unknown, headers: Record<string, string | string[]> = {}): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }); response.end(JSON.stringify(data)); }
function sendHtml(response: ServerResponse, html: string, status = 200, headers: Record<string, string | string[]> = {}): void { response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers }); response.end(html); }
function sendRedirect(response: ServerResponse, location: string, cookies: string[] = []): void { response.writeHead(303, { location, "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) }); response.end(); }
function isBrowserPageRequest(request: IncomingMessage): boolean { const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname; return request.method === "GET" && path !== "/api" && !path.startsWith("/api/") && path !== "/mcp" && !path.startsWith("/mcp/"); }
function projectCards(projects: ReturnType<ProjectQueryService["listProjects"]>): string { return projects.map((project) => `<article><h2><a href="/projects/${encodeURIComponent(project.slug)}">${escapeHtml(project.name)}</a></h2><p><code>${escapeHtml(project.slug)}</code></p><dl><dt>Repository</dt><dd>${escapeHtml(project.repositoryRevision ?? "Not observed")}</dd><dt>Deployment</dt><dd>${escapeHtml(project.deploymentRevision ?? "Not observed")}</dd><dt>Conflicts</dt><dd>${project.unresolvedConflictCount}</dd><dt>Recent movements</dt><dd>${project.recentMovementCount}</dd></dl></article>`).join("") || "<p>No projects registered. Use <code>POST /api/projects</code> to register one.</p>"; }
function dashboard(projects: ReturnType<ProjectQueryService["listProjects"]>): string { return layout("Project Observatory", `<h1>Project Observatory</h1><p>Evidence-backed, read-only project intelligence.</p><p><a href="/projects">Browse all registered projects</a> <a class="button" href="/projects/new">Add project</a></p><main>${projectCards(projects)}</main>`); }
function projectsIndex(projects: ReturnType<ProjectQueryService["listProjects"]>): string { return layout("Projects — Project Observatory", `<h1>Projects</h1><p>Registered projects and their observed evidence summaries.</p><p><a class="button" href="/projects/new">Add project</a></p><main>${projectCards(projects)}</main>`); }
function browserNotFound(message = "The requested browser page was not found."): string { return layout("Page not found — Project Observatory", `<h1>Page not found</h1><p>${escapeHtml(message)}</p><p><a href="/">Return to Project Observatory</a> or <a href="/projects">browse projects</a>.</p>`); }
function projectScreen(services: ObservatoryHttpServices, projectRef: string, page: string, onboardingComplete: boolean, csrf: string, canOperate: boolean): string {
  const state = services.queries.getProjectState(projectRef);
  const project = state.project;
  const base = `/projects/${encodeURIComponent(project.slug)}`;
  const nav = ["overview", "state", "knowledge", "movements", "sources", "ask"].map((item) => `<a class="${page === item ? "active" : ""}" href="${base}${item === "overview" ? "" : `/${item}`}">${item.replace(/^./, (char) => char.toUpperCase())}</a>`).join("");
  let content: string;
  switch (page) {
    case "overview": content = `${onboardingComplete ? onboardingSuccess(services.queries.getOnboardingSummary(project.id), project.name) : ""}<h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.description ?? "No project description.")}</p><section><h2>Current snapshot</h2><dl><dt>Repository head</dt><dd>${escapeHtml(state.snapshot?.repositoryRevision ?? "Unknown")}</dd><dt>Production deployment</dt><dd>${escapeHtml(state.snapshot?.deploymentRevision ?? "Unknown")}</dd><dt>Knowledge items</dt><dd>${state.summary?.knowledgeCount ?? 0}</dd><dt>Resolution</dt><dd>${escapeHtml(state.summary?.resolution ?? "No snapshot")}</dd></dl></section><section><h2>Unresolved conflicts</h2>${list(state.unresolvedConflicts.map((conflict) => `${conflict.severity}: ${conflict.title}`))}</section><section><h2>Recent movements</h2>${list(state.latestMovements.slice(0, 8).map((movement) => `${movement.movementType}: ${movement.entityKey}`))}</section>`; break;
    case "state": content = `<h1>Current State</h1>${json(state)}`; break;
    case "knowledge": content = `<h1>Knowledge</h1>${list(services.queries.getKnowledge(project.id).map((record) => `${record.item.type}: ${record.item.title} — ${record.provenance.map((provenance) => provenance.path ?? provenance.sourceRef).join(", ")}`))}`; break;
    case "movements": content = `<h1>Movements</h1>${list(services.queries.getRecentChanges(project.id).map((movement) => `${movement.createdAt}: ${movement.movementType} ${movement.entityKey}`))}`; break;
    case "sources": content = sourcesScreen(project.slug, services.registry.getSources(project.id), csrf, canOperate); break;
    case "ask": content = askScreen(project.slug, project.name, services.queries.listProjects()); break;
    default: throw new Error("Browser page not found.");
  }
  return layout(`${project.name} — Project Observatory`, `<nav class="project-nav">${nav}</nav>${content}`);
}

function askScreen(slug: string, name: string, projects: ReturnType<ProjectQueryService["listProjects"]>): string {
  const options = projects.map((project) => `<option value="${escapeHtml(project.slug)}"${project.slug === slug ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const suggestions = ["Where is this value configured?", "How does this feature work?", "Which tests cover this behaviour?", "Where would I change this safely?", "What changed recently in this area?"];
  return `<h1>Ask ${escapeHtml(name)}</h1><p class="project-label">Project: <strong>${escapeHtml(name)}</strong></p><label for="ask-project">Project selector<select id="ask-project" aria-label="Project selector">${options}</select></label><form id="ask-form"><label for="ask-question">Ask a question about ${escapeHtml(name)}<textarea id="ask-question" name="question" maxlength="2000" required placeholder="Where is this value configured?"></textarea></label><button type="submit">Ask</button></form><section class="wide"><h2>Suggested questions</h2><p>${suggestions.map((suggestion) => `<button class="suggestion" type="button" data-question="${escapeHtml(suggestion)}">${escapeHtml(suggestion)}</button>`).join("")}</p></section><section id="ask-result" class="wide" aria-live="polite"><p class="muted">Answers are grounded only in this project’s current indexed snapshot.</p></section><script>
(() => {
  const slug=${JSON.stringify(slug)};
  const form=document.querySelector('#ask-form');
  const input=document.querySelector('#ask-question');
  const output=document.querySelector('#ask-result');
  const selector=document.querySelector('#ask-project');
  selector.addEventListener('change', () => { window.location.assign('/projects/' + encodeURIComponent(selector.value) + '/ask'); });
  document.querySelectorAll('[data-question]').forEach((button) => button.addEventListener('click', () => { input.value=button.dataset.question || ''; input.focus(); }));
  const add=(parent, tag, value, className) => { const element=document.createElement(tag); if(className) element.className=className; element.textContent=value; parent.appendChild(element); return element; };
  const lineLabel=(e) => e.startLine ? 'lines ' + e.startLine + (e.endLine && e.endLine !== e.startLine ? '–' + e.endLine : '') : 'line unavailable';
  const render=(data) => {
    output.replaceChildren();
    add(output,'h2','Answer');
    add(output,'p','Status: ' + data.status);
    add(output,'p','Repository revision: ' + (data.repositoryRevision || 'Unavailable'));
    add(output,'p',data.answer);
    add(output,'h2','Evidence');
    if (!data.evidence.length) add(output,'p','No matching current evidence was returned.');
    const evidence=document.createElement('ul');
    data.evidence.forEach((item) => { const row=document.createElement('li'); add(row,'strong',item.role.replaceAll('_',' ')); add(row,'div',item.path || 'Path unavailable'); add(row,'div',lineLabel(item),'muted'); add(row,'div','Reason: ' + item.reason); evidence.appendChild(row); });
    output.appendChild(evidence);
    if (data.conflicts && data.conflicts.length) { add(output,'h2','Conflicts'); const conflicts=document.createElement('ul'); data.conflicts.forEach((item) => { const row=document.createElement('li'); add(row,'strong',item.title); add(row,'div',item.description); conflicts.appendChild(row); }); output.appendChild(conflicts); }
  };
  form.addEventListener('submit', async (event) => { event.preventDefault(); output.replaceChildren(); add(output,'p','Checking the current indexed evidence…','muted'); try { const response=await fetch('/api/projects/' + encodeURIComponent(slug) + '/ask',{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({question:input.value})}); const data=await response.json(); if(!response.ok) throw new Error(data.error || 'Ask request failed.'); render(data); } catch(error) { output.replaceChildren(); add(output,'p',error instanceof Error ? error.message : 'Ask request failed.','notice error'); } });
})();
</script>`;
}

function operatorSignIn(csrf: string, message?: string): string { return layout("Operator sign-in — Project Observatory", `<h1>Operator authorization required</h1><p>Enter the existing Observatory operator token to start a short-lived, same-site session for project onboarding.</p>${message ? `<p class="notice error">${escapeHtml(message)}</p>` : ""}<form method="post" action="/projects/new/auth"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Operator token<input name="operatorToken" type="password" required autocomplete="current-password"></label><button type="submit">Authorize onboarding</button></form>`); }

function onboardingForm(csrf: string, values: Partial<Omit<OnboardingFields, "token">> = {}, message?: string): string {
  const name = values.name ?? "";
  const slug = values.slug ?? slugify(name);
  return layout("Add project — Project Observatory", `<h1>Add project</h1><p>Observatory uses read-only evidence collection. Test access before any project or source is persisted.</p>${message ? `<p class="notice error">${escapeHtml(message)}</p>` : ""}<ol><li>Project details</li><li>GitHub repository</li><li>Connection test</li><li>Create and ingest</li></ol><form method="post" action="/projects/new/test"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><fieldset><legend>1. Project details</legend><label>Project name<input id="project-name" name="name" required value="${escapeHtml(name)}"></label><label>Slug<input id="project-slug" name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value="${escapeHtml(slug)}"></label><label>Description <span class="muted">optional</span><textarea name="description">${escapeHtml(values.description ?? "")}</textarea></label></fieldset><fieldset><legend>2. GitHub repository</legend><label>Repository<input name="repository" required placeholder="owner/repository" value="${escapeHtml(values.repository ?? "")}"></label><label>Default branch<input name="branch" required value="${escapeHtml(values.branch ?? "main")}"></label><label>Fine-grained GitHub token<input name="token" type="password" required autocomplete="off"></label><p>Grant access only to this repository, with <strong>Metadata: Read-only</strong> and <strong>Contents: Read-only</strong>. Do not grant write, Actions, Administration, Workflow, or deployment permissions.</p><p class="muted">Observatory is read-only toward the observed repository. Tokens are accepted only over HTTPS and are never rendered or returned.</p></fieldset><fieldset><legend>3. Connection test</legend><button type="submit">Test connection</button></fieldset></form><script>const name=document.querySelector('#project-name'),slug=document.querySelector('#project-slug');let edited=false;slug.addEventListener('input',()=>edited=true);name.addEventListener('input',()=>{if(!edited)slug.value=name.value.normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'project'});</script>`);
}

function onboardingReady(values: Omit<OnboardingFields, "token">, revision: string, csrf: string): string { return layout("Connection healthy — Project Observatory", `<h1>Connection healthy</h1><p class="notice success">Healthy<br>Repository accessible<br>Branch: ${escapeHtml(values.branch)}</p><dl><dt>Project</dt><dd>${escapeHtml(values.name)}</dd><dt>Repository</dt><dd>${escapeHtml(values.repository)}</dd><dt>Repository revision</dt><dd>${escapeHtml(revision)}</dd></dl><p>The tested credential is held only in an encrypted, short-lived HttpOnly onboarding cookie until creation.</p><form method="post" action="/projects/new/create"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Create project and ingest</button></form><p><a href="/projects/new">Start over</a></p>`); }

function onboardingSuccess(summary: ReturnType<ProjectQueryService["getOnboardingSummary"]>, name: string): string { return `<section class="wide notice success"><h2>${escapeHtml(name)} onboarded</h2><dl><dt>Repository</dt><dd>${escapeHtml(summary.repository ?? "Not observed")}</dd><dt>Repository revision</dt><dd>${escapeHtml(summary.repositoryRevision ?? "Not observed")}</dd><dt>Source health</dt><dd>${escapeHtml(summary.sourceHealth ?? "Unknown")}</dd><dt>Refresh status</dt><dd>${escapeHtml(summary.refreshStatus ?? "Unknown")}</dd><dt>Snapshot ID</dt><dd><code>${escapeHtml(summary.snapshotId ?? "No snapshot")}</code></dd><dt>Artifacts</dt><dd>${summary.artifactCount}</dd><dt>Knowledge</dt><dd>${summary.knowledgeCount}</dd><dt>Provenance</dt><dd>${summary.provenanceCount}</dd><dt>Open conflicts</dt><dd>${summary.openConflictCount}</dd></dl></section>`; }

function onboardingIncomplete(slug: string, csrf: string): string { const base = `/projects/${encodeURIComponent(slug)}`; return layout("Onboarding incomplete — Project Observatory", `<h1>Onboarding incomplete — refresh failed</h1><p>The project and encrypted source configuration were preserved. Retry the read-only refresh when the repository is reachable.</p><form method="post" action="${base}/refresh"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Retry refresh</button></form><p><a href="${base}/sources">View sources</a> · <a href="${base}">Project overview</a></p>`); }

function sourceActionPage(slug: string, message: string, csrf: string): string { const base = `/projects/${encodeURIComponent(slug)}`; return layout("Source action — Project Observatory", `<h1>Source action</h1><p class="notice success">${escapeHtml(message)}</p><p><a href="${base}/sources">Return to sources</a></p><form method="post" action="${base}/refresh"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Refresh project</button></form>`); }

function sourcesScreen(slug: string, sources: ProjectSource[], csrf: string, canOperate: boolean): string {
  const base = `/projects/${encodeURIComponent(slug)}`;
  const entries = sources.map((source) => `<article><h2>${escapeHtml(source.provider)}</h2><dl><dt>Source type</dt><dd>${escapeHtml(source.type)}</dd><dt>Provider</dt><dd>${escapeHtml(source.provider)}</dd><dt>Health</dt><dd>${escapeHtml(source.lastHealth?.state ?? "Not checked")}</dd><dt>Last checked</dt><dd>${escapeHtml(source.lastCheckedAt ?? "Never")}</dd><dt>Enabled</dt><dd>${source.enabled ? "Yes" : "No"}</dd></dl>${canOperate ? `<form method="post" action="${base}/sources/${encodeURIComponent(source.id)}/test"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Test connection</button></form>${source.provider === "github" ? `<form method="post" action="${base}/sources/${encodeURIComponent(source.id)}/credential"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Replacement credential<input type="password" name="token" required autocomplete="off"></label><button type="submit">Replace credential</button></form>` : ""}` : ""}</article>`).join("") || "<p>No sources registered.</p>";
  return `<h1>Sources</h1><p>Source configurations and credentials are not displayed.</p>${entries}${canOperate ? `<form method="post" action="${base}/refresh"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Refresh project</button></form>` : `<p class="muted">Operator authorization is required for source actions.</p>`}`;
}

function list(values: string[]): string { return values.length ? `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : "<p>None.</p>"; }
function json(value: unknown): string { return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`; }
function layout(title: string, content: string): string { return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:960px;margin:3rem auto;padding:0 1rem;background:#08111b;color:#e8f0f7}article,section,fieldset{display:inline-block;vertical-align:top;width:260px;min-height:150px;margin:0 1rem 1rem 0;padding:1.25rem;background:#122232;border:1px solid #28465e;border-radius:12px;box-sizing:border-box}section{width:calc(50% - 3rem)}section.wide{width:100%}h1{font-size:2rem}h2{margin-top:0}dt{color:#9eb6ca}dd{margin:0 0 .7rem}code,a{color:#7cdbff}a{font-weight:600}.button,button{display:inline-block;border:0;border-radius:6px;padding:.55rem .8rem;background:#1d6888;color:#fff;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;margin:.35rem .35rem .35rem 0}.site-nav,.project-nav{display:flex;gap:1rem;margin:1.25rem 0}.site-nav{margin-top:0;padding-bottom:1rem;border-bottom:1px solid #28465e}.project-nav .active{color:#fff;text-decoration-thickness:3px}form{margin:.75rem 0}label{display:block;margin:.7rem 0;font-weight:600}input,textarea,select{box-sizing:border-box;display:block;width:100%;margin-top:.25rem;padding:.55rem;border:1px solid #517089;border-radius:6px;background:#07131f;color:#e8f0f7;font:inherit}textarea{min-height:5rem}.notice{padding:1rem;border-radius:8px}.notice.success{background:#113c2e;border:1px solid #277653}.notice.error{background:#481f29;border:1px solid #a14055}.muted{color:#9eb6ca}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#122232;padding:1rem;border-radius:8px}li{margin:.5rem 0}@media(max-width:640px){section,article,fieldset{width:100%;margin-right:0}.site-nav,.project-nav{flex-wrap:wrap}}</style><nav class="site-nav" aria-label="Primary"><a href="/">Home</a><a href="/projects">Projects</a></nav>${content}</html>`; }
function escapeHtml(value: string): string { return value.replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character); }
