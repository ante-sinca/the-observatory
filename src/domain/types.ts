export type SourceType = "repository" | "deployment";
export type SourceHealthState = "healthy" | "degraded" | "unavailable";
export type RefreshStatus = "running" | "success" | "partial" | "failed";
export type KnowledgeType =
  | "document"
  | "architecture"
  | "decision"
  | "invariant"
  | "implementation"
  | "test_evidence"
  | "deployment"
  | "integration"
  | "risk"
  | "issue"
  | "planned_change"
  | "superseded_behavior"
  | "operational_observation";
export type EvidenceState = "evidenced" | "operator_asserted" | "unknown";
export type KnowledgeStatus = "current" | "superseded" | "conflicted";
export type MovementType = "added" | "removed" | "changed" | "deployed" | "source_health";

export interface Project {
  id: string;
  slug: string;
  name: string;
  description?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface SourceConfig {
  include?: string[];
  exclude?: string[];
  maxArtifactBytes?: number;
  /** Must remain true. Provider tokens must also be created with read-only scopes. */
  readOnly?: boolean;
  [key: string]: unknown;
}

export interface ProjectSource {
  id: string;
  projectId: string;
  type: SourceType;
  provider: string;
  /** Encryption is required for the durable store; never return this from an API. */
  encryptedConfig: string;
  config: SourceConfig;
  enabled: boolean;
  lastHealth?: HealthResult;
  lastCheckedAt?: string;
}

export interface HealthResult {
  state: SourceHealthState;
  checkedAt: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface SourceRevision {
  value: string;
  observedAt: string;
}

export interface SourceArtifactRef {
  externalId: string;
  path: string;
  artifactType: "text" | "binary";
  size?: number;
}

export interface ArtifactContent {
  content: string;
  encoding: "utf8";
}

export interface SourceArtifact {
  id: string;
  projectId: string;
  sourceId: string;
  externalId: string;
  path: string;
  artifactType: "text" | "binary";
  revision: string;
  contentHash: string;
  /** Safe text only. It is never persisted for excluded or binary artifacts. */
  content?: string;
  metadata: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface StateDimensions {
  documented: EvidenceState;
  implemented: EvidenceState;
  tested: EvidenceState;
  deployed: EvidenceState;
  observed: EvidenceState;
}

export interface KnowledgeItem {
  id: string;
  projectId: string;
  type: KnowledgeType;
  domain?: string;
  title: string;
  body: string;
  status: KnowledgeStatus;
  state: StateDimensions;
  fingerprint: string;
  entityKey: string;
  validFromSnapshotId?: string;
  validToSnapshotId?: string;
  createdAt: string;
}

export interface Provenance {
  id: string;
  knowledgeItemId: string;
  sourceArtifactId?: string;
  sourceType: "repository" | "deployment" | "operator";
  sourceRef: string;
  repositoryCommit?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  metadata: Record<string, unknown>;
}

export interface Deployment {
  id: string;
  projectId: string;
  sourceId: string;
  externalId: string;
  environment: string;
  revision?: string;
  status: string;
  deployedAt: string;
  metadata: Record<string, unknown>;
}

export interface RefreshRun {
  id: string;
  projectId: string;
  startedAt: string;
  completedAt?: string;
  status: RefreshStatus;
  sourceRevisions: Record<string, string>;
  errors: Array<{ sourceId?: string; message: string }>;
}

export interface Snapshot {
  id: string;
  projectId: string;
  createdAt: string;
  repositoryRevision?: string;
  deploymentRevision?: string;
  sourceHealth: Record<string, HealthResult>;
  summary: SnapshotSummary;
  knowledgeItemIds: string[];
}

export interface SnapshotSummary {
  knowledgeCount: number;
  byType: Partial<Record<KnowledgeType, number>>;
  resolution: "resolved" | "conflicted" | "uncertain";
}

export interface Movement {
  id: string;
  projectId: string;
  fromSnapshotId?: string;
  toSnapshotId: string;
  movementType: MovementType;
  entityType: string;
  entityKey: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  createdAt: string;
}

export interface Conflict {
  id: string;
  projectId: string;
  snapshotId: string;
  type: "repository_deployment_divergence" | "source_unavailable" | "evidence_mismatch";
  severity: "low" | "medium" | "high";
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  status: "open" | "resolved";
}

export interface AuditEvent {
  id: string;
  actorId?: string;
  projectId?: string;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DeploymentRecord {
  externalId: string;
  environment: string;
  revision?: string;
  status: string;
  deployedAt: string;
  metadata?: Record<string, unknown>;
}

export interface SourceAdapter {
  readonly kind: string;
  healthCheck(config: SourceConfig): Promise<HealthResult>;
  getRevision(config: SourceConfig): Promise<SourceRevision>;
  listArtifacts(config: SourceConfig): Promise<SourceArtifactRef[]>;
  readArtifact(config: SourceConfig, artifact: SourceArtifactRef): Promise<ArtifactContent>;
}

export interface DeploymentAdapter {
  readonly kind: string;
  healthCheck(config: SourceConfig): Promise<HealthResult>;
  getCurrentDeployment(config: SourceConfig): Promise<DeploymentRecord | null>;
  listRecentDeployments(config: SourceConfig, limit: number): Promise<DeploymentRecord[]>;
}

export type RegisteredAdapter = SourceAdapter | DeploymentAdapter;

export interface KnowledgeWithProvenance {
  item: KnowledgeItem;
  provenance: Provenance[];
}
