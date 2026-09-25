import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ConfigCipher } from "../core/security.js";
import { MemoryStore } from "../core/store.js";
import type { KnowledgeItem, Project, Snapshot, SourceArtifact } from "../domain/types.js";
import { createHttpServer } from "../http/server.js";
import { ObservatoryToolService } from "../mcp/tools.js";
import { AskProjectService } from "../services/ask-project.js";
import { ProjectQueryService } from "../services/query.js";
import { ProjectRegistry } from "../services/project-registry.js";
import { AdapterRegistry, RefreshOrchestrator } from "../services/refresh.js";

const observedAt = "2026-09-24T12:00:00.000Z";

function project(id: string, slug: string, name: string): Project {
  return { id, slug, name, status: "active", createdAt: observedAt, updatedAt: observedAt };
}

function artifact(projectId: string, id: string, path: string, content: string, revision: string): SourceArtifact {
  return { id, projectId, sourceId: `${projectId}-source`, externalId: id, path, artifactType: "text", revision, contentHash: `${id}-hash`, content, metadata: {}, firstSeenAt: observedAt, lastSeenAt: observedAt };
}

function knowledge(projectId: string, id: string, title: string): KnowledgeItem {
  return {
    id,
    projectId,
    title,
    body: title,
    type: "implementation",
    status: "current",
    state: { documented: "unknown", implemented: "evidenced", tested: "unknown", deployed: "unknown", observed: "unknown" },
    fingerprint: id,
    entityKey: id,
    createdAt: observedAt,
  };
}

function snapshot(projectId: string, revision: string, knowledgeItemIds: string[]): Snapshot {
  return { id: `${projectId}-snapshot`, projectId, createdAt: observedAt, repositoryRevision: revision, sourceHealth: { [`${projectId}-source`]: { state: "healthy", checkedAt: observedAt } }, summary: { knowledgeCount: knowledgeItemIds.length, byType: { implementation: knowledgeItemIds.length }, resolution: "resolved" }, knowledgeItemIds };
}

async function mcp(origin: string, token: string | undefined, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<{ status: number; cacheControl: string | null; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.json() as Record<string, unknown> };
}

function errorCode(response: Record<string, unknown>): string | undefined {
  return ((response.error as { data?: { code?: string } } | undefined)?.data?.code);
}

