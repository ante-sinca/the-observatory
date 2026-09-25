import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from "jose";
import { ConfigCipher } from "../core/security.js";
import { MemoryStore } from "../core/store.js";
import type { KnowledgeItem, Project, Snapshot, SourceArtifact } from "../domain/types.js";
import { createHttpServer } from "../http/server.js";
import { MCP_READ_SCOPES } from "../mcp/oauth.js";
import { ObservatoryToolService } from "../mcp/tools.js";
import { AskProjectService } from "../services/ask-project.js";
import { ProjectQueryService } from "../services/query.js";
import { ProjectRegistry } from "../services/project-registry.js";
import { AdapterRegistry, RefreshOrchestrator } from "../services/refresh.js";

const observedAt = "2026-09-25T12:00:00.000Z";
const resource = "https://observatory.example.test";
const ownerSubject = "auth0|observatory-owner";

function project(id: string, slug: string, name: string): Project {
  return { id, slug, name, status: "active", createdAt: observedAt, updatedAt: observedAt };
}

function artifact(projectId: string, id: string, path: string, content: string, revision: string): SourceArtifact {
  return { id, projectId, sourceId: `${projectId}-source`, externalId: id, path, artifactType: "text", revision, contentHash: `${id}-hash`, content, metadata: {}, firstSeenAt: observedAt, lastSeenAt: observedAt };
}

function knowledge(projectId: string, id: string, title: string): KnowledgeItem {
  return { id, projectId, title, body: title, type: "implementation", status: "current", state: { documented: "unknown", implemented: "evidenced", tested: "unknown", deployed: "unknown", observed: "unknown" }, fingerprint: id, entityKey: id, createdAt: observedAt };
}

function snapshot(projectId: string, revision: string, knowledgeItemIds: string[]): Snapshot {
  return { id: `${projectId}-snapshot`, projectId, createdAt: observedAt, repositoryRevision: revision, sourceHealth: { [`${projectId}-source`]: { state: "healthy", checkedAt: observedAt } }, summary: { knowledgeCount: knowledgeItemIds.length, byType: { implementation: knowledgeItemIds.length }, resolution: "resolved" }, knowledgeItemIds };
}

async function mcp(origin: string, token: string | undefined, body: Record<string, unknown>) {
  const response = await fetch(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
}

function errorCode(body: Record<string, unknown>): string | undefined {
  return (body.error as { data?: { code?: string } } | undefined)?.data?.code;
}

async function accessToken(key: KeyLike, issuer: string, options: { audience?: string; issuer?: string; subject?: string; scope?: string; expiration?: string; notBefore?: string; type?: string; kid?: string } = {}): Promise<string> {
  const token = new SignJWT({ scope: options.scope ?? MCP_READ_SCOPES.join(" ") })
    .setProtectedHeader({ alg: "RS256", typ: options.type ?? "at+jwt", kid: options.kid ?? "oauth-test-key" })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? resource)
    .setSubject(options.subject ?? ownerSubject)
    .setIssuedAt()
    .setExpirationTime(options.expiration ?? "5m");
  if (options.notBefore) token.setNotBefore(options.notBefore);
  return token.sign(key);
}

