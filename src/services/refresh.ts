import { randomUUID } from "node:crypto";
import { isAllowedArtifact, safeText, sha256 } from "../core/security.js";
import type { ObservatoryStore } from "../core/store.js";
import type {
  Conflict,
  Deployment,
  DeploymentAdapter,
  HealthResult,
  KnowledgeItem,
  Movement,
  ProjectSource,
  RefreshRun,
  Snapshot,
  SourceAdapter,
  SourceArtifact,
} from "../domain/types.js";
import { extractKnowledge, materializeExtracted } from "./extractor.js";

export class AdapterRegistry {
  private readonly repositories = new Map<string, SourceAdapter>();
  private readonly deployments = new Map<string, DeploymentAdapter>();

  registerRepository(adapter: SourceAdapter): this {
    this.repositories.set(adapter.kind, adapter);
    return this;
  }

  registerDeployment(adapter: DeploymentAdapter): this {
    this.deployments.set(adapter.kind, adapter);
    return this;
  }

  repository(provider: string): SourceAdapter | undefined { return this.repositories.get(provider); }
  deployment(provider: string): DeploymentAdapter | undefined { return this.deployments.get(provider); }
}

export interface RefreshResult {
  run: RefreshRun;
  snapshot?: Snapshot;
  idempotent: boolean;
}

