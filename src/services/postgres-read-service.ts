import { isAllowedArtifact } from "../core/security.js";
import type { Conflict, Deployment, KnowledgeItem, KnowledgeStatus, KnowledgeType, KnowledgeWithProvenance, Movement, Project, ProjectSource, Provenance, RefreshRun, Snapshot, SourceArtifact } from "../domain/types.js";
import type { OnboardingSummary, ProjectState, ProjectSummary, SearchOptions } from "./query.js";
import { clampLimit, knowledgeTerms, summary, type ObservatoryReadService } from "./read-service.js";

type Row = Record<string, unknown>;

/** Minimal parameterized-query capability supplied by PostgresStore. */
export interface PostgresReadClient {
  queryRead(category: string, text: string, values?: unknown[], artifactContent?: boolean): Promise<Row[]>;
}

const projectColumns = 'id, slug, name, description, status, created_at AS "createdAt", updated_at AS "updatedAt"';
const snapshotColumns = 'id, project_id AS "projectId", created_at AS "createdAt", repository_revision AS "repositoryRevision", deployment_revision AS "deploymentRevision", source_health_json AS "sourceHealth", summary_json AS summary';
const knowledgeColumns = 'id, project_id AS "projectId", type, domain, title, body, status, documented_state AS documented, implemented_state AS implemented, tested_state AS tested, deployed_state AS deployed, observed_state AS observed, fingerprint, entity_key AS "entityKey", valid_from_snapshot_id AS "validFromSnapshotId", valid_to_snapshot_id AS "validToSnapshotId", created_at AS "createdAt"';
const provenanceColumns = 'id, knowledge_item_id AS "knowledgeItemId", source_artifact_id AS "sourceArtifactId", source_type AS "sourceType", source_ref AS "sourceRef", repository_commit AS "repositoryCommit", path, start_line AS "startLine", end_line AS "endLine", metadata_json AS metadata';
const movementColumns = 'id, project_id AS "projectId", from_snapshot_id AS "fromSnapshotId", to_snapshot_id AS "toSnapshotId", movement_type AS "movementType", entity_type AS "entityType", entity_key AS "entityKey", before_json AS before, after_json AS after, created_at AS "createdAt"';
const conflictColumns = 'id, project_id AS "projectId", snapshot_id AS "snapshotId", type, severity, title, description, evidence_json AS evidence, status';

/**
 * Canonical PostgreSQL read implementation. Every operation is project- or
 * object-scoped and has a concrete limit. Artifact bodies appear only in the
 * three explicit evidence methods below, each constrained by an id/path or a
 * current-revision, project-scoped candidate limit.
 */
export class PostgresReadService implements ObservatoryReadService {
  constructor(private readonly database: PostgresReadClient) {}

  async listProjects(): Promise<ProjectSummary[]> {
    const rows = await this.database.queryRead("project_summary", `
      SELECT ${projectColumns},
        latest.repository_revision AS "repositoryRevision", latest.deployment_revision AS "deploymentRevision",
        refreshed."lastRefreshAt", COALESCE(conflicts."unresolvedConflictCount", 0)::int AS "unresolvedConflictCount",
        COALESCE(movements."recentMovementCount", 0)::int AS "recentMovementCount"
      FROM projects
      LEFT JOIN LATERAL (
        SELECT repository_revision, deployment_revision FROM snapshots
        WHERE project_id = projects.id ORDER BY created_at DESC LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT completed_at AS "lastRefreshAt" FROM refresh_runs
        WHERE project_id = projects.id AND status <> 'failed' ORDER BY started_at DESC LIMIT 1
      ) refreshed ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS "unresolvedConflictCount" FROM conflicts
        WHERE project_id = projects.id AND status = 'open'
      ) conflicts ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS "recentMovementCount" FROM (
          SELECT id FROM movements WHERE project_id = projects.id ORDER BY created_at DESC LIMIT 5
        ) recent
      ) movements ON true
      ORDER BY name ASC, id ASC
      LIMIT 100`, []);
    return rows.map((row) => ({
      id: String(row.id), slug: String(row.slug), name: String(row.name),
      repositoryRevision: optionalString(row.repositoryRevision), deploymentRevision: optionalString(row.deploymentRevision),
      lastRefreshAt: row.lastRefreshAt ? iso(row.lastRefreshAt) : undefined,
      unresolvedConflictCount: Number(row.unresolvedConflictCount ?? 0), recentMovementCount: Number(row.recentMovementCount ?? 0),
    }));
  }

