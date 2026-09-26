import type { Conflict, Deployment, KnowledgeItem, KnowledgeType, KnowledgeWithProvenance, Movement, Project, ProjectSource, Snapshot } from "../domain/types.js";
import { ProjectQueryService, type OnboardingSummary, type ProjectState, type ProjectSummary, type SearchOptions } from "./query.js";

/**
 * Read-only application boundary. Implementations may be backed by the local
 * deterministic arrays or by narrowly-scoped PostgreSQL queries. Keeping this
 * separate from ObservatoryStore lets request handling avoid a durable
 * full-state hydration while refreshes retain their existing write model.
 */
export interface ObservatoryReadService {
  listProjects(): Promise<ProjectSummary[]>;
  getProject(projectRef: string): Promise<Project>;
  getProjectState(projectRef: string): Promise<ProjectState>;
  getSources(projectRef: string): Promise<ProjectSource[]>;
  getOnboardingSummary(projectRef: string): Promise<OnboardingSummary>;
  getKnowledge(projectRef: string, itemId?: string): Promise<KnowledgeWithProvenance[]>;
  searchProject(projectRef: string, query: string, options?: SearchOptions): Promise<KnowledgeWithProvenance[]>;
  getRecentChanges(projectRef: string, since?: string): Promise<Movement[]>;
  getDeployments(projectRef: string, environment?: string, limit?: number): Promise<Deployment[]>;
  getDecisions(projectRef: string, domain?: string): Promise<KnowledgeWithProvenance[]>;
  getKnownRisks(projectRef: string): Promise<KnowledgeWithProvenance[]>;
  compareSnapshots(projectRef: string, fromSnapshotId: string, toSnapshotId: string): Promise<Movement[]>;
  getSourceArtifact(projectRef: string, artifactId: string): Promise<Pick<import("../domain/types.js").SourceArtifact, "id" | "path" | "revision" | "contentHash" | "content" | "metadata">>;
  sourceArtifactScope(projectRef: string, artifactId: string): Promise<"in_project" | "other_project" | "missing">;
  getCurrentSourceArtifactByPath(projectRef: string, path: string): Promise<Pick<import("../domain/types.js").SourceArtifact, "id" | "path" | "revision" | "contentHash" | "content"> | undefined>;
  searchCurrentSourceArtifacts(projectRef: string, query: string, limit?: number): Promise<Array<Pick<import("../domain/types.js").SourceArtifact, "id" | "sourceId" | "path" | "revision" | "contentHash" | "content">>>;
  getSnapshots(projectRef: string, limit?: number): Promise<Snapshot[]>;
  getSnapshot(projectRef: string, snapshotId: string): Promise<Snapshot>;
  getConflicts(projectRef: string): Promise<Conflict[]>;
  getRefreshRuns(projectRef: string): Promise<import("../domain/types.js").RefreshRun[]>;
}

/** Adapts the existing synchronous MemoryStore query service for local use. */
export class MemoryReadService implements ObservatoryReadService {
  constructor(private readonly queries: ProjectQueryService) {}

  async listProjects() { return this.queries.listProjects(); }
  async getProject(projectRef: string) { return this.queries.getProject(projectRef); }
  async getProjectState(projectRef: string) { return this.queries.getProjectState(projectRef); }
  async getSources(projectRef: string) { return this.queries.getSources(projectRef); }
  async getOnboardingSummary(projectRef: string) { return this.queries.getOnboardingSummary(projectRef); }
  async getKnowledge(projectRef: string, itemId?: string) { return this.queries.getKnowledge(projectRef, itemId); }
  async searchProject(projectRef: string, query: string, options?: SearchOptions) { return this.queries.searchProject(projectRef, query, options); }
  async getRecentChanges(projectRef: string, since?: string) { return this.queries.getRecentChanges(projectRef, since); }
  async getDeployments(projectRef: string, environment?: string, limit?: number) { return this.queries.getDeployments(projectRef, environment, limit); }
  async getDecisions(projectRef: string, domain?: string) { return this.queries.getDecisions(projectRef, domain); }
  async getKnownRisks(projectRef: string) { return this.queries.getKnownRisks(projectRef); }
  async compareSnapshots(projectRef: string, fromSnapshotId: string, toSnapshotId: string) { return this.queries.compareSnapshots(projectRef, fromSnapshotId, toSnapshotId); }
  async getSourceArtifact(projectRef: string, artifactId: string) { return this.queries.getSourceArtifact(projectRef, artifactId); }
  async sourceArtifactScope(projectRef: string, artifactId: string) { return this.queries.sourceArtifactScope(projectRef, artifactId); }
  async getCurrentSourceArtifactByPath(projectRef: string, path: string) { return this.queries.getCurrentSourceArtifactByPath(projectRef, path); }
  async searchCurrentSourceArtifacts(projectRef: string, query: string, limit?: number) { return this.queries.searchCurrentSourceArtifacts(projectRef, query, limit); }
  async getSnapshots(projectRef: string, limit?: number) { return this.queries.getSnapshots(projectRef).slice(-(limit ?? Number.MAX_SAFE_INTEGER)); }
  async getSnapshot(projectRef: string, snapshotId: string) { return this.queries.getSnapshot(projectRef, snapshotId); }
  async getConflicts(projectRef: string) { return this.queries.getConflicts(projectRef); }
  async getRefreshRuns(projectRef: string) { return this.queries.getRefreshRuns(projectRef); }
}

export type ObservatoryReadInput = ObservatoryReadService | ProjectQueryService;

export function asReadService(reads: ObservatoryReadInput): ObservatoryReadService {
  return reads instanceof ProjectQueryService ? new MemoryReadService(reads) : reads;
}

export function clampLimit(value: number | undefined, fallback: number, maximum: number): number {
  return Math.min(Math.max(value ?? fallback, 1), maximum);
}

export function knowledgeTerms(query: string): string[] {
  return query.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 1).slice(0, 8);
}

export function summary(item: KnowledgeItem): Record<string, unknown> {
  return { id: item.id, type: item.type, title: item.title, fingerprint: item.fingerprint, state: item.state };
}

export type { KnowledgeType };
