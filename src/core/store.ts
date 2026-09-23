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

/** The provider-managed Vercel/Neon connection. Values are never logged. */
export function databaseUrlFromEnvironment(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  // POSTGRES_URL is the pooled connection created by the verified Neon/Vercel
  // integration. Fall back only for explicitly compatible local environments.
  return environment.POSTGRES_URL ?? environment.DATABASE_URL ?? environment.NEON_DATABASE_URL;
}

/** Migrations use Neon's direct URL when the integration supplies one. */
export function migrationDatabaseUrlFromEnvironment(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  return environment.POSTGRES_URL_NON_POOLING ?? environment.DATABASE_URL_UNPOOLED ?? databaseUrlFromEnvironment(environment);
}

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
  /** Wait until this store has loaded its durable state. MemoryStore is ready immediately. */
  ready(): Promise<void>;
  /** Persist all state changed by the enclosing service operation. */
  flush(): Promise<void>;
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

  async ready(): Promise<void> { /* intentionally in-memory */ }
  async flush(): Promise<void> { /* intentionally in-memory */ }
}

export function byId<T extends { id: string }>(items: T[], id: string): T | undefined {
  return items.find((item) => item.id === id);
}
