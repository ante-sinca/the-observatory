import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { assertBoundedArtifactRead } from "../core/postgres-store.js";
import { ConfigCipher } from "../core/security.js";
import { MemoryStore } from "../core/store.js";
import { createHttpServer } from "../http/server.js";
import { ObservatoryToolService } from "../mcp/tools.js";
import { AskProjectService } from "../services/ask-project.js";
import { ProjectRegistry } from "../services/project-registry.js";
import { PostgresReadService, type PostgresReadClient } from "../services/postgres-read-service.js";
import type { ObservatoryReadService } from "../services/read-service.js";
import { AdapterRegistry, RefreshOrchestrator } from "../services/refresh.js";

class TrackingReads implements ObservatoryReadService {
  calls: string[] = [];
  async listProjects() { this.calls.push("listProjects"); return []; }
  async getProject(_projectRef: string): Promise<never> { this.calls.push("getProject"); throw new Error("not used"); }
  async getProjectState(_projectRef: string): Promise<never> { this.calls.push("getProjectState"); throw new Error("not used"); }
  async getSources() { this.calls.push("getSources"); return []; }
  async getOnboardingSummary() { this.calls.push("getOnboardingSummary"); return { artifactCount: 0, knowledgeCount: 0, provenanceCount: 0, openConflictCount: 0 }; }
  async getKnowledge() { this.calls.push("getKnowledge"); return []; }
  async searchProject() { this.calls.push("searchProject"); return []; }
  async getRecentChanges() { this.calls.push("getRecentChanges"); return []; }
  async getDeployments() { this.calls.push("getDeployments"); return []; }
  async getDecisions() { this.calls.push("getDecisions"); return []; }
  async getKnownRisks() { this.calls.push("getKnownRisks"); return []; }
  async compareSnapshots() { this.calls.push("compareSnapshots"); return []; }
  async getSourceArtifact(_projectRef: string, _artifactId: string): Promise<never> { this.calls.push("getSourceArtifact"); throw new Error("not used"); }
  async sourceArtifactScope() { this.calls.push("sourceArtifactScope"); return "missing" as const; }
  async getCurrentSourceArtifactByPath() { this.calls.push("getCurrentSourceArtifactByPath"); return undefined; }
  async searchCurrentSourceArtifacts() { this.calls.push("searchCurrentSourceArtifacts"); return []; }
  async getSnapshots() { this.calls.push("getSnapshots"); return []; }
  async getSnapshot(_projectRef: string, _snapshotId: string): Promise<never> { this.calls.push("getSnapshot"); throw new Error("not used"); }
  async getConflicts() { this.calls.push("getConflicts"); return []; }
  async getRefreshRuns() { this.calls.push("getRefreshRuns"); return []; }
}

test("health endpoints require zero Observatory durable reads", async () => {
  const store = new MemoryStore();
  const reads = new TrackingReads();
  const registry = new ProjectRegistry(store, ConfigCipher.fromEnvironment());
  const refresh = new RefreshOrchestrator(store, new AdapterRegistry());
  const server = createHttpServer({ store, registry, refresh, queries: reads, ask: new AskProjectService(store, reads), tools: new ObservatoryToolService(reads) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/assistant/health`)).status, 200);
    assert.deepEqual(reads.calls, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("durable reader keeps project summaries and state artifact-body free", async () => {
  const calls: Array<{ category: string; sql: string; artifactContent: boolean }> = [];
  const database: PostgresReadClient = {
    async queryRead(category, sql, _values, artifactContent = false) {
      calls.push({ category, sql, artifactContent });
      if (category === "project_summary") return [{ id: "p1", slug: "homegift", name: "HomeGift", repositoryRevision: "r1", deploymentRevision: null, lastRefreshAt: "2026-09-26T00:00:00.000Z", unresolvedConflictCount: 0, recentMovementCount: 0 }];
      if (category === "project") return [{ id: "p1", slug: "homegift", name: "HomeGift", description: null, status: "active", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }];
      if (category === "latest_snapshot") return [{ id: "s1", projectId: "p1", createdAt: "2026-09-26T00:00:00.000Z", repositoryRevision: "r1", deploymentRevision: null, sourceHealth: {}, summary: { knowledgeCount: 1, byType: {}, resolution: "resolved" } }];
      return [];
    },
  };
  const reads = new PostgresReadService(database);
  assert.equal((await reads.listProjects())[0]?.slug, "homegift");
  assert.equal((await reads.getProjectState("homegift")).snapshot?.repositoryRevision, "r1");
  assert.equal(calls.some((call) => call.artifactContent || /content_text/i.test(call.sql)), false);
  const ask = new AskProjectService(new MemoryStore(), reads);
  assert.equal((await ask.ask("homegift", "How much is the platform fee?")).status, "insufficient_evidence");
  await new ObservatoryToolService(reads, ask).call("list_projects");
  const artifactSearch = calls.find((call) => call.category === "artifact_search_excerpt");
  assert.match(artifactSearch?.sql ?? "", /a\.project_id = \$1/i);
  assert.match(artifactSearch?.sql ?? "", /LIMIT \$3/i);
  assert.equal(artifactSearch?.artifactContent, true);
  assert.ok(calls.every((call) => call.category !== "artifact_content"));
});

test("artifact body SQL must be scoped and bounded", async () => {
  assert.throws(() => assertBoundedArtifactRead("SELECT content_text FROM source_artifacts ORDER BY first_seen_at"), /project-scoped and bounded/);
  assert.doesNotThrow(() => assertBoundedArtifactRead("SELECT content_text FROM source_artifacts WHERE project_id = $1 AND id = $2 LIMIT 1"));
  assert.doesNotThrow(() => assertBoundedArtifactRead("SELECT left(a.content_text, 32768) FROM source_artifacts a JOIN LATERAL (SELECT repository_revision FROM snapshots WHERE project_id = $1 LIMIT 1) current ON true WHERE a.project_id = $1 LIMIT $3"));
});
