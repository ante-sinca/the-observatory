import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { MemoryStore } from "../core/store.js";
import { createHttpServer } from "../http/server.js";
import { ObservatoryToolService } from "../mcp/tools.js";
import { AskProjectService } from "../services/ask-project.js";
import { ProjectQueryService } from "../services/query.js";
import { ProjectRegistry } from "../services/project-registry.js";
import { AdapterRegistry, RefreshOrchestrator } from "../services/refresh.js";
import { ConfigCipher } from "../core/security.js";
import type { Conflict, KnowledgeItem, Project, Snapshot, SourceArtifact } from "../domain/types.js";

const observedAt = "2026-09-24T10:00:00.000Z";

function artifact(projectId: string, id: string, path: string, content: string, revision: string): SourceArtifact {
  return { id, projectId, sourceId: `${projectId}-source`, externalId: id, path, artifactType: "text", revision, contentHash: `${id}-hash`, content, metadata: {}, firstSeenAt: observedAt, lastSeenAt: observedAt };
}

function project(id: string, slug: string, name: string): Project {
  return { id, slug, name, status: "active", createdAt: observedAt, updatedAt: observedAt };
}

function snapshot(projectId: string, revision: string, knowledgeItemIds: string[] = []): Snapshot {
  return { id: `${projectId}-snapshot`, projectId, createdAt: observedAt, repositoryRevision: revision, sourceHealth: { [`${projectId}-source`]: { state: "healthy", checkedAt: observedAt } }, summary: { knowledgeCount: knowledgeItemIds.length, byType: {}, resolution: "resolved" }, knowledgeItemIds };
}

function knowledge(projectId: string, id: string, title: string, type: KnowledgeItem["type"] = "implementation"): KnowledgeItem {
  return { id, projectId, type, title, body: title, status: "current", state: { documented: "unknown", implemented: type === "implementation" ? "evidenced" : "unknown", tested: type === "test_evidence" ? "evidenced" : "unknown", deployed: "unknown", observed: "unknown" }, fingerprint: id, entityKey: id, createdAt: observedAt };
}

function setup(withConflict = false) {
  const store = new MemoryStore();
  const homeGift = project("homegift-id", "homegift", "HomeGift");
  const homeBound = project("homebound-id", "homebound", "HomeBound");
  store.projects.push(homeGift, homeBound);
  const homeGiftRevision = "homegift-r2";
  const homeBoundRevision = "homebound-r7";
  store.artifacts.push(
    artifact(homeGift.id, "hg-config", "src/config/donations.ts", "export const donationAmountPresets = [10, 25, 50];\nexport const platformServiceFee = 3;", homeGiftRevision),
    artifact(homeGift.id, "hg-runtime", "src/billing/fees.ts", "export function calculateServiceFee(amount: number) { return amount * platformServiceFee; }", homeGiftRevision),
    artifact(homeGift.id, "hg-history", "migrations/049_donation_presets.sql", "INSERT INTO donation_presets (amount) VALUES (10), (25), (50);", homeGiftRevision),
    artifact(homeGift.id, "hg-test", "tests/donation-presets.test.ts", "test('donation amount presets are presented', () => expect(donationAmountPresets).toContain(25));", homeGiftRevision),
    artifact(homeGift.id, "hg-doc", "docs/fees.md", "# Fees\nThe donation service fee is documented for operators.", homeGiftRevision),
    artifact(homeGift.id, "hg-redaction", "src/config/private-values.ts", "const token = secretValue;\nexport const donationPresetLabel = 'Suggested';", homeGiftRevision),
    artifact(homeBound.id, "hb-runtime", "src/fees/transaction.ts", "export const transactionFeeGbp = 2;\nexport function completePhpPayout() { return 'complete'; }", homeBoundRevision),
    artifact(homeBound.id, "hb-rate", "src/rates/daily-gbp-php.ts", "export const dailyGbpPhpRate = fetchDailyRate();", homeBoundRevision),
  );
  const giftItems = [knowledge(homeGift.id, "hg-config-item", "Donation amount preset configuration"), knowledge(homeGift.id, "hg-runtime-item", "Service fee runtime"), knowledge(homeGift.id, "hg-history-item", "Donation preset migration"), knowledge(homeGift.id, "hg-test-item", "Donation preset tests", "test_evidence")];
  const boundItems = [knowledge(homeBound.id, "hb-fee-item", "Transaction fee runtime"), knowledge(homeBound.id, "hb-rate-item", "Daily GBP PHP rate")];
  store.knowledge.push(...giftItems, ...boundItems);
  for (const item of giftItems) {
    const artifactId = item.id.replace("-item", "");
    store.provenance.push({ id: `${item.id}-provenance`, knowledgeItemId: item.id, sourceArtifactId: artifactId, sourceType: "repository", sourceRef: artifactId, repositoryCommit: homeGiftRevision, path: store.artifacts.find((candidate) => candidate.id === artifactId)?.path, metadata: {} });
  }
  for (const item of boundItems) {
    const artifactId = item.id === "hb-fee-item" ? "hb-runtime" : "hb-rate";
    store.provenance.push({ id: `${item.id}-provenance`, knowledgeItemId: item.id, sourceArtifactId: artifactId, sourceType: "repository", sourceRef: artifactId, repositoryCommit: homeBoundRevision, path: store.artifacts.find((candidate) => candidate.id === artifactId)?.path, metadata: {} });
  }
  store.snapshots.push(snapshot(homeGift.id, homeGiftRevision, giftItems.map((item) => item.id)), snapshot(homeBound.id, homeBoundRevision, boundItems.map((item) => item.id)));
  if (withConflict) {
    const conflict: Conflict = { id: "fee-conflict", projectId: homeGift.id, snapshotId: "homegift-id-snapshot", type: "evidence_mismatch", severity: "high", title: "Donation preset values disagree", description: "Current documentation and implementation assert different donation preset values.", evidence: { key: "donation preset" }, status: "open" };
    store.conflicts.push(conflict);
  }
  const queries = new ProjectQueryService(store);
  const ask = new AskProjectService(store, queries);
  return { store, queries, ask, homeGift, homeBound };
}

