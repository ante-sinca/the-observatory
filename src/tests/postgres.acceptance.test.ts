import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ConfigCipher } from "../core/security.js";
import { PostgresStore } from "../core/postgres-store.js";
import { databaseUrlFromEnvironment, verifiedPostgresUrl } from "../core/store.js";
import { createHttpServer } from "../http/server.js";
import { ObservatoryToolService } from "../mcp/tools.js";
import { AdapterRegistry, RefreshOrchestrator } from "../services/refresh.js";
import { ProjectRegistry } from "../services/project-registry.js";
import { ProjectQueryService } from "../services/query.js";
import { AskProjectService } from "../services/ask-project.js";
import { runMigrations } from "../core/migrations.js";
import type { ArtifactContent, DeploymentAdapter, DeploymentRecord, HealthResult, RefreshRun, Snapshot, SourceAdapter, SourceArtifact, SourceArtifactRef, SourceConfig, SourceRevision } from "../domain/types.js";

class RepositoryFixture implements SourceAdapter {
  readonly kind: string;
  revision = "r1";
  files = new Map<string, string>();
  blobIds = new Map<string, string>();
  constructor(kind = "postgres-fixture") { this.kind = kind; }
  async healthCheck(): Promise<HealthResult> { return { state: "healthy", checkedAt: "2026-09-23T00:00:00.000Z" }; }
  async getRevision(): Promise<SourceRevision> { return { value: this.revision, observedAt: "2026-09-23T00:00:00.000Z" }; }
  async listArtifacts(): Promise<SourceArtifactRef[]> { return [...this.files].map(([path, content]) => ({ externalId: this.blobIds.get(path) ?? `${this.revision}:${path}`, path, artifactType: "text", size: Buffer.byteLength(content) })); }
  async readArtifact(_config: SourceConfig, artifact: SourceArtifactRef): Promise<ArtifactContent> { const content = this.files.get(artifact.path); if (!content) throw new Error("fixture artifact missing"); return { content, encoding: "utf8" }; }
}

class FailingDeploymentFixture implements DeploymentAdapter {
  readonly kind = "postgres-failing-deployment";
  async healthCheck(): Promise<HealthResult> { return { state: "healthy", checkedAt: "2026-09-23T00:00:00.000Z" }; }
  async getCurrentDeployment(): Promise<DeploymentRecord | null> { throw new Error("deliberate deployment outage"); }
  async listRecentDeployments(): Promise<DeploymentRecord[]> { return []; }
}

const connectionString = process.env.OBSERVATORY_TEST_DATABASE_URL;
const cipher = new ConfigCipher(Buffer.alloc(32, 7));

test("missing PostgreSQL configuration is rejected before production startup", async () => {
  assert.equal(databaseUrlFromEnvironment({}), undefined);
  assert.match(verifiedPostgresUrl("postgresql://user:pass@host.example/db?sslmode=require"), /sslmode=verify-full/);
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalConfigKey = process.env.OBSERVATORY_CONFIG_KEY;
  try {
    process.env.NODE_ENV = "production";
    process.env.OBSERVATORY_CONFIG_KEY = Buffer.alloc(32, 9).toString("base64");
    delete process.env.DATABASE_URL;
    const { createObservatory } = await import("../index.js");
    await assert.rejects(() => createObservatory(), /PostgreSQL connection is required/);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalConfigKey === undefined) delete process.env.OBSERVATORY_CONFIG_KEY; else process.env.OBSERVATORY_CONFIG_KEY = originalConfigKey;
  }
});