test("OAuth MCP discovery and RS256 access tokens are scoped and fail closed", async () => {
  const environmentKeys = ["OBSERVATORY_MCP_READ_TOKEN", "OBSERVATORY_OPERATOR_TOKEN", "OBSERVATORY_OAUTH_ISSUER", "OBSERVATORY_OAUTH_AUDIENCE", "OBSERVATORY_OAUTH_ALLOWED_SUBJECT", "OBSERVATORY_OAUTH_JWKS_URI", "OBSERVATORY_MCP_PUBLIC_ORIGIN", "NODE_ENV"] as const;
  const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "oauth-test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const jwksServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const jwksOrigin = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}`;
  const issuer = `${jwksOrigin}/issuer`;
  process.env.OBSERVATORY_OAUTH_ISSUER = issuer;
  process.env.OBSERVATORY_OAUTH_AUDIENCE = resource;
  process.env.OBSERVATORY_OAUTH_ALLOWED_SUBJECT = ownerSubject;
  process.env.OBSERVATORY_OAUTH_JWKS_URI = `${jwksOrigin}/jwks`;
  process.env.OBSERVATORY_MCP_PUBLIC_ORIGIN = resource;
  process.env.OBSERVATORY_MCP_READ_TOKEN = "fixed-read-token";
  process.env.OBSERVATORY_OPERATOR_TOKEN = "operator-only-token";
  delete process.env.NODE_ENV;

  const store = new MemoryStore();
  const homeGift = project("oauth-homegift", "homegift", "HomeGift");
  const homeBound = project("oauth-homebound", "homebound", "HomeBound");
  const giftRevision = "homegift-oauth-r1";
  const boundRevision = "homebound-oauth-r1";
  const giftArtifact = artifact(homeGift.id, "oauth-gift-artifact", "src/config/donations.ts", "export const donationAmountPresets = [10, 25, 50];\nconst token = neverReturn;", giftRevision);
  const boundArtifact = artifact(homeBound.id, "oauth-bound-artifact", "src/fees/transaction.ts", "export const transactionFeeGbp = 2;", boundRevision);
  const giftKnowledge = knowledge(homeGift.id, "oauth-gift-knowledge", "Donation amount presets are configured in the donation module.");
  const boundKnowledge = knowledge(homeBound.id, "oauth-bound-knowledge", "Transaction fee runtime configuration.");
  store.projects.push(homeGift, homeBound);
  store.artifacts.push(giftArtifact, boundArtifact);
  store.knowledge.push(giftKnowledge, boundKnowledge);
  store.provenance.push(
    { id: "oauth-gift-provenance", knowledgeItemId: giftKnowledge.id, sourceArtifactId: giftArtifact.id, sourceType: "repository", sourceRef: giftArtifact.id, repositoryCommit: giftRevision, path: giftArtifact.path, metadata: {} },
    { id: "oauth-bound-provenance", knowledgeItemId: boundKnowledge.id, sourceArtifactId: boundArtifact.id, sourceType: "repository", sourceRef: boundArtifact.id, repositoryCommit: boundRevision, path: boundArtifact.path, metadata: {} },
  );
  store.snapshots.push(snapshot(homeGift.id, giftRevision, [giftKnowledge.id]), snapshot(homeBound.id, boundRevision, [boundKnowledge.id]));
  const queries = new ProjectQueryService(store);
  const ask = new AskProjectService(store, queries);
  const server = createHttpServer({ store, registry: new ProjectRegistry(store, ConfigCipher.fromEnvironment()), refresh: new RefreshOrchestrator(store, new AdapterRegistry()), queries, ask, tools: new ObservatoryToolService(queries, ask) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.status, 200);
    assert.equal(metadata.headers.get("cache-control"), "no-store");
    assert.deepEqual(await metadata.json(), { resource, authorization_servers: [issuer], scopes_supported: [...MCP_READ_SCOPES], resource_documentation: resource });

    const unauthenticated = await mcp(origin, undefined, { jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(unauthenticated.status, 401);
    assert.equal(errorCode(unauthenticated.body), "unauthorized");
    assert.equal(unauthenticated.headers.get("cache-control"), "no-store");
    assert.match(unauthenticated.headers.get("www-authenticate") ?? "", new RegExp(`resource_metadata="${resource}/\\.well-known/oauth-protected-resource"`));
    const unauthenticatedTool = await mcp(origin, undefined, { jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "list_projects", arguments: {} } });
    assert.equal(unauthenticatedTool.status, 401);
    const runtimeChallenge = ((unauthenticatedTool.body.result as { _meta?: Record<string, string[]> })._meta?.["mcp/www_authenticate"] ?? [])[0] ?? "";
    assert.match(runtimeChallenge, /error="invalid_token"/);
    assert.match(runtimeChallenge, /resource_metadata=/);

    const malformed = await mcp(origin, "not-a-jwt", { jsonrpc: "2.0", id: 2, method: "initialize" });
    assert.equal(malformed.status, 401);
    const expired = await mcp(origin, await accessToken(privateKey, issuer, { expiration: "1s ago" }), { jsonrpc: "2.0", id: 3, method: "initialize" });
    assert.equal(expired.status, 401);
    const future = await mcp(origin, await accessToken(privateKey, issuer, { notBefore: "1h" }), { jsonrpc: "2.0", id: 4, method: "initialize" });
    assert.equal(future.status, 401);
    const wrongIssuer = await mcp(origin, await accessToken(privateKey, issuer, { issuer: `${issuer}/other` }), { jsonrpc: "2.0", id: 5, method: "initialize" });
    assert.equal(wrongIssuer.status, 401);
    const wrongAudience = await mcp(origin, await accessToken(privateKey, issuer, { audience: "https://unrelated.example.test" }), { jsonrpc: "2.0", id: 6, method: "initialize" });
    assert.equal(wrongAudience.status, 401);
    const wrongOwner = await mcp(origin, await accessToken(privateKey, issuer, { subject: "auth0|another-user" }), { jsonrpc: "2.0", id: 61, method: "initialize" });
    assert.equal(wrongOwner.status, 401);
    const { privateKey: foreignKey } = await generateKeyPair("RS256");
    const badSignature = await mcp(origin, await accessToken(foreignKey, issuer), { jsonrpc: "2.0", id: 7, method: "initialize" });
    assert.equal(badSignature.status, 401);
    const badType = await mcp(origin, await accessToken(privateKey, issuer, { type: "JWT+invalid" }), { jsonrpc: "2.0", id: 8, method: "initialize" });
    assert.equal(badType.status, 401);

    const limited = await accessToken(privateKey, issuer, { scope: "project:read" });
    const missingScope = await mcp(origin, limited, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_projects", arguments: {} } });
    assert.equal(missingScope.status, 401);
    assert.match(missingScope.headers.get("www-authenticate") ?? "", /scope="projects:list"/);
    assert.match((((missingScope.body.result as { _meta?: Record<string, string[]> })._meta?.["mcp/www_authenticate"] ?? [])[0] ?? ""), /error="insufficient_scope"/);
    const operatorAsMcp = await mcp(origin, "operator-only-token", { jsonrpc: "2.0", id: 91, method: "initialize" });
    assert.equal(operatorAsMcp.status, 401);

    const valid = await accessToken(privateKey, issuer);
    const catalog = await mcp(origin, valid, { jsonrpc: "2.0", id: 10, method: "tools/list" });
    assert.equal(catalog.status, 200);
    const tools = ((catalog.body.result as { tools: Array<{ name: string; securitySchemes?: Array<{ scopes: string[] }> }> }).tools);
    assert.deepEqual(tools.find((tool) => tool.name === "ask_project")?.securitySchemes, [{ type: "oauth2", scopes: ["project:ask"] }]);

    const listed = await mcp(origin, valid, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "list_projects", arguments: {} } });
    assert.deepEqual((((listed.body.result as { structuredContent: { projects: Array<{ slug: string }> } }).structuredContent.projects).map((item) => item.slug)), ["homebound", "homegift"]);
    const state = await mcp(origin, valid, { jsonrpc: "2.0", id: 111, method: "tools/call", params: { name: "get_project_state", arguments: { project: "homegift" } } });
    assert.equal(state.status, 200);
    const giftAsk = await mcp(origin, valid, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "ask_project", arguments: { project: "homegift", question: "Where are donation amount presets defined?" } } });
    assert.equal((giftAsk.body.result as { structuredContent: { project: string } }).structuredContent.project, "homegift");
    const boundAsk = await mcp(origin, valid, { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "ask_project", arguments: { project: "homebound", question: "Where is the transaction fee defined?" } } });
    assert.equal((boundAsk.body.result as { structuredContent: { project: string } }).structuredContent.project, "homebound");
    const search = await mcp(origin, valid, { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "search_project", arguments: { project: "homegift", query: "donation presets" } } });
    assert.equal((search.body.result as { structuredContent: { results: unknown[] } }).structuredContent.results.length, 1);
    const evidence = await mcp(origin, valid, { jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "get_evidence", arguments: { project: "homegift", artifact_id: giftArtifact.id } } });
    assert.equal((evidence.body.result as { structuredContent: { excerpt: string } }).structuredContent.excerpt.includes("neverReturn"), false);
    const excerptSuccess = await mcp(origin, valid, { jsonrpc: "2.0", id: 151, method: "tools/call", params: { name: "get_file_excerpt", arguments: { project: "homegift", path: giftArtifact.path, start_line: 1, end_line: 2 } } });
    assert.equal(excerptSuccess.status, 200);
    assert.equal(JSON.stringify(excerptSuccess.body).includes("neverReturn"), false);
    const excerpt = await mcp(origin, valid, { jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "get_file_excerpt", arguments: { project: "homegift", path: giftArtifact.path, start_line: 1, end_line: 81 } } });
    assert.equal(errorCode(excerpt.body), "excerpt_range_too_large");
    const movements = await mcp(origin, valid, { jsonrpc: "2.0", id: 161, method: "tools/call", params: { name: "get_recent_movements", arguments: { project: "homegift" } } });
    assert.equal(movements.status, 200);
    const crossProject = await mcp(origin, valid, { jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "get_evidence", arguments: { project: "homebound", artifact_id: giftArtifact.id } } });
    assert.equal(errorCode(crossProject.body), "evidence_not_in_project");
    assert.equal(JSON.stringify(crossProject.body).includes(giftArtifact.path), false);
    const reverseCrossProject = await mcp(origin, valid, { jsonrpc: "2.0", id: 171, method: "tools/call", params: { name: "get_evidence", arguments: { project: "homegift", artifact_id: boundArtifact.id } } });
    assert.equal(errorCode(reverseCrossProject.body), "evidence_not_in_project");
    assert.equal(JSON.stringify(reverseCrossProject.body).includes(boundArtifact.path), false);

    const oauthMutation = await fetch(`${origin}/api/projects`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${valid}` }, body: JSON.stringify({ slug: "oauth-nope", name: "OAuth Nope" }) });
    assert.equal(oauthMutation.status, 400);
    assert.equal(store.projects.some((item) => item.slug === "oauth-nope"), false);
    const oauthRefresh = await fetch(`${origin}/api/projects/${homeGift.id}/refresh`, { method: "POST", headers: { authorization: `Bearer ${valid}` } });
    assert.equal(oauthRefresh.status, 400);
    const oauthSourceMutation = await fetch(`${origin}/api/projects/${homeGift.id}/sources`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${valid}` }, body: JSON.stringify({ type: "repository", provider: "github", config: {} }) });
    assert.equal(oauthSourceMutation.status, 400);
    const fixed = await mcp(origin, "fixed-read-token", { jsonrpc: "2.0", id: 18, method: "tools/call", params: { name: "list_projects", arguments: {} } });
    assert.equal(fixed.status, 200);
    const fixedMutation = await fetch(`${origin}/api/projects`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixed-read-token" }, body: JSON.stringify({ slug: "fixed-nope", name: "Fixed Nope" }) });
    assert.equal(fixedMutation.status, 400);
    assert.ok(store.auditEvents.some((event) => event.action === "mcp.read" && event.metadata.authMethod === "oauth"));
    assert.ok(store.auditEvents.some((event) => event.action === "mcp.oauth_token_validation_failed"));
    assert.equal(JSON.stringify(store.auditEvents).includes(valid), false);
    assert.equal(JSON.stringify(store.auditEvents).includes("Where are donation amount presets defined?"), false);
    assert.equal(JSON.stringify(store.auditEvents).includes("donation presets"), false);

    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => jwksServer.close((error) => error ? reject(error) : resolve()));
    for (const key of environmentKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