  async getProject(projectRef: string): Promise<Project> {
    const rows = await this.database.queryRead("project", `SELECT ${projectColumns} FROM projects WHERE id::text = $1 OR slug = $1 LIMIT 1`, [projectRef]);
    const project = rows[0] && mapProject(rows[0]);
    if (!project) throw new Error(`Project '${projectRef}' was not found.`);
    return project;
  }

  async getProjectState(projectRef: string): Promise<ProjectState> {
    const project = await this.getProject(projectRef);
    const [snapshot, conflicts, movements] = await Promise.all([
      this.latestSnapshot(project.id),
      this.database.queryRead("project_open_conflicts", `SELECT ${conflictColumns} FROM conflicts WHERE project_id = $1 AND status = 'open' ORDER BY id ASC LIMIT 100`, [project.id]),
      this.database.queryRead("project_recent_movements", `SELECT ${movementColumns} FROM movements WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`, [project.id]),
    ]);
    return { project, snapshot, sourceHealth: snapshot?.sourceHealth ?? {}, summary: snapshot?.summary, unresolvedConflicts: conflicts.map(mapConflict), latestMovements: movements.map(mapMovement) };
  }

  async getSources(projectRef: string): Promise<ProjectSource[]> {
    const project = await this.getProject(projectRef);
    const rows = await this.database.queryRead("project_sources", `SELECT id, project_id AS "projectId", type, provider, enabled, last_health_status AS "lastHealth", last_checked_at AS "lastCheckedAt" FROM project_sources WHERE project_id = $1 ORDER BY id ASC LIMIT 100`, [project.id]);
    return rows.map((row) => ({ id: String(row.id), projectId: String(row.projectId), type: row.type === "deployment" ? "deployment" : "repository", provider: String(row.provider), encryptedConfig: "", config: {}, enabled: Boolean(row.enabled), lastHealth: row.lastHealth ? json(row.lastHealth) as unknown as ProjectSource["lastHealth"] : undefined, lastCheckedAt: row.lastCheckedAt ? iso(row.lastCheckedAt) : undefined }));
  }

  async getOnboardingSummary(projectRef: string): Promise<OnboardingSummary> {
    const project = await this.getProject(projectRef);
    const rows = await this.database.queryRead("onboarding_summary", `
      SELECT latest.id AS "snapshotId", latest.repository_revision AS "repositoryRevision",
        source.last_health_status AS "lastHealth", run.status AS "refreshStatus",
        COALESCE(artifacts.count, 0)::int AS "artifactCount", COALESCE(knowledge.count, 0)::int AS "knowledgeCount",
        COALESCE(provenance.count, 0)::int AS "provenanceCount", COALESCE(conflicts.count, 0)::int AS "openConflictCount"
      FROM projects p
      LEFT JOIN LATERAL (SELECT id, repository_revision FROM snapshots WHERE project_id = p.id ORDER BY created_at DESC LIMIT 1) latest ON true
      LEFT JOIN LATERAL (SELECT last_health_status FROM project_sources WHERE project_id = p.id AND type = 'repository' ORDER BY id LIMIT 1) source ON true
      LEFT JOIN LATERAL (SELECT status FROM refresh_runs WHERE project_id = p.id ORDER BY started_at DESC LIMIT 1) run ON true
      LEFT JOIN LATERAL (SELECT COUNT(*) FROM source_artifacts WHERE project_id = p.id) artifacts ON true
      LEFT JOIN LATERAL (SELECT COUNT(*) FROM knowledge_items WHERE project_id = p.id) knowledge ON true
      LEFT JOIN LATERAL (SELECT COUNT(*) FROM provenance v JOIN knowledge_items k ON k.id = v.knowledge_item_id WHERE k.project_id = p.id) provenance ON true
      LEFT JOIN LATERAL (SELECT COUNT(*) FROM conflicts WHERE project_id = p.id AND status = 'open') conflicts ON true
      WHERE p.id = $1 LIMIT 1`, [project.id]);
    const row = rows[0];
    return {
      repositoryRevision: optionalString(row?.repositoryRevision), sourceHealth: row?.lastHealth ? String(json(row.lastHealth).state ?? "") || undefined : undefined,
      refreshStatus: optionalString(row?.refreshStatus), snapshotId: optionalString(row?.snapshotId), artifactCount: Number(row?.artifactCount ?? 0),
      knowledgeCount: Number(row?.knowledgeCount ?? 0), provenanceCount: Number(row?.provenanceCount ?? 0), openConflictCount: Number(row?.openConflictCount ?? 0),
    };
  }

