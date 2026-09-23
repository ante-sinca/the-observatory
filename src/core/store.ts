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

/**
 * The application relies on this repository boundary, not a vendor API.  The
 * in-memory implementation makes refresh deterministic and fully testable;
 * the supplied SQL migration is the production PostgreSQL schema.
 */
export interface ObservatoryStore {
  projects: Project[];
  sources: ProjectSource[];
  refreshRuns: RefreshRun[];
  artifacts: SourceArtifact[];
  knowledge: KnowledgeItem[];
  provenance: Provenance[];
  deployments: Deployment[];
  snapshots: Snapshot[];
  movements: Movement[];
  conflicts: Conflict[];
  auditEvents: AuditEvent[];
}

export class MemoryStore implements ObservatoryStore {
  projects: Project[] = [];
  sources: ProjectSource[] = [];
  refreshRuns: RefreshRun[] = [];
  artifacts: SourceArtifact[] = [];
  knowledge: KnowledgeItem[] = [];
  provenance: Provenance[] = [];
  deployments: Deployment[] = [];
  snapshots: Snapshot[] = [];
  movements: Movement[] = [];
  conflicts: Conflict[] = [];
  auditEvents: AuditEvent[] = [];
}

export function byId<T extends { id: string }>(items: T[], id: string): T | undefined {
  return items.find((item) => item.id === id);
}