function healthComparable(health: Record<string, HealthResult>): Record<string, Pick<HealthResult, "state" | "message">> {
  return Object.fromEntries(Object.entries(health).map(([id, result]) => [id, { state: result.state, message: result.message }]));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compactItem(item: KnowledgeItem): Record<string, unknown> {
  return { id: item.id, type: item.type, title: item.title, fingerprint: item.fingerprint, state: item.state };
}

const DEFAULT_EXCLUDES = ["node_modules/**", ".next/**", "build/**", "coverage/**", "dist/**", "*.map"];

/** Runs the whole read-only pipeline. No adapter in this service has a write method. */
export class RefreshOrchestrator {
  constructor(
    private readonly store: ObservatoryStore,
    private readonly adapters: AdapterRegistry,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async refresh(projectId: string): Promise<RefreshResult> {
    if (!this.store.projects.some((project) => project.id === projectId)) throw new Error(`Project '${projectId}' was not found.`);
    const startedAt = this.clock().toISOString();
    const run: RefreshRun = { id: randomUUID(), projectId, startedAt, status: "running", sourceRevisions: {}, errors: [] };
    this.store.refreshRuns.push(run);

    const sourceHealth: Record<string, HealthResult> = {};
    const sourceSuccess = new Set<string>();
    const currentItemIds = new Set<string>();
    let repositoryRevision: string | undefined;
    let deploymentRevision: string | undefined;
    const sources = this.store.sources.filter((source) => source.projectId === projectId && source.enabled);

    for (const source of sources) {
      if (source.type === "repository") {
        const result = await this.refreshRepository(projectId, source, run, currentItemIds, sourceHealth);
        if (result.success) {
          sourceSuccess.add(source.id);
          if (!repositoryRevision) repositoryRevision = result.revision;
        }
      } else {
        const result = await this.refreshDeployment(projectId, source, run, currentItemIds, sourceHealth);
        if (result.success) {
          sourceSuccess.add(source.id);
          if (!deploymentRevision) deploymentRevision = result.revision;
        }
      }
    }

    // A failed source must not erase last known knowledge from a successful
    // earlier scan. Retain it in this snapshot and mark the source unhealthy.
    const previous = this.latestSnapshot(projectId);
    if (previous) {
      for (const itemId of previous.knowledgeItemIds) {
        const sourceId = this.store.provenance.find((provenance) => provenance.knowledgeItemId === itemId)?.sourceArtifactId;
        const source = sourceId ? this.store.artifacts.find((artifact) => artifact.id === sourceId)?.sourceId : undefined;
        if (source && !sourceSuccess.has(source)) currentItemIds.add(itemId);
      }
    }

    const knowledgeIds = [...currentItemIds].sort();
    const previousComparable = previous && {
      knowledgeItemIds: [...previous.knowledgeItemIds].sort(),
      repositoryRevision: previous.repositoryRevision,
      deploymentRevision: previous.deploymentRevision,
      sourceHealth: healthComparable(previous.sourceHealth),
    };
    const nextComparable = { knowledgeItemIds: knowledgeIds, repositoryRevision, deploymentRevision, sourceHealth: healthComparable(sourceHealth) };
    const unchanged = previousComparable !== undefined && stable(previousComparable) === stable(nextComparable);

    let snapshot: Snapshot | undefined;
    if (!unchanged) {
      snapshot = this.createSnapshot(projectId, knowledgeIds, repositoryRevision, deploymentRevision, sourceHealth);
      this.closeRemovedKnowledge(previous, snapshot);
      this.createMovements(projectId, previous, snapshot);
      this.createConflicts(projectId, snapshot);
    }

    run.status = run.errors.length === 0 ? "success" : sourceSuccess.size > 0 ? "partial" : "failed";
    run.completedAt = this.clock().toISOString();
    this.store.auditEvents.push({ id: randomUUID(), projectId, action: "refresh.completed", metadata: { runId: run.id, status: run.status, idempotent: unchanged }, createdAt: run.completedAt });
    return { run, snapshot, idempotent: unchanged };
  }

  async checkSource(projectId: string, sourceId: string): Promise<HealthResult> {
    const source = this.store.sources.find((candidate) => candidate.id === sourceId && candidate.projectId === projectId);
    if (!source) throw new Error(`Source '${sourceId}' was not found.`);
    const adapter = source.type === "repository" ? this.adapters.repository(source.provider) : this.adapters.deployment(source.provider);
    if (!adapter) throw new Error(`No ${source.type} adapter is registered for '${source.provider}'.`);
    const health = await adapter.healthCheck(source.config);
    source.lastHealth = health;
    source.lastCheckedAt = health.checkedAt;
    this.store.auditEvents.push({ id: randomUUID(), projectId, action: "source.health_checked", metadata: { sourceId, state: health.state }, createdAt: health.checkedAt });
    return health;
  }

  private async refreshRepository(projectId: string, source: ProjectSource, run: RefreshRun, currentItemIds: Set<string>, sourceHealth: Record<string, HealthResult>): Promise<{ success: boolean; revision?: string }> {
    const adapter = this.adapters.repository(source.provider);
    if (!adapter) return this.failure(source, run, sourceHealth, `No repository adapter is registered for '${source.provider}'.`);
    try {
      const health = await adapter.healthCheck(source.config);
      sourceHealth[source.id] = health;
      source.lastHealth = health;
      source.lastCheckedAt = health.checkedAt;
      if (health.state === "unavailable") return this.failure(source, run, sourceHealth, health.message ?? "Repository source is unavailable.", false);
      const revision = await adapter.getRevision(source.config);
      run.sourceRevisions[source.id] = revision.value;
      const artifacts = await adapter.listArtifacts(source.config);
      const include = Array.isArray(source.config.include) ? source.config.include.filter((value): value is string => typeof value === "string") : ["**"];
      const configuredExclude = Array.isArray(source.config.exclude) ? source.config.exclude.filter((value): value is string => typeof value === "string") : [];
      const maxBytes = typeof source.config.maxArtifactBytes === "number" ? source.config.maxArtifactBytes : 1_000_000;
      for (const ref of artifacts) {
        if (!isAllowedArtifact(ref.path, include, [...DEFAULT_EXCLUDES, ...configuredExclude])) continue;
        if (ref.artifactType !== "text" || (ref.size !== undefined && ref.size > maxBytes)) continue;
        const read = await adapter.readArtifact(source.config, ref);
        if (read.content.includes("\u0000")) continue;
        const content = safeText(read.content);
        const artifact = this.upsertArtifact(projectId, source.id, ref.externalId, ref.path, revision.value, content);
        for (const candidate of extractKnowledge(projectId, artifact)) {
          const existing = this.store.knowledge.find((item) => item.projectId === projectId && item.fingerprint === candidate.item.fingerprint);
          if (existing) {
            currentItemIds.add(existing.id);
            if (!this.store.provenance.some((provenance) => provenance.knowledgeItemId === existing.id && provenance.sourceArtifactId === artifact.id)) {
              const material = materializeExtracted(candidate, this.clock().toISOString());
              this.store.provenance.push({ ...material.provenance, knowledgeItemId: existing.id });
            }
          } else {
            const material = materializeExtracted(candidate, this.clock().toISOString());
            this.store.knowledge.push(material.item);
            this.store.provenance.push(material.provenance);
            currentItemIds.add(material.item.id);
          }
        }
      }
      return { success: true, revision: revision.value };
    } catch (error) {
      return this.failure(source, run, sourceHealth, error instanceof Error ? error.message : "Repository refresh failed.");
    }
  }

  private async refreshDeployment(projectId: string, source: ProjectSource, run: RefreshRun, currentItemIds: Set<string>, sourceHealth: Record<string, HealthResult>): Promise<{ success: boolean; revision?: string }> {
    const adapter = this.adapters.deployment(source.provider);
    if (!adapter) return this.failure(source, run, sourceHealth, `No deployment adapter is registered for '${source.provider}'.`);
    try {
      const health = await adapter.healthCheck(source.config);
      sourceHealth[source.id] = health;
      source.lastHealth = health;
      source.lastCheckedAt = health.checkedAt;
      if (health.state === "unavailable") return this.failure(source, run, sourceHealth, health.message ?? "Deployment source is unavailable.", false);
      const deployment = await adapter.getCurrentDeployment(source.config);
      if (!deployment) return { success: true };
      const existing = this.store.deployments.find((item) => item.sourceId === source.id && item.externalId === deployment.externalId);
      const record: Deployment = existing ?? { id: randomUUID(), projectId, sourceId: source.id, externalId: deployment.externalId, environment: deployment.environment, revision: deployment.revision, status: deployment.status, deployedAt: deployment.deployedAt, metadata: deployment.metadata ?? {} };
      if (!existing) this.store.deployments.push(record);
      else Object.assign(existing, record, { revision: deployment.revision, status: deployment.status, deployedAt: deployment.deployedAt, metadata: deployment.metadata ?? {} });
      run.sourceRevisions[source.id] = deployment.revision ?? deployment.externalId;
      const item = this.deploymentKnowledge(projectId, source, record);
      currentItemIds.add(item.id);
      return { success: true, revision: deployment.revision };
    } catch (error) {
      return this.failure(source, run, sourceHealth, error instanceof Error ? error.message : "Deployment refresh failed.");
    }
  }

  private deploymentKnowledge(projectId: string, source: ProjectSource, deployment: Deployment): KnowledgeItem {
    const fingerprint = sha256(`deployment\u0000${source.id}\u0000${deployment.externalId}\u0000${deployment.revision ?? ""}`);
    const found = this.store.knowledge.find((item) => item.projectId === projectId && item.fingerprint === fingerprint);
    if (found) return found;
    const item: KnowledgeItem = {
      id: randomUUID(), projectId, type: "deployment", title: `${deployment.environment} deployment`,
      body: `Deployment ${deployment.externalId} is ${deployment.status}${deployment.revision ? ` at revision ${deployment.revision}` : ""}.`, status: "current",
      state: { documented: "unknown", implemented: "unknown", tested: "unknown", deployed: "evidenced", observed: "unknown" },
      fingerprint, entityKey: `deployment:${source.id}:${deployment.environment}`, createdAt: this.clock().toISOString(),
    };
    this.store.knowledge.push(item);
    this.store.provenance.push({ id: randomUUID(), knowledgeItemId: item.id, sourceType: "deployment", sourceRef: deployment.externalId, repositoryCommit: deployment.revision, metadata: { provider: source.provider, environment: deployment.environment } });
    return item;
  }

  private upsertArtifact(projectId: string, sourceId: string, externalId: string, path: string, revision: string, content: string): SourceArtifact {
    const hash = sha256(content);
    const found = this.store.artifacts.find((artifact) => artifact.sourceId === sourceId && artifact.path === path && artifact.revision === revision && artifact.contentHash === hash);
    const now = this.clock().toISOString();
    if (found) {
      found.lastSeenAt = now;
      return found;
    }
    const artifact: SourceArtifact = { id: randomUUID(), projectId, sourceId, externalId, path, artifactType: "text", revision, contentHash: hash, content, metadata: {}, firstSeenAt: now, lastSeenAt: now };
    this.store.artifacts.push(artifact);
    return artifact;
  }

  private createSnapshot(projectId: string, knowledgeItemIds: string[], repositoryRevision: string | undefined, deploymentRevision: string | undefined, sourceHealth: Record<string, HealthResult>): Snapshot {
    const items = knowledgeItemIds.flatMap((id) => {
      const item = this.store.knowledge.find((candidate) => candidate.id === id);
      return item ? [item] : [];
    });
    const byType = items.reduce<Snapshot["summary"]["byType"]>((counts, item) => ({ ...counts, [item.type]: (counts[item.type] ?? 0) + 1 }), {});
    const resolution: Snapshot["summary"]["resolution"] = Object.values(sourceHealth).some((health) => health.state !== "healthy") ? "uncertain" : "resolved";
    const snapshot: Snapshot = Object.freeze({ id: randomUUID(), projectId, createdAt: this.clock().toISOString(), repositoryRevision, deploymentRevision, sourceHealth: structuredClone(sourceHealth), summary: { knowledgeCount: items.length, byType, resolution }, knowledgeItemIds: [...knowledgeItemIds] });
    this.store.snapshots.push(snapshot);
    for (const item of items.filter((item) => !item.validFromSnapshotId)) item.validFromSnapshotId = snapshot.id;
    return snapshot;
  }

  private closeRemovedKnowledge(previous: Snapshot | undefined, current: Snapshot): void {
    if (!previous) return;
    const currentItems = new Set(current.knowledgeItemIds);
    for (const itemId of previous.knowledgeItemIds) {
      if (currentItems.has(itemId)) continue;
      const item = this.store.knowledge.find((candidate) => candidate.id === itemId);
      if (item && !item.validToSnapshotId) {
        item.status = "superseded";
        item.validToSnapshotId = current.id;
      }
    }
  }

  private createMovements(projectId: string, previous: Snapshot | undefined, current: Snapshot): void {
    const beforeItems = previous ? previous.knowledgeItemIds.flatMap((id) => {
      const item = this.store.knowledge.find((candidate) => candidate.id === id);
      return item ? [item] : [];
    }) : [];
    const afterItems = current.knowledgeItemIds.flatMap((id) => {
      const item = this.store.knowledge.find((candidate) => candidate.id === id);
      return item ? [item] : [];
    });
    const beforeByEntity = new Map(beforeItems.map((item) => [item.entityKey, item]));
    const afterByEntity = new Map(afterItems.map((item) => [item.entityKey, item]));
    const add = (movementType: Movement["movementType"], entityKey: string, before?: KnowledgeItem, after?: KnowledgeItem): void => {
      this.store.movements.push({ id: randomUUID(), projectId, fromSnapshotId: previous?.id, toSnapshotId: current.id, movementType, entityType: after?.type ?? before?.type ?? "state", entityKey, before: before ? compactItem(before) : undefined, after: after ? compactItem(after) : undefined, createdAt: current.createdAt });
    };
    for (const [key, item] of afterByEntity) {
      const before = beforeByEntity.get(key);
      if (!before) add("added", key, undefined, item);
      else if (before.fingerprint !== item.fingerprint) add("changed", key, before, item);
    }
    for (const [key, item] of beforeByEntity) if (!afterByEntity.has(key)) add("removed", key, item);
    if (previous && previous.deploymentRevision !== current.deploymentRevision) add("deployed", "deployment:current", undefined, undefined);
    if (previous && stable(healthComparable(previous.sourceHealth)) !== stable(healthComparable(current.sourceHealth))) add("source_health", "sources", undefined, undefined);
  }

  private createConflicts(projectId: string, snapshot: Snapshot): void {
    const existingOpen = this.store.conflicts.filter((conflict) => conflict.projectId === projectId && conflict.status === "open");
    for (const conflict of existingOpen) conflict.status = "resolved";
    const conflict = (type: Conflict["type"], severity: Conflict["severity"], title: string, description: string, evidence: Record<string, unknown>): void => {
      this.store.conflicts.push({ id: randomUUID(), projectId, snapshotId: snapshot.id, type, severity, title, description, evidence, status: "open" });
    };
    if (snapshot.repositoryRevision && snapshot.deploymentRevision && snapshot.repositoryRevision !== snapshot.deploymentRevision) {
      conflict("repository_deployment_divergence", "medium", "Repository and production deployment differ", "The latest observed production deployment is not at the current repository revision.", { repositoryRevision: snapshot.repositoryRevision, deploymentRevision: snapshot.deploymentRevision });
    }
    const snapshotItems = snapshot.knowledgeItemIds.flatMap((id) => {
      const item = this.store.knowledge.find((candidate) => candidate.id === id);
      return item ? [item] : [];
    });
    const documentedAssertions = new Map(snapshotItems.filter((item) => item.type === "invariant" && item.title.startsWith("Assertion: ")).map((item) => [item.title.slice("Assertion: ".length), item]));
    const implementedAssertions = new Map(snapshotItems.filter((item) => item.type === "implementation" && item.title.startsWith("Assertion: ")).map((item) => [item.title.slice("Assertion: ".length), item]));
    for (const [key, documented] of documentedAssertions) {
      const implemented = implementedAssertions.get(key);
      if (implemented && documented.body !== implemented.body) {
        conflict("evidence_mismatch", "high", `Documented and implemented assertion differ: ${key}`, "Explicit deterministic assertion evidence differs between documentation and implementation.", { key, documented: documented.body, implemented: implemented.body, documentedKnowledgeId: documented.id, implementedKnowledgeId: implemented.id });
      }
    }
    for (const [sourceId, health] of Object.entries(snapshot.sourceHealth)) {
      if (health.state !== "healthy") conflict("source_unavailable", health.state === "unavailable" ? "high" : "medium", "Source health is uncertain", health.message ?? "A registered source could not be fully observed.", { sourceId, state: health.state });
    }
  }

  private failure(source: ProjectSource, run: RefreshRun, sourceHealth: Record<string, HealthResult>, message: string, overwriteHealth = true): { success: false } {
    const health = overwriteHealth || !sourceHealth[source.id] ? { state: "unavailable" as const, checkedAt: this.clock().toISOString(), message } : sourceHealth[source.id]!;
    sourceHealth[source.id] = health;
    source.lastHealth = health;
    source.lastCheckedAt = health.checkedAt;
    run.errors.push({ sourceId: source.id, message });
    return { success: false };
  }

  private latestSnapshot(projectId: string): Snapshot | undefined {
    return this.store.snapshots.filter((snapshot) => snapshot.projectId === projectId).at(-1);
  }
}