test("remote MCP is authenticated, read-only, bounded, isolated, and auditable", async () => {
  const originalReadToken = process.env.OBSERVATORY_MCP_READ_TOKEN;
  const originalOperatorToken = process.env.OBSERVATORY_OPERATOR_TOKEN;
  const originalNodeEnv = process.env.NODE_ENV;
  const readToken = "test-only-mcp-read-token";
  const operatorToken = "test-only-operator-token";
  process.env.OBSERVATORY_MCP_READ_TOKEN = readToken;
  process.env.OBSERVATORY_OPERATOR_TOKEN = operatorToken;

  const store = new MemoryStore();
  const homeGift = project("homegift-id", "homegift", "HomeGift");
  const homeBound = project("homebound-id", "homebound", "HomeBound");
  const homeGiftRevision = "homegift-r3";
  const homeBoundRevision = "homebound-r4";
  const giftArtifact = artifact(homeGift.id, "gift-config", "src/config/donations.ts", "export const donationAmountPresets = [10, 25, 50];\nconst token = doNotExpose;", homeGiftRevision);
  const boundArtifact = artifact(homeBound.id, "bound-fee", "src/fees/transaction.ts", "export const transactionFeeGbp = 2;", homeBoundRevision);
  const giftKnowledge = knowledge(homeGift.id, "gift-knowledge", "Donation amount presets are configured in the donation module.");
  const boundKnowledge = knowledge(homeBound.id, "bound-knowledge", "Transaction fee runtime configuration.");
  store.projects.push(homeGift, homeBound);
  store.artifacts.push(giftArtifact, boundArtifact);
  store.knowledge.push(giftKnowledge, boundKnowledge);
  store.provenance.push(
    { id: "gift-provenance", knowledgeItemId: giftKnowledge.id, sourceArtifactId: giftArtifact.id, sourceType: "repository", sourceRef: giftArtifact.id, repositoryCommit: homeGiftRevision, path: giftArtifact.path, metadata: {} },
    { id: "bound-provenance", knowledgeItemId: boundKnowledge.id, sourceArtifactId: boundArtifact.id, sourceType: "repository", sourceRef: boundArtifact.id, repositoryCommit: homeBoundRevision, path: boundArtifact.path, metadata: {} },
  );
  store.snapshots.push(snapshot(homeGift.id, homeGiftRevision, [giftKnowledge.id]), snapshot(homeBound.id, homeBoundRevision, [boundKnowledge.id]));
  const queries = new ProjectQueryService(store);
  const ask = new AskProjectService(store, queries);
  const server = createHttpServer({
    store,
    registry: new ProjectRegistry(store, ConfigCipher.fromEnvironment()),
    refresh: new RefreshOrchestrator(store, new AdapterRegistry()),
    queries,
    ask,
    tools: new ObservatoryToolService(queries, ask),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const missing = await mcp(origin, undefined, { jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(missing.status, 401);
    assert.equal(errorCode(missing.body), "unauthorized");
    assert.equal(missing.cacheControl, "no-store");

    const operator = await mcp(origin, operatorToken, { jsonrpc: "2.0", id: 2, method: "initialize" });
    assert.equal(operator.status, 401);
    assert.equal(errorCode(operator.body), "unauthorized");

    const initialized = await mcp(origin, readToken, { jsonrpc: "2.0", id: 3, method: "initialize" });
    assert.equal(initialized.status, 200);
    assert.equal((initialized.body.result as { protocolVersion?: string }).protocolVersion, "2025-03-26");

    const catalog = await mcp(origin, readToken, { jsonrpc: "2.0", id: 4, method: "tools/list" });
    const tools = ((catalog.body.result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }> }).tools);
    assert.deepEqual(tools.map((tool) => tool.name), ["list_projects", "get_project_state", "search_project", "get_evidence", "get_file_excerpt", "get_recent_movements", "ask_project"]);
    assert.equal(tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint), true);

    const listed = await mcp(origin, readToken, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_projects", arguments: {} } });
    assert.deepEqual((((listed.body.result as { structuredContent: { projects: Array<{ slug: string }> } }).structuredContent.projects).map((item) => item.slug)), ["homebound", "homegift"]);

    const giftAsk = await mcp(origin, readToken, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ask_project", arguments: { project: "homegift", question: "Where are donation amount presets defined?" } } });
    assert.equal(((giftAsk.body.result as { structuredContent: { project: string } }).structuredContent.project), "homegift");
    assert.equal(JSON.stringify(giftAsk.body).includes("Where are donation amount presets defined?"), false);

    const boundAsk = await mcp(origin, readToken, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ask_project", arguments: { project: "homebound", question: "Where is the transaction fee defined?" } } });
    assert.equal(((boundAsk.body.result as { structuredContent: { project: string } }).structuredContent.project), "homebound");

    const search = await mcp(origin, readToken, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "search_project", arguments: { project: "homegift", query: "donation presets" } } });
    const searchResult = (search.body.result as { structuredContent: { repositoryRevision?: string; results: Array<{ evidence: Array<{ path?: string }> }> } }).structuredContent;
    assert.equal(searchResult.repositoryRevision, homeGiftRevision);
    assert.equal(searchResult.results[0]?.evidence[0]?.path, giftArtifact.path);

    const evidence = await mcp(origin, readToken, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_evidence", arguments: { project: "homegift", artifact_id: giftArtifact.id } } });
    const evidenceResult = (evidence.body.result as { structuredContent: { excerpt: string; path: string; repositoryRevision: string } }).structuredContent;
    assert.equal(evidenceResult.path, giftArtifact.path);
    assert.equal(evidenceResult.repositoryRevision, homeGiftRevision);
    assert.equal(evidenceResult.excerpt.includes("doNotExpose"), false);

    const crossProject = await mcp(origin, readToken, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "get_evidence", arguments: { project: "homebound", artifact_id: giftArtifact.id } } });
    assert.equal(crossProject.status, 200);
    assert.equal(errorCode(crossProject.body), "evidence_not_in_project");
    assert.equal(JSON.stringify(crossProject.body).includes(giftArtifact.path), false);

    const traversal = await mcp(origin, readToken, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "get_file_excerpt", arguments: { project: "homegift", path: "../src/config/donations.ts" } } });
    assert.equal(errorCode(traversal.body), "invalid_path");

    const tooLarge = await mcp(origin, readToken, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "get_file_excerpt", arguments: { project: "homegift", path: giftArtifact.path, start_line: 1, end_line: 81 } } });
    assert.equal(errorCode(tooLarge.body), "excerpt_range_too_large");

    const invalidQuestion = await mcp(origin, readToken, { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "ask_project", arguments: { project: "homegift", question: " " } } });
    assert.equal(errorCode(invalidQuestion.body), "invalid_question");

    const invalidQuery = await mcp(origin, readToken, { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "search_project", arguments: { project: "homegift", query: "x".repeat(501) } } });
    assert.equal(errorCode(invalidQuery.body), "invalid_query");

    const mutation = await fetch(`${origin}/api/projects`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${readToken}` }, body: JSON.stringify({ slug: "nope", name: "Nope" }) });
    assert.equal(mutation.status, 400);
    assert.equal(store.projects.some((item) => item.slug === "nope"), false);
    assert.ok(store.auditEvents.some((event) => event.action === "mcp.read" && event.metadata.credentialClass === "mcp_read"));
    assert.equal(JSON.stringify(store.auditEvents).includes("Where are donation amount presets defined?"), false);

    process.env.NODE_ENV = "production";
    const insecureProduction = await mcp(origin, readToken, { jsonrpc: "2.0", id: 15, method: "initialize" });
    assert.equal(insecureProduction.status, 401);
    const secureProduction = await mcp(origin, readToken, { jsonrpc: "2.0", id: 16, method: "initialize" }, { "x-forwarded-proto": "https" });
    assert.equal(secureProduction.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (originalReadToken === undefined) delete process.env.OBSERVATORY_MCP_READ_TOKEN; else process.env.OBSERVATORY_MCP_READ_TOKEN = originalReadToken;
    if (originalOperatorToken === undefined) delete process.env.OBSERVATORY_OPERATOR_TOKEN; else process.env.OBSERVATORY_OPERATOR_TOKEN = originalOperatorToken;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
  }
});