test("AskProjectService ranks current scoped evidence and expands related fee terms", async () => {
  const { ask } = setup();
  const presets = await ask.ask("homegift", "Where are donation amount presets defined?");
  assert.equal(presets.status, "verified_current");
  assert.equal(presets.repositoryRevision, "homegift-r2");
  assert.ok(presets.evidence.some((item) => item.path === "src/config/donations.ts" && item.startLine === 1));
  assert.ok(presets.evidence.every((item) => !item.path?.startsWith("src/fees/transaction")));
  assert.ok(presets.answer.includes("src/config/donations.ts"));

  const fees = await ask.ask("homegift", "How are platform fees configured?");
  assert.equal(fees.status, "verified_current");
  assert.equal(fees.evidence[0]?.role, "configuration");
  assert.ok(fees.evidence.some((item) => item.path === "src/billing/fees.ts"));

  const behaviour = await ask.ask("homegift", "How does the service fee calculation work?");
  assert.equal(behaviour.evidence[0]?.role, "runtime_implementation");
});

test("AskProjectService keeps HomeGift and HomeBound evidence isolated", async () => {
  const { ask } = setup();
  const response = await ask.ask("homebound", "Where is the transaction fee defined?");
  assert.equal(response.status, "verified_current");
  assert.equal(response.repositoryRevision, "homebound-r7");
  assert.ok(response.evidence.some((item) => item.path === "src/fees/transaction.ts"));
  assert.ok(response.evidence.every((item) => !item.path?.startsWith("src/" ) || item.path.startsWith("src/fees/") || item.path.startsWith("src/rates/")));
  assert.equal(response.evidence.some((item) => item.path?.includes("donations")), false);
});

test("AskProjectService applies intent-aware ranking for history, tests, and change paths", async () => {
  const { ask } = setup();
  const history = await ask.ask("homegift", "Where were donation presets introduced?");
  assert.equal(history.evidence[0]?.path, "migrations/049_donation_presets.sql");
  assert.equal(history.evidence[0]?.role, "historical_configuration");

  const tests = await ask.ask("homegift", "Which tests cover donation amount presets?");
  assert.equal(tests.status, "verified_current");
  assert.equal(tests.evidence[0]?.role, "test");
  assert.equal(tests.evidence[0]?.path, "tests/donation-presets.test.ts");

  const change = await ask.ask("homegift", "Where would I change donation amount presets safely?");
  assert.equal(change.status, "verified_current");
  assert.ok(change.evidence.some((item) => item.path === "src/config/donations.ts"));
  assert.ok(change.evidence.some((item) => item.path === "migrations/049_donation_presets.sql"));
  assert.match(change.answer, /origin only/i);
});

test("AskProjectService reports insufficient evidence, conflicts, and redacts selected source lines", async () => {
  const plain = setup();
  const missing = await plain.ask.ask("homegift", "Where is the satellite telemetry feature configured?");
  assert.equal(missing.status, "insufficient_evidence");
  assert.equal(missing.answer, "Observatory cannot verify this from the currently indexed evidence.");
  const redacted = await plain.ask.ask("homegift", "Where is the donation preset label configured?");
  assert.equal(redacted.answer.includes("secretValue"), false);

  const conflicted = setup(true);
  const response = await conflicted.ask.ask("homegift", "Where are donation presets defined?");
  assert.equal(response.status, "conflicted");
  assert.equal(response.conflicts.length, 1);
  assert.match(response.answer, /cannot verify a single answer/i);
});

test("Ask browser page and API enforce the stable, bounded read-only contract", async () => {
  const { store, queries, ask } = setup();
  const services = {
    registry: new ProjectRegistry(store, ConfigCipher.fromEnvironment()),
    refresh: new RefreshOrchestrator(store, new AdapterRegistry()),
    queries,
    ask,
    tools: new ObservatoryToolService(queries, ask),
  };
  const server = createHttpServer(services);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${origin}/projects/homegift/ask`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Ask HomeGift/);
    assert.match(html, /Project: <strong>HomeGift<\/strong>/);
    assert.match(html, /HomeBound/);
    assert.match(html, />Ask<\/a>/);
    assert.equal(page.headers.get("cache-control"), "no-store");

    const api = await fetch(`${origin}/api/projects/homegift/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Where are donation amount presets defined?" }) });
    assert.equal(api.status, 200);
    assert.equal((await api.json() as { project: string; evidence: unknown[] }).project, "homegift");

    const mcp = await fetch(`${origin}/mcp/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ask_project", arguments: { project: "homegift", question: "Where are donation amount presets defined?" } }) });
    assert.equal(mcp.status, 200);
    assert.equal((await mcp.json() as { result: { project: string } }).result.project, "homegift");

    const empty = await fetch(`${origin}/api/projects/homegift/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "  " }) });
    assert.equal(empty.status, 400);
    const large = await fetch(`${origin}/api/projects/homegift/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "x".repeat(2_001) }) });
    assert.equal(large.status, 400);
    const unknown = await fetch(`${origin}/api/projects/no-such-project/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "Where is it?" }) });
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
