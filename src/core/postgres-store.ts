import { Pool, type PoolClient } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import type {
  AuditEvent,
  Conflict,
  Deployment,
  KnowledgeItem,
  Movement,
  Project,
  ProjectSource,
  Provenance,
  RefreshRun,
  Snapshot,
  SourceArtifact,
} from "../domain/types.js";
import { ConfigCipher } from "./security.js";
import { databaseUrlFromEnvironment, MemoryStore } from "./store.js";

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function json(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return {};
}

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") return JSON.parse(value) as T[];
  return [];
}

function parameterJson(value: unknown): string { return JSON.stringify(value ?? {}); }
function nullableParameterJson(value: unknown): string { return JSON.stringify(value ?? null); }

/**
 * A durable mirror of the domain store. Domain services continue to operate on
 * the same arrays used by MemoryStore; each successful mutating service call
 * flushes a complete, transactionally ordered state transition to PostgreSQL.
 * No query path talks to PostgreSQL outside this shared storage/service layer.
 */
export class PostgresStore extends MemoryStore {
  readonly persistent = true;
  private readonly pool: Pool;
  private readonly loaded: Promise<void>;

  constructor(private readonly cipher: ConfigCipher, connectionString = databaseUrlFromEnvironment()) {
    super();
    if (!connectionString) throw new Error("A provider-managed PostgreSQL connection is required (DATABASE_URL).");
    this.pool = new Pool({ connectionString, max: 4 });
    if (process.env.VERCEL === "1") attachDatabasePool(this.pool);
    this.loaded = this.load();
  }

  async ready(): Promise<void> { await this.loaded; }

  async close(): Promise<void> { await this.pool.end(); }