  async getKnowledge(projectRef: string, itemId?: string): Promise<KnowledgeWithProvenance[]> {
    const project = await this.getProject(projectRef);
    const rows = await this.database.queryRead("project_knowledge", `SELECT ${knowledgeColumns} FROM knowledge_items WHERE project_id = $1 ${itemId ? 'AND id = $2' : ''} ORDER BY created_at DESC, id DESC LIMIT ${itemId ? 1 : 100}`, itemId ? [project.id, itemId] : [project.id]);
    if (itemId && rows.length === 0) throw new Error(`Knowledge item '${itemId}' was not found.`);
    return this.withProvenance(rows.map(mapKnowledge));
  }

  async searchProject(projectRef: string, query: string, options: SearchOptions = {}): Promise<KnowledgeWithProvenance[]> {
    const project = await this.getProject(projectRef);
    const terms = knowledgeTerms(query);
    if (terms.length === 0) return [];
    const limit = clampLimit(options.limit, 20, 100);
    const rows = await this.database.queryRead("knowledge_search", `
      SELECT ${knowledgeColumns}
      FROM knowledge_items
      WHERE project_id = $1 AND status <> 'superseded'
        AND ($2::text IS NULL OR domain = $2)
        AND ($3::text IS NULL OR type = $3)
        AND EXISTS (SELECT 1 FROM unnest($4::text[]) AS term WHERE lower(title || E'\\n' || body) LIKE '%' || term || '%')
      ORDER BY title ASC, id ASC
      LIMIT $5`, [project.id, options.domain ?? null, options.type ?? null, terms, limit]);
    return this.withProvenance(rows.map(mapKnowledge));
  }

  async getRecentChanges(projectRef: string, since?: string): Promise<Movement[]> {
    const project = await this.getProject(projectRef);
    return (await this.database.queryRead("project_movements", `
      SELECT ${movementColumns} FROM movements
      WHERE project_id = $1 AND ($2::uuid IS NULL OR from_snapshot_id = $2 OR to_snapshot_id = $2)
      ORDER BY created_at DESC, id DESC LIMIT 100`, [project.id, since ?? null])).map(mapMovement);
  }

  async getDeployments(projectRef: string, environment?: string, limit = 20): Promise<Deployment[]> {
    const project = await this.getProject(projectRef);
    return (await this.database.queryRead("project_deployments", `
      SELECT id, project_id AS "projectId", source_id AS "sourceId", external_id AS "externalId", environment, revision, status, deployed_at AS "deployedAt", metadata_json AS metadata
      FROM deployments WHERE project_id = $1 AND ($2::text IS NULL OR environment = $2)
      ORDER BY deployed_at DESC, id DESC LIMIT $3`, [project.id, environment ?? null, clampLimit(limit, 20, 100)])).map(mapDeployment);
  }

  async getDecisions(projectRef: string, domain?: string): Promise<KnowledgeWithProvenance[]> { return this.knowledgeByType(projectRef, "decision", domain); }
  async getKnownRisks(projectRef: string): Promise<KnowledgeWithProvenance[]> { return this.knowledgeByType(projectRef, "risk"); }

  async compareSnapshots(projectRef: string, fromSnapshotId: string, toSnapshotId: string): Promise<Movement[]> {
    const project = await this.getProject(projectRef);
    const [from, to] = await Promise.all([this.getSnapshot(project.id, fromSnapshotId), this.getSnapshot(project.id, toSnapshotId)]);
    const recorded = (await this.database.queryRead("snapshot_pair_movements", `SELECT ${movementColumns} FROM movements WHERE project_id = $1 AND from_snapshot_id = $2 AND to_snapshot_id = $3 ORDER BY created_at DESC, id DESC LIMIT 100`, [project.id, from.id, to.id])).map(mapMovement);
    if (recorded.length || from.id === to.id) return recorded;
    const [before, after] = await Promise.all([this.snapshotKnowledge(from.id), this.snapshotKnowledge(to.id)]);
    const previous = new Map(before.map((item) => [item.entityKey, item]));
    const current = new Map(after.map((item) => [item.entityKey, item]));
    const result: Movement[] = [];
    const add = (movementType: Movement["movementType"], entityKey: string, beforeItem?: KnowledgeItem, afterItem?: KnowledgeItem) => result.push({ id: `comparison:${from.id}:${to.id}:${entityKey}`, projectId: project.id, fromSnapshotId: from.id, toSnapshotId: to.id, movementType, entityType: afterItem?.type ?? beforeItem?.type ?? "state", entityKey, before: beforeItem ? summary(beforeItem) : undefined, after: afterItem ? summary(afterItem) : undefined, createdAt: to.createdAt });
    for (const [key, item] of current) { const prior = previous.get(key); if (!prior) add("added", key, undefined, item); else if (prior.fingerprint !== item.fingerprint) add("changed", key, prior, item); }
    for (const [key, item] of previous) if (!current.has(key)) add("removed", key, item);
    if (from.deploymentRevision !== to.deploymentRevision) add("deployed", "deployment:current");
    return result;
  }