test("PostgreSQL artifact identity keeps shared Git blobs distinct by path", { skip: connectionString ? false : "Set OBSERVATORY_TEST_DATABASE_URL only for the dedicated Observatory Neon database." }, async () => {
  await runMigrations({ connectionString });
  const suffix = randomUUID().slice(0, 8);
  const repository = new RepositoryFixture(`postgres-shared-blob-${suffix}`);
  const sharedContent = "# Shared blob\nEvidence retained at two independent repository paths.";
  repository.files.set("docs/alpha.md", sharedContent);
  repository.files.set("docs/beta.md", sharedContent);
  repository.blobIds.set("docs/alpha.md", "shared-git-blob-sha");
  repository.blobIds.set("docs/beta.md", "shared-git-blob-sha");
  const adapters = new AdapterRegistry().registerRepository(repository);
  const first = new PostgresStore(cipher, connectionString);
  await first.ready();
  const registry = new ProjectRegistry(first, cipher);
  const project = await registry.createProject({ slug: `shared-blob-${suffix}`, name: `Shared blob ${suffix}` });
  const source = await registry.addSource(project.id, { type: "repository", provider: repository.kind, config: { readOnly: true } });
  const refresh = new RefreshOrchestrator(first, adapters);
  const initial = await refresh.refresh(project.id);
  assert.ok(initial.snapshot);
  const initialSnapshotId = initial.snapshot!.id;
  const artifacts = first.artifacts.filter((artifact) => artifact.sourceId === source.id);
  assert.equal(artifacts.length, 2);
  assert.deepEqual(artifacts.map((artifact) => artifact.path).sort(), ["docs/alpha.md", "docs/beta.md"]);
  assert.deepEqual([...new Set(artifacts.map((artifact) => artifact.externalId))], ["shared-git-blob-sha"]);
  const provenancePaths = new ProjectQueryService(first).getKnowledge(project.id).flatMap((record) => record.provenance.map((provenance) => provenance.path)).filter((path): path is string => Boolean(path)).sort();
  assert.deepEqual(provenancePaths, ["docs/alpha.md", "docs/beta.md"]);

  const duplicate = await refresh.refresh(project.id);
  assert.equal(duplicate.idempotent, true);
  assert.equal(first.artifacts.filter((artifact) => artifact.sourceId === source.id).length, 2);
  assert.equal(first.snapshots.filter((snapshot) => snapshot.projectId === project.id).length, 1);
  await first.close();

  // A newly hydrated application instance reaches the same identity and
  // leaves the original immutable snapshot and artifact provenance unchanged.
  const second = new PostgresStore(cipher, connectionString);
  await second.ready();
  const secondRefresh = new RefreshOrchestrator(second, adapters);
  const afterRestart = await secondRefresh.refresh(project.id);
  assert.equal(afterRestart.idempotent, true);
  assert.equal(second.artifacts.filter((artifact) => artifact.sourceId === source.id).length, 2);
  assert.equal(new ProjectQueryService(second).getProjectState(project.id).snapshot?.id, initialSnapshotId);

  // The durable store flush is one transaction. A source/project isolation
  // violation staged after a run and snapshot must roll the whole transition
  // back, not leave a partial run or snapshot in PostgreSQL.
  const persistedRunCount = second.refreshRuns.filter((run) => run.projectId === project.id).length;
  const persistedSnapshotCount = second.snapshots.filter((snapshot) => snapshot.projectId === project.id).length;
  const persistedArtifactCount = second.artifacts.filter((artifact) => artifact.sourceId === source.id).length;
  const now = "2026-09-24T00:00:00.000Z";
  second.refreshRuns.push({ id: randomUUID(), projectId: project.id, startedAt: now, completedAt: now, status: "failed", sourceRevisions: {}, errors: [{ message: "forced transaction rollback" }] } satisfies RefreshRun);
  second.snapshots.push(Object.freeze({ id: randomUUID(), projectId: project.id, createdAt: now, sourceHealth: {}, summary: { knowledgeCount: 0, byType: {}, resolution: "uncertain" }, knowledgeItemIds: [] }) as Snapshot);
  second.artifacts.push({ id: randomUUID(), projectId: randomUUID(), sourceId: source.id, externalId: "rollback-blob", path: "docs/rollback.md", artifactType: "text", revision: "r1", contentHash: "rollback-hash", content: "rollback", metadata: {}, firstSeenAt: now, lastSeenAt: now } satisfies SourceArtifact);
  await assert.rejects(() => second.flush(), /source artifact project does not match source project/);
  await second.close();

  const third = new PostgresStore(cipher, connectionString);
  await third.ready();
  assert.equal(third.refreshRuns.filter((run) => run.projectId === project.id).length, persistedRunCount);
  assert.equal(third.snapshots.filter((snapshot) => snapshot.projectId === project.id).length, persistedSnapshotCount);
  assert.equal(third.artifacts.filter((artifact) => artifact.sourceId === source.id).length, persistedArtifactCount);
  assert.equal(new ProjectQueryService(third).getProjectState(project.id).snapshot?.id, initialSnapshotId);
  await third.close();
});