  private async load(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // A PoolClient permits one active query at a time. Keep hydration ordered
      // so it remains warning-free on Vercel's pooled serverless connection.
      const projects = await client.query<Row>('SELECT id, slug, name, description, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM projects ORDER BY created_at');
      const sources = await client.query<Row>('SELECT id, project_id AS "projectId", type, provider, config_json_encrypted AS "encryptedConfig", enabled, last_health_status AS "lastHealth", last_checked_at AS "lastCheckedAt" FROM project_sources ORDER BY id');
      const refreshRuns = await client.query<Row>('SELECT id, project_id AS "projectId", started_at AS "startedAt", completed_at AS "completedAt", status, source_revision_json AS "sourceRevisions", errors_json AS errors FROM refresh_runs ORDER BY started_at');
      const artifacts = await client.query<Row>('SELECT id, project_id AS "projectId", source_id AS "sourceId", external_id AS "externalId", path, artifact_type AS "artifactType", revision, content_hash AS "contentHash", content_text AS content, metadata_json AS metadata, first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt" FROM source_artifacts ORDER BY first_seen_at');
      const knowledge = await client.query<Row>('SELECT id, project_id AS "projectId", type, domain, title, body, status, documented_state AS documented, implemented_state AS implemented, tested_state AS tested, deployed_state AS deployed, observed_state AS observed, fingerprint, entity_key AS "entityKey", valid_from_snapshot_id AS "validFromSnapshotId", valid_to_snapshot_id AS "validToSnapshotId", created_at AS "createdAt" FROM knowledge_items ORDER BY created_at');
      const provenance = await client.query<Row>('SELECT id, knowledge_item_id AS "knowledgeItemId", source_artifact_id AS "sourceArtifactId", source_type AS "sourceType", source_ref AS "sourceRef", repository_commit AS "repositoryCommit", path, start_line AS "startLine", end_line AS "endLine", metadata_json AS metadata FROM provenance ORDER BY id');
      const deployments = await client.query<Row>('SELECT id, project_id AS "projectId", source_id AS "sourceId", external_id AS "externalId", environment, revision, status, deployed_at AS "deployedAt", metadata_json AS metadata FROM deployments ORDER BY deployed_at');
      const snapshots = await client.query<Row>('SELECT id, project_id AS "projectId", created_at AS "createdAt", repository_revision AS "repositoryRevision", deployment_revision AS "deploymentRevision", source_health_json AS "sourceHealth", summary_json AS summary FROM snapshots ORDER BY created_at');
      const snapshotItems = await client.query<Row>('SELECT snapshot_id AS "snapshotId", knowledge_item_id AS "knowledgeItemId" FROM snapshot_items ORDER BY snapshot_id');
      const movements = await client.query<Row>('SELECT id, project_id AS "projectId", from_snapshot_id AS "fromSnapshotId", to_snapshot_id AS "toSnapshotId", movement_type AS "movementType", entity_type AS "entityType", entity_key AS "entityKey", before_json AS before, after_json AS after, created_at AS "createdAt" FROM movements ORDER BY created_at');
      const conflicts = await client.query<Row>('SELECT id, project_id AS "projectId", snapshot_id AS "snapshotId", type, severity, title, description, evidence_json AS evidence, status FROM conflicts ORDER BY id');
      const auditEvents = await client.query<Row>('SELECT id, actor_id AS "actorId", project_id AS "projectId", action, metadata_json AS metadata, created_at AS "createdAt" FROM audit_events ORDER BY created_at');

      this.projects = projects.rows.map((row) => ({ id: String(row.id), slug: String(row.slug), name: String(row.name), description: optionalString(row.description), status: row.status === "archived" ? "archived" : "active", createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) } satisfies Project));
      this.sources = sources.rows.map((row) => {
        const encryptedConfig = String(row.encryptedConfig);
        return {
          id: String(row.id), projectId: String(row.projectId), type: row.type === "deployment" ? "deployment" : "repository", provider: String(row.provider), encryptedConfig,
          config: this.cipher.decrypt(encryptedConfig), enabled: Boolean(row.enabled), lastHealth: row.lastHealth ? json(row.lastHealth) as unknown as ProjectSource["lastHealth"] : undefined, lastCheckedAt: row.lastCheckedAt ? iso(row.lastCheckedAt) : undefined,
        } satisfies ProjectSource;
      });
      this.refreshRuns = refreshRuns.rows.map((row) => ({ id: String(row.id), projectId: String(row.projectId), startedAt: iso(row.startedAt), completedAt: row.completedAt ? iso(row.completedAt) : undefined, status: String(row.status) as RefreshRun["status"], sourceRevisions: json(row.sourceRevisions) as Record<string, string>, errors: jsonArray<RefreshRun["errors"][number]>(row.errors) }));
      this.artifacts = artifacts.rows.map((row) => ({ id: String(row.id), projectId: String(row.projectId), sourceId: String(row.sourceId), externalId: String(row.externalId), path: String(row.path), artifactType: row.artifactType === "binary" ? "binary" : "text", revision: String(row.revision), contentHash: String(row.contentHash), content: optionalString(row.content), metadata: json(row.metadata), firstSeenAt: iso(row.firstSeenAt), lastSeenAt: iso(row.lastSeenAt) }));
      this.knowledge = knowledge.rows.map((row) => ({ id: String(row.id), projectId: String(row.projectId), type: String(row.type) as KnowledgeItem["type"], domain: optionalString(row.domain), title: String(row.title), body: String(row.body), status: String(row.status) as KnowledgeItem["status"], state: { documented: String(row.documented) as KnowledgeItem["state"]["documented"], implemented: String(row.implemented) as KnowledgeItem["state"]["implemented"], tested: String(row.tested) as KnowledgeItem["state"]["tested"], deployed: String(row.deployed) as KnowledgeItem["state"]["deployed"], observed: String(row.observed) as KnowledgeItem["state"]["observed"] }, fingerprint: String(row.fingerprint), entityKey: String(row.entityKey), validFromSnapshotId: optionalString(row.validFromSnapshotId), validToSnapshotId: optionalString(row.validToSnapshotId), createdAt: iso(row.createdAt) }));
      this.provenance = provenance.rows.map((row) => ({ id: String(row.id), knowledgeItemId: String(row.knowledgeItemId), sourceArtifactId: optionalString(row.sourceArtifactId), sourceType: String(row.sourceType) as Provenance["sourceType"], sourceRef: String(row.sourceRef), repositoryCommit: optionalString(row.repositoryCommit), path: optionalString(row.path), startLine: optionalNumber(row.startLine), endLine: optionalNumber(row.endLine), metadata: json(row.metadata) }));
      this.deployments = deployments.rows.map((row) => ({ id: String(row.id), projectId: String(row.projectId), sourceId: String(row.sourceId), externalId: String(row.externalId), environment: String(row.environment), revision: optionalString(row.revision), status: String(row.status), deployedAt: iso(row.deployedAt), metadata: json(row.metadata) }));
      const members = new Map<string, string[]>();
      for (const item of snapshotItems.rows) members.set(String(item.snapshotId), [...(members.get(String(item.snapshotId)) ?? []), String(item.knowledgeItemId)]);
      this.snapshots = snapshots.rows.map((row) => Object.freeze({ id: String(row.id), projectId: String(row.projectId), createdAt: iso(row.createdAt), repositoryRevision: optionalString(row.repositoryRevision), deploymentRevision: optionalString(row.deploymentRevision), sourceHealth: json(row.sourceHealth) as unknown as Snapshot["sourceHealth"], summary: json(row.summary) as unknown as Snapshot["summary"], knowledgeItemIds: Object.freeze([...(members.get(String(row.id)) ?? [])]) }) as Snapshot);
      this.movements = movements.rows.map((row) => ({ id: String(row.id), projectId: String(row.projectId), fromSnapshotId: optionalString(row.fromSnapshotId), toSnapshotId: String(row.toSnapshotId), movementType: String(row.movementType) as Movement["movementType"], entityType: String(row.entityType), entityKey: String(row.entityKey), before: row.before ? json(row.before) : undefined, after: row.after ? json(row.after) : undefined, createdAt: iso(row.createdAt) }));
      this.conflicts = conflicts.rows.map((row) => ({ id: String(row.id), projectId: String(row.projectId), snapshotId: String(row.snapshotId), type: String(row.type) as Conflict["type"], severity: String(row.severity) as Conflict["severity"], title: String(row.title), description: String(row.description), evidence: json(row.evidence), status: String(row.status) as Conflict["status"] }));
      this.auditEvents = auditEvents.rows.map((row) => ({ id: String(row.id), actorId: optionalString(row.actorId), projectId: optionalString(row.projectId), action: String(row.action), metadata: json(row.metadata), createdAt: iso(row.createdAt) }));
    } finally {
      client.release();
    }
  }

  async flush(): Promise<void> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of this.projects) await upsertProject(client, item);
      for (const item of this.sources) await upsertSource(client, item);
      for (const item of this.refreshRuns) await upsertRefreshRun(client, item);
      for (const item of this.artifacts) await upsertArtifact(client, item);
      for (const item of this.knowledge) await upsertKnowledge(client, item);
      for (const item of this.provenance) await upsertProvenance(client, item);
      for (const item of this.deployments) await upsertDeployment(client, item);
      for (const item of this.snapshots) await insertSnapshot(client, item);
      for (const item of this.movements) await insertMovement(client, item);
      for (const item of this.conflicts) await upsertConflict(client, item);
      for (const item of this.auditEvents) await insertAuditEvent(client, item);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function optionalString(value: unknown): string | undefined { return value === null || value === undefined ? undefined : String(value); }