  async getSourceArtifact(projectRef: string, artifactId: string): Promise<Pick<SourceArtifact, "id" | "path" | "revision" | "contentHash" | "content" | "metadata">> {
    const project = await this.getProject(projectRef);
    const rows = await this.database.queryRead("artifact_content", `
      SELECT id, path, revision, content_hash AS "contentHash", content_text AS content, metadata_json AS metadata
      FROM source_artifacts WHERE project_id = $1 AND id = $2 AND content_text IS NOT NULL LIMIT 1`, [project.id, artifactId], true);
    const row = rows[0];
    if (!row || !isAllowedArtifact(String(row.path))) throw new Error("Safe indexed artifact was not found.");
    return { id: String(row.id), path: String(row.path), revision: String(row.revision), contentHash: String(row.contentHash), content: optionalString(row.content), metadata: json(row.metadata) };
  }

  async sourceArtifactScope(projectRef: string, artifactId: string): Promise<"in_project" | "other_project" | "missing"> {
    const project = await this.getProject(projectRef);
    const row = (await this.database.queryRead("artifact_scope", "SELECT project_id AS \"projectId\" FROM source_artifacts WHERE id = $1 LIMIT 1", [artifactId]))[0];
    return !row ? "missing" : String(row.projectId) === project.id ? "in_project" : "other_project";
  }

  async getCurrentSourceArtifactByPath(projectRef: string, path: string): Promise<Pick<SourceArtifact, "id" | "path" | "revision" | "contentHash" | "content"> | undefined> {
    const project = await this.getProject(projectRef);
    const rows = await this.database.queryRead("artifact_content_by_path", `
      SELECT a.id, a.path, a.revision, a.content_hash AS "contentHash", a.content_text AS content
      FROM source_artifacts a
      JOIN LATERAL (SELECT repository_revision FROM snapshots WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1) current ON current.repository_revision = a.revision
      WHERE a.project_id = $1 AND a.path = $2 AND a.content_text IS NOT NULL
      ORDER BY a.last_seen_at DESC LIMIT 1`, [project.id, path], true);
    const row = rows[0];
    return row && isAllowedArtifact(String(row.path)) ? { id: String(row.id), path: String(row.path), revision: String(row.revision), contentHash: String(row.contentHash), content: optionalString(row.content) } : undefined;
  }

  async searchCurrentSourceArtifacts(projectRef: string, query: string, limit = 20): Promise<Array<Pick<SourceArtifact, "id" | "sourceId" | "path" | "revision" | "contentHash" | "content">>> {
    const project = await this.getProject(projectRef);
    const terms = knowledgeTerms(query);
    if (!terms.length) return [];
    const rows = await this.database.queryRead("artifact_search_excerpt", `
      SELECT a.id, a.source_id AS "sourceId", a.path, a.revision, a.content_hash AS "contentHash",
        left(a.content_text, 32768) AS content
      FROM source_artifacts a
      JOIN LATERAL (SELECT repository_revision FROM snapshots WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1) current ON current.repository_revision = a.revision
      WHERE a.project_id = $1 AND a.content_text IS NOT NULL
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS term WHERE lower(a.path || E'\\n' || a.content_text) LIKE '%' || term || '%')
      ORDER BY a.path ASC, a.id ASC LIMIT $3`, [project.id, terms, clampLimit(limit, 20, 50)], true);
    return rows.filter((row) => isAllowedArtifact(String(row.path))).map((row) => ({ id: String(row.id), sourceId: String(row.sourceId), path: String(row.path), revision: String(row.revision), contentHash: String(row.contentHash), content: optionalString(row.content) }));
  }