test("PostgreSQL durable-store release gates", { skip: connectionString ? false : "Set OBSERVATORY_TEST_DATABASE_URL only for the dedicated Observatory Neon database." }, async () => {
  await runMigrations({ connectionString });
  const suffix = randomUUID().slice(0, 8);
  const repository = new RepositoryFixture();
  repository.files.set("README.md", "# Durable state\nAPI_KEY=source-material-secret\nEvidence is preserved.");
  const adapters = new AdapterRegistry().registerRepository(repository).registerDeployment(new FailingDeploymentFixture());
  const first = new PostgresStore(cipher, connectionString);
  await first.ready();
  const registry = new ProjectRegistry(first, cipher);
  const refresh = new RefreshOrchestrator(first, adapters);
  const project = await registry.createProject({ slug: `durability-${suffix}`, name: `Durability ${suffix}` });
  const source = await registry.addSource(project.id, { type: "repository", provider: repository.kind, config: { token: "durability-token-do-not-store", readOnly: true } });
  const initial = await refresh.refresh(project.id);
  assert.ok(initial.snapshot);
  assert.equal(JSON.stringify(first.artifacts).includes("source-material-secret"), false);
  assert.equal(JSON.stringify(first.knowledge).includes("source-material-secret"), false);
  assert.equal(source.encryptedConfig.includes("durability-token-do-not-store"), false);
  await first.close();

  // A new store instance reads canonical state only from PostgreSQL.
  const second = new PostgresStore(cipher, connectionString);
  await second.ready();
  const secondQueries = new ProjectQueryService(second);
  const restored = secondQueries.getProjectState(project.id);
  assert.equal(restored.snapshot?.id, initial.snapshot?.id);
  assert.equal(secondQueries.searchProject(project.id, "evidence")[0]?.provenance[0]?.path, "README.md");
  assert.equal(Object.isFrozen(restored.snapshot), true);

  // HTTP and HTTP MCP read that same newly hydrated service state.
  const secondRegistry = new ProjectRegistry(second, cipher);
  const secondRefresh = new RefreshOrchestrator(second, adapters);
  const ask = new AskProjectService(second, secondQueries);
  const tools = new ObservatoryToolService(secondQueries, ask);
  const server = createHttpServer({ registry: secondRegistry, refresh: secondRefresh, queries: secondQueries, ask, tools });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const state = await fetch(`http://127.0.0.1:${port}/api/projects/${project.slug}`).then(async (response) => ({ status: response.status, value: await response.json() }));
    assert.equal(state.status, 200);
    assert.equal((state.value as { snapshot?: { id?: string } }).snapshot?.id, initial.snapshot?.id);
    assert.equal((tools.call("search_project", { project: project.id, query: "evidence" }) as unknown[]).length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  await second.close();

  // The same source refresh after restart is idempotent. A changed revision
  // creates a second immutable snapshot without modifying the first.
  const third = new PostgresStore(cipher, connectionString);
  await third.ready();
  const thirdRefresh = new RefreshOrchestrator(third, adapters);
  const duplicate = await thirdRefresh.refresh(project.id);
  assert.equal(duplicate.idempotent, true);
  repository.revision = "r2";
  repository.files.set("README.md", "# Durable state\nAPI_KEY=source-material-secret\nUpdated evidence.");
  const changed = await thirdRefresh.refresh(project.id);
  assert.ok(changed.snapshot);
  assert.notEqual(changed.snapshot?.id, initial.snapshot?.id);
  await third.close();

  const fourth = new PostgresStore(cipher, connectionString);
  await fourth.ready();
  const fourthQueries = new ProjectQueryService(fourth);
  assert.deepEqual(fourthQueries.getSnapshot(project.id, initial.snapshot!.id).knowledgeItemIds, initial.snapshot!.knowledgeItemIds);
  assert.ok(fourthQueries.compareSnapshots(project.id, initial.snapshot!.id, changed.snapshot!.id).some((movement) => movement.movementType === "changed"));

  // A second project cannot see the first project's data.
  const fourthRegistry = new ProjectRegistry(fourth, cipher);
  const isolated = await fourthRegistry.createProject({ slug: `isolated-${suffix}`, name: `Isolated ${suffix}` });
  await fourthRegistry.addSource(isolated.id, { type: "repository", provider: repository.kind, config: { readOnly: true } });
  await new RefreshOrchestrator(fourth, adapters).refresh(isolated.id);
  assert.equal(fourthQueries.getKnowledge(project.id).every((item) => item.item.projectId === project.id), true);
  assert.equal(fourthQueries.getKnowledge(isolated.id).every((item) => item.item.projectId === isolated.id), true);

  // A partial source refresh does not delete healthy-source evidence, and its
  // conflict remains present after another fresh store instance is created.
  await fourthRegistry.addSource(project.id, { type: "deployment", provider: "postgres-failing-deployment", config: { readOnly: true } });
  const partial = await new RefreshOrchestrator(fourth, adapters).refresh(project.id);
  assert.equal(partial.run.status, "partial");
  assert.ok(fourthQueries.searchProject(project.id, "updated evidence").length > 0);

  // Re-running the ledger is a no-op once every checksum is recorded.
  const rerun = await runMigrations({ connectionString });
  assert.deepEqual(rerun.applied, []);
  await fourth.close();

  const fifth = new PostgresStore(cipher, connectionString);
  await fifth.ready();
  const fifthQueries = new ProjectQueryService(fifth);
  assert.ok(fifthQueries.getConflicts(project.id).some((conflict) => conflict.type === "source_unavailable"));
  assert.ok(fifthQueries.searchProject(project.id, "updated evidence").length > 0);
  await fifth.close();
});