function optionalNumber(value: unknown): number | undefined { return value === null || value === undefined ? undefined : Number(value); }

async function upsertProject(client: PoolClient, item: Project): Promise<void> { await client.query("INSERT INTO projects (id,slug,name,description,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug,name=EXCLUDED.name,description=EXCLUDED.description,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at", [item.id, item.slug, item.name, item.description ?? null, item.status, item.createdAt, item.updatedAt]); }
async function upsertSource(client: PoolClient, item: ProjectSource): Promise<void> { await client.query("INSERT INTO project_sources (id,project_id,type,provider,config_json_encrypted,enabled,last_health_status,last_checked_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider,config_json_encrypted=EXCLUDED.config_json_encrypted,enabled=EXCLUDED.enabled,last_health_status=EXCLUDED.last_health_status,last_checked_at=EXCLUDED.last_checked_at", [item.id, item.projectId, item.type, item.provider, item.encryptedConfig, item.enabled, nullableParameterJson(item.lastHealth), item.lastCheckedAt ?? null]); }
async function upsertRefreshRun(client: PoolClient, item: RefreshRun): Promise<void> { await client.query("INSERT INTO refresh_runs (id,project_id,started_at,completed_at,status,source_revision_json,errors_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT (id) DO UPDATE SET completed_at=EXCLUDED.completed_at,status=EXCLUDED.status,source_revision_json=EXCLUDED.source_revision_json,errors_json=EXCLUDED.errors_json", [item.id, item.projectId, item.startedAt, item.completedAt ?? null, item.status, parameterJson(item.sourceRevisions), JSON.stringify(item.errors)]); }
async function upsertArtifact(client: PoolClient, item: SourceArtifact): Promise<void> { await client.query("INSERT INTO source_artifacts (id,project_id,source_id,external_id,path,artifact_type,revision,content_hash,content_text,metadata_json,first_seen_at,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) ON CONFLICT (id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,content_text=EXCLUDED.content_text,metadata_json=EXCLUDED.metadata_json", [item.id, item.projectId, item.sourceId, item.externalId, item.path, item.artifactType, item.revision, item.contentHash, item.content ?? null, parameterJson(item.metadata), item.firstSeenAt, item.lastSeenAt]); }
async function upsertKnowledge(client: PoolClient, item: KnowledgeItem): Promise<void> { await client.query("INSERT INTO knowledge_items (id,project_id,type,domain,title,body,status,documented_state,implemented_state,tested_state,deployed_state,observed_state,fingerprint,entity_key,valid_from_snapshot_id,valid_to_snapshot_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,valid_from_snapshot_id=EXCLUDED.valid_from_snapshot_id,valid_to_snapshot_id=EXCLUDED.valid_to_snapshot_id", [item.id, item.projectId, item.type, item.domain ?? null, item.title, item.body, item.status, item.state.documented, item.state.implemented, item.state.tested, item.state.deployed, item.state.observed, item.fingerprint, item.entityKey, item.validFromSnapshotId ?? null, item.validToSnapshotId ?? null, item.createdAt]); }
async function upsertProvenance(client: PoolClient, item: Provenance): Promise<void> { await client.query("INSERT INTO provenance (id,knowledge_item_id,source_artifact_id,source_type,source_ref,repository_commit,path,start_line,end_line,metadata_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT (id) DO NOTHING", [item.id, item.knowledgeItemId, item.sourceArtifactId ?? null, item.sourceType, item.sourceRef, item.repositoryCommit ?? null, item.path ?? null, item.startLine ?? null, item.endLine ?? null, parameterJson(item.metadata)]); }
async function upsertDeployment(client: PoolClient, item: Deployment): Promise<void> { await client.query("INSERT INTO deployments (id,project_id,source_id,external_id,environment,revision,status,deployed_at,metadata_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (id) DO UPDATE SET revision=EXCLUDED.revision,status=EXCLUDED.status,deployed_at=EXCLUDED.deployed_at,metadata_json=EXCLUDED.metadata_json", [item.id, item.projectId, item.sourceId, item.externalId, item.environment, item.revision ?? null, item.status, item.deployedAt, parameterJson(item.metadata)]); }
async function insertSnapshot(client: PoolClient, item: Snapshot): Promise<void> { await client.query("INSERT INTO snapshots (id,project_id,created_at,repository_revision,deployment_revision,source_health_json,summary_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT (id) DO NOTHING", [item.id, item.projectId, item.createdAt, item.repositoryRevision ?? null, item.deploymentRevision ?? null, parameterJson(item.sourceHealth), parameterJson(item.summary)]); for (const knowledgeItemId of item.knowledgeItemIds) await client.query("INSERT INTO snapshot_items (snapshot_id,knowledge_item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [item.id, knowledgeItemId]); }
async function insertMovement(client: PoolClient, item: Movement): Promise<void> { await client.query("INSERT INTO movements (id,project_id,from_snapshot_id,to_snapshot_id,movement_type,entity_type,entity_key,before_json,after_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) ON CONFLICT (id) DO NOTHING", [item.id, item.projectId, item.fromSnapshotId ?? null, item.toSnapshotId, item.movementType, item.entityType, item.entityKey, parameterJson(item.before), parameterJson(item.after), item.createdAt]); }
async function upsertConflict(client: PoolClient, item: Conflict): Promise<void> { await client.query("INSERT INTO conflicts (id,project_id,snapshot_id,type,severity,title,description,evidence_json,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status", [item.id, item.projectId, item.snapshotId, item.type, item.severity, item.title, item.description, parameterJson(item.evidence), item.status]); }
async function insertAuditEvent(client: PoolClient, item: AuditEvent): Promise<void> { await client.query("INSERT INTO audit_events (id,actor_id,project_id,action,metadata_json,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING", [item.id, item.actorId ?? null, item.projectId ?? null, item.action, parameterJson(item.metadata), item.createdAt]); }