  async getSnapshots(projectRef: string, limit = 50): Promise<Snapshot[]> {
    const project = await this.getProject(projectRef);
    const rows = await this.database.queryRead("snapshot_list", `SELECT ${snapshotColumns} FROM snapshots WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [project.id, clampLimit(limit, 50, 100)]);
    if (!rows.length) return [];
    // Membership is fetched only for an explicit bounded snapshot-list
    // request, never as part of generic project state.
    const members = await this.database.queryRead("snapshot_list_membership", "SELECT snapshot_id AS \"snapshotId\", knowledge_item_id AS \"knowledgeItemId\" FROM snapshot_items WHERE snapshot_id = ANY($1::uuid[]) ORDER BY snapshot_id, knowledge_item_id LIMIT 5000", [rows.map((row) => String(row.id))]);
    const bySnapshot = new Map<string, string[]>();
    for (const member of members) bySnapshot.set(String(member.snapshotId), [...(bySnapshot.get(String(member.snapshotId)) ?? []), String(member.knowledgeItemId)]);
    return rows.map((row) => mapSnapshot(row, bySnapshot.get(String(row.id)) ?? []));
  }

  async getSnapshot(projectRef: string, snapshotId: string): Promise<Snapshot> {
    const project = await this.getProject(projectRef);
    const row = (await this.database.queryRead("snapshot", `SELECT ${snapshotColumns} FROM snapshots WHERE project_id = $1 AND id = $2 LIMIT 1`, [project.id, snapshotId]))[0];
    if (!row) throw new Error(`Snapshot '${snapshotId}' was not found.`);
    const ids = await this.database.queryRead("snapshot_membership", "SELECT knowledge_item_id AS \"knowledgeItemId\" FROM snapshot_items WHERE snapshot_id = $1 ORDER BY knowledge_item_id ASC", [snapshotId]);
    return mapSnapshot(row, ids.map((item) => String(item.knowledgeItemId)));
  }

  async getConflicts(projectRef: string): Promise<Conflict[]> {
    const project = await this.getProject(projectRef);
    return (await this.database.queryRead("project_open_conflicts", `SELECT ${conflictColumns} FROM conflicts WHERE project_id = $1 AND status = 'open' ORDER BY id ASC LIMIT 100`, [project.id])).map(mapConflict);
  }

  async getRefreshRuns(projectRef: string): Promise<RefreshRun[]> {
    const project = await this.getProject(projectRef);
    return (await this.database.queryRead("refresh_runs", `SELECT id, project_id AS "projectId", started_at AS "startedAt", completed_at AS "completedAt", status, source_revision_json AS "sourceRevisions", errors_json AS errors FROM refresh_runs WHERE project_id = $1 ORDER BY started_at DESC, id DESC LIMIT 100`, [project.id])).map(mapRefreshRun);
  }

  private async latestSnapshot(projectId: string): Promise<Snapshot | undefined> {
    const row = (await this.database.queryRead("latest_snapshot", `SELECT ${snapshotColumns} FROM snapshots WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [projectId]))[0];
    return row ? mapSnapshot(row) : undefined;
  }

  private async withProvenance(items: KnowledgeItem[]): Promise<KnowledgeWithProvenance[]> {
    if (!items.length) return [];
    const rows = await this.database.queryRead("knowledge_provenance", `SELECT ${provenanceColumns} FROM provenance WHERE knowledge_item_id = ANY($1::uuid[]) ORDER BY id ASC LIMIT 500`, [items.map((item) => item.id)]);
    const grouped = new Map<string, Provenance[]>();
    for (const row of rows) { const value = mapProvenance(row); grouped.set(value.knowledgeItemId, [...(grouped.get(value.knowledgeItemId) ?? []), value]); }
    return items.map((item) => ({ item, provenance: grouped.get(item.id) ?? [] }));
  }

  private async knowledgeByType(projectRef: string, type: KnowledgeType, domain?: string): Promise<KnowledgeWithProvenance[]> {
    const project = await this.getProject(projectRef);
    const rows = await this.database.queryRead("knowledge_by_type", `SELECT ${knowledgeColumns} FROM knowledge_items WHERE project_id = $1 AND type = $2 AND status <> 'superseded' AND ($3::text IS NULL OR domain = $3) ORDER BY created_at DESC, id DESC LIMIT 100`, [project.id, type, domain ?? null]);
    return this.withProvenance(rows.map(mapKnowledge));
  }

  private async snapshotKnowledge(snapshotId: string): Promise<KnowledgeItem[]> {
    return (await this.database.queryRead("snapshot_knowledge", `SELECT ${knowledgeColumns} FROM knowledge_items k JOIN snapshot_items i ON i.knowledge_item_id = k.id WHERE i.snapshot_id = $1 ORDER BY k.id ASC LIMIT 500`, [snapshotId])).map(mapKnowledge);
  }
}

