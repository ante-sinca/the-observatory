import type { ObservatoryStore } from "../core/store.js";
import type { Conflict, Deployment, KnowledgeItem, KnowledgeType, KnowledgeWithProvenance, Movement, Project, Snapshot } from "../domain/types.js";

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  repositoryRevision?: string;
  deploymentRevision?: string;
  lastRefreshAt?: string;
  unresolvedConflictCount: number;
  recentMovementCount: number;
}

export interface ProjectState {
  project: Project;
  snapshot?: Snapshot;
  sourceHealth: Snapshot["sourceHealth"];
  summary?: Snapshot["summary"];
  unresolvedConflicts: Conflict[];
  latestMovements: Movement[];
}

export interface SearchOptions {
  domain?: string;
  type?: KnowledgeType;
  limit?: number;
}

export class ProjectQueryService {
  constructor(private readonly store: ObservatoryStore) {}

  listProjects(): ProjectSummary[] {
    return this.store.projects.map((project) => {
      const snapshot = this.latestSnapshot(project.id);
      return {
        id: project.id,
        slug: project.slug,
        name: project.name,
        repositoryRevision: snapshot?.repositoryRevision,
        deploymentRevision: snapshot?.deploymentRevision,
        lastRefreshAt: this.store.refreshRuns.filter((run) => run.projectId === project.id && run.status !== "failed").at(-1)?.completedAt,
        unresolvedConflictCount: this.store.conflicts.filter((conflict) => conflict.projectId === project.id && conflict.status === "open").length,
        recentMovementCount: this.store.movements.filter((movement) => movement.projectId === project.id).slice(-5).length,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  getProject(projectRef: string): Project {
    const project = this.store.projects.find((candidate) => candidate.id === projectRef || candidate.slug === projectRef);
    if (!project) throw new Error(`Project '${projectRef}' was not found.`);
    return project;
  }

  getProjectState(projectRef: string): ProjectState {
    const project = this.getProject(projectRef);
    const snapshot = this.latestSnapshot(project.id);
    return {
      project,
      snapshot,
      sourceHealth: snapshot?.sourceHealth ?? {},
      summary: snapshot?.summary,
      unresolvedConflicts: this.store.conflicts.filter((conflict) => conflict.projectId === project.id && conflict.status === "open"),
      latestMovements: this.getRecentChanges(project.id).slice(0, 20),
    };
  }

  getKnowledge(projectRef: string, itemId?: string): KnowledgeWithProvenance[] {
    const project = this.getProject(projectRef);
    const items = this.store.knowledge.filter((item) => item.projectId === project.id && (!itemId || item.id === itemId));
    if (itemId && items.length === 0) throw new Error(`Knowledge item '${itemId}' was not found.`);
    return items.map((item) => this.withProvenance(item));
  }

  searchProject(projectRef: string, query: string, options: SearchOptions = {}): KnowledgeWithProvenance[] {
    const project = this.getProject(projectRef);
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    return this.store.knowledge
      .filter((item) => item.projectId === project.id && item.status !== "superseded")
      .filter((item) => !options.domain || item.domain === options.domain)
      .filter((item) => !options.type || item.type === options.type)
      .map((item) => ({ item, score: terms.reduce((score, term) => score + occurrences(`${item.title}\n${item.body}`.toLowerCase(), term), 0) }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.item.title.localeCompare(right.item.title))
      .slice(0, Math.min(Math.max(options.limit ?? 20, 1), 100))
      .map((result) => this.withProvenance(result.item));
  }

  getRecentChanges(projectRef: string, since?: string): Movement[] {
    const project = this.getProject(projectRef);
    const snapshotId = since && this.store.snapshots.find((snapshot) => snapshot.id === since && snapshot.projectId === project.id)?.id;
    return this.store.movements
      .filter((movement) => movement.projectId === project.id)
      .filter((movement) => !snapshotId || movement.toSnapshotId === snapshotId || movement.fromSnapshotId === snapshotId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getDeployments(projectRef: string, environment?: string, limit = 20): Deployment[] {
    const project = this.getProject(projectRef);
    return this.store.deployments
      .filter((deployment) => deployment.projectId === project.id && (!environment || deployment.environment === environment))
      .sort((a, b) => b.deployedAt.localeCompare(a.deployedAt))
      .slice(0, Math.min(Math.max(limit, 1), 100));
  }

  getDecisions(projectRef: string, domain?: string): KnowledgeWithProvenance[] {
    return this.filterKnowledge(projectRef, "decision", domain);
  }

  getKnownRisks(projectRef: string): KnowledgeWithProvenance[] {
    return this.filterKnowledge(projectRef, "risk");
  }

  compareSnapshots(projectRef: string, fromSnapshotId: string, toSnapshotId: string): Movement[] {
    const project = this.getProject(projectRef);
    const from = this.store.snapshots.find((snapshot) => snapshot.id === fromSnapshotId && snapshot.projectId === project.id);
    const to = this.store.snapshots.find((snapshot) => snapshot.id === toSnapshotId && snapshot.projectId === project.id);
    if (!from || !to) throw new Error("Both snapshots must belong to the requested project.");
    const recorded = this.store.movements.filter((movement) => movement.projectId === project.id && movement.fromSnapshotId === from.id && movement.toSnapshotId === to.id);
    if (recorded.length > 0 || from.id === to.id) return recorded;
    const byEntity = (snapshot: Snapshot) => new Map(snapshot.knowledgeItemIds.flatMap((id) => {
      const item = this.store.knowledge.find((candidate) => candidate.id === id);
      return item ? [[item.entityKey, item] as const] : [];
    }));
    const before = byEntity(from);
    const after = byEntity(to);
    const movements: Movement[] = [];
    const add = (movementType: Movement["movementType"], key: string, beforeItem?: KnowledgeItem, afterItem?: KnowledgeItem): void => {
      movements.push({ id: `comparison:${from.id}:${to.id}:${key}`, projectId: project.id, fromSnapshotId: from.id, toSnapshotId: to.id, movementType, entityType: afterItem?.type ?? beforeItem?.type ?? "state", entityKey: key, before: beforeItem ? summary(beforeItem) : undefined, after: afterItem ? summary(afterItem) : undefined, createdAt: to.createdAt });
    };
    for (const [key, item] of after) {
      const prior = before.get(key);
      if (!prior) add("added", key, undefined, item);
      else if (prior.fingerprint !== item.fingerprint) add("changed", key, prior, item);
    }
    for (const [key, item] of before) if (!after.has(key)) add("removed", key, item);
    if (from.deploymentRevision !== to.deploymentRevision) add("deployed", "deployment:current");
    return movements;
  }

  getSourceArtifact(projectRef: string, artifactId: string): Pick<import("../domain/types.js").SourceArtifact, "id" | "path" | "revision" | "contentHash" | "content" | "metadata"> {
    const project = this.getProject(projectRef);
    const artifact = this.store.artifacts.find((candidate) => candidate.id === artifactId && candidate.projectId === project.id);
    if (!artifact || artifact.content === undefined) throw new Error("Safe indexed artifact was not found.");
    return { id: artifact.id, path: artifact.path, revision: artifact.revision, contentHash: artifact.contentHash, content: artifact.content, metadata: artifact.metadata };
  }

  getSnapshots(projectRef: string): Snapshot[] {
    const project = this.getProject(projectRef);
    return this.store.snapshots.filter((snapshot) => snapshot.projectId === project.id);
  }

  getSnapshot(projectRef: string, snapshotId: string): Snapshot {
    const snapshot = this.getSnapshots(projectRef).find((candidate) => candidate.id === snapshotId);
    if (!snapshot) throw new Error(`Snapshot '${snapshotId}' was not found.`);
    return snapshot;
  }

  getConflicts(projectRef: string): Conflict[] {
    const project = this.getProject(projectRef);
    return this.store.conflicts.filter((conflict) => conflict.projectId === project.id && conflict.status === "open");
  }

  getRefreshRuns(projectRef: string) {
    const project = this.getProject(projectRef);
    return this.store.refreshRuns.filter((run) => run.projectId === project.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private filterKnowledge(projectRef: string, type: KnowledgeType, domain?: string): KnowledgeWithProvenance[] {
    const project = this.getProject(projectRef);
    return this.store.knowledge.filter((item) => item.projectId === project.id && item.type === type && item.status !== "superseded" && (!domain || item.domain === domain)).map((item) => this.withProvenance(item));
  }

  private withProvenance(item: KnowledgeItem): KnowledgeWithProvenance {
    return { item, provenance: this.store.provenance.filter((source) => source.knowledgeItemId === item.id) };
  }

  private latestSnapshot(projectId: string): Snapshot | undefined {
    return this.store.snapshots.filter((snapshot) => snapshot.projectId === projectId).at(-1);
  }
}

function occurrences(text: string, term: string): number {
  let count = 0;
  let offset = text.indexOf(term);
  while (offset >= 0) {
    count += 1;
    offset = text.indexOf(term, offset + term.length);
  }
  return count;
}

function summary(item: KnowledgeItem): Record<string, unknown> {
  return { id: item.id, type: item.type, title: item.title, fingerprint: item.fingerprint, state: item.state };
}