function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function optionalString(value: unknown): string | undefined { return value === null || value === undefined ? undefined : String(value); }
function optionalNumber(value: unknown): number | undefined { return value === null || value === undefined ? undefined : Number(value); }
function json(value: unknown): Record<string, unknown> { if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>; return {}; }
function jsonArray<T>(value: unknown): T[] { if (Array.isArray(value)) return value as T[]; if (typeof value === "string") return JSON.parse(value) as T[]; return []; }

function mapProject(row: Row): Project { return { id: String(row.id), slug: String(row.slug), name: String(row.name), description: optionalString(row.description), status: row.status === "archived" ? "archived" : "active", createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }; }
function mapKnowledge(row: Row): KnowledgeItem { return { id: String(row.id), projectId: String(row.projectId), type: String(row.type) as KnowledgeItem["type"], domain: optionalString(row.domain), title: String(row.title), body: String(row.body), status: String(row.status) as KnowledgeStatus, state: { documented: String(row.documented) as KnowledgeItem["state"]["documented"], implemented: String(row.implemented) as KnowledgeItem["state"]["implemented"], tested: String(row.tested) as KnowledgeItem["state"]["tested"], deployed: String(row.deployed) as KnowledgeItem["state"]["deployed"], observed: String(row.observed) as KnowledgeItem["state"]["observed"] }, fingerprint: String(row.fingerprint), entityKey: String(row.entityKey), validFromSnapshotId: optionalString(row.validFromSnapshotId), validToSnapshotId: optionalString(row.validToSnapshotId), createdAt: iso(row.createdAt) }; }
function mapProvenance(row: Row): Provenance { return { id: String(row.id), knowledgeItemId: String(row.knowledgeItemId), sourceArtifactId: optionalString(row.sourceArtifactId), sourceType: String(row.sourceType) as Provenance["sourceType"], sourceRef: String(row.sourceRef), repositoryCommit: optionalString(row.repositoryCommit), path: optionalString(row.path), startLine: optionalNumber(row.startLine), endLine: optionalNumber(row.endLine), metadata: json(row.metadata) }; }
function mapSnapshot(row: Row, knowledgeItemIds: string[] = []): Snapshot { return Object.freeze({ id: String(row.id), projectId: String(row.projectId), createdAt: iso(row.createdAt), repositoryRevision: optionalString(row.repositoryRevision), deploymentRevision: optionalString(row.deploymentRevision), sourceHealth: json(row.sourceHealth) as unknown as Snapshot["sourceHealth"], summary: json(row.summary) as unknown as Snapshot["summary"], knowledgeItemIds: Object.freeze(knowledgeItemIds) }) as Snapshot; }
function mapMovement(row: Row): Movement { return { id: String(row.id), projectId: String(row.projectId), fromSnapshotId: optionalString(row.fromSnapshotId), toSnapshotId: String(row.toSnapshotId), movementType: String(row.movementType) as Movement["movementType"], entityType: String(row.entityType), entityKey: String(row.entityKey), before: row.before ? json(row.before) : undefined, after: row.after ? json(row.after) : undefined, createdAt: iso(row.createdAt) }; }
function mapConflict(row: Row): Conflict { return { id: String(row.id), projectId: String(row.projectId), snapshotId: String(row.snapshotId), type: String(row.type) as Conflict["type"], severity: String(row.severity) as Conflict["severity"], title: String(row.title), description: String(row.description), evidence: json(row.evidence), status: String(row.status) as Conflict["status"] }; }
function mapDeployment(row: Row): Deployment { return { id: String(row.id), projectId: String(row.projectId), sourceId: String(row.sourceId), externalId: String(row.externalId), environment: String(row.environment), revision: optionalString(row.revision), status: String(row.status), deployedAt: iso(row.deployedAt), metadata: json(row.metadata) }; }
function mapRefreshRun(row: Row): RefreshRun { return { id: String(row.id), projectId: String(row.projectId), startedAt: iso(row.startedAt), completedAt: row.completedAt ? iso(row.completedAt) : undefined, status: String(row.status) as RefreshRun["status"], sourceRevisions: json(row.sourceRevisions) as Record<string, string>, errors: jsonArray<RefreshRun["errors"][number]>(row.errors) }; }
