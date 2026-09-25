import { safeText } from "../core/security.js";
import type { KnowledgeType, Movement, SourceArtifact } from "../domain/types.js";
import { oauthScopeForTool } from "./oauth.js";
import { AskProjectService } from "../services/ask-project.js";
import { ProjectQueryService } from "../services/query.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true; destructiveHint: false; openWorldHint: false };
  securitySchemes?: Array<{ type: "oauth2"; scopes: string[] }>;
}

export type McpToolErrorCode =
  | "project_not_found"
  | "invalid_question"
  | "invalid_query"
  | "evidence_not_found"
  | "evidence_not_in_project"
  | "invalid_path"
  | "excerpt_range_too_large"
  | "insufficient_evidence"
  | "internal_error";

/** A deliberately small, machine-readable failure surface for remote callers. */
export class McpToolError extends Error {
  constructor(readonly code: McpToolErrorCode, message = code) {
    super(message);
    this.name = "McpToolError";
  }
}

const projectParameter = { type: "string", minLength: 1, maxLength: 160, description: "Project slug or ID from list_projects." };
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const MAX_QUERY_LENGTH = 500;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_RESULTS = 10;
const MAX_MOVEMENTS = 20;
const MAX_EXCERPT_LINES = 80;
const MAX_EXCERPT_CHARACTERS = 6_000;

/**
 * The browser HTTP API and both MCP transports share this service. It is a
 * narrow read capability: it cannot register projects, refresh sources, or
 * access source configuration or credentials.
 */
export class ObservatoryToolService {
  constructor(private readonly queries: ProjectQueryService, private readonly askProject?: AskProjectService, private readonly profile: "remote" | "local" = "remote") {}

  listTools(): McpToolDefinition[] {
    if (this.profile === "local") return this.localTools();
    return [
      definition("list_projects", "List registered projects and their current, revision-aware summaries.", {}),
      definition("get_project_state", "Get a project's current resolved snapshot, revisions, source health, and conflict count.", { project: projectParameter }, ["project"]),
      definition("search_project", "Search current project knowledge and return bounded, redacted provenance-backed results.", { project: projectParameter, query: { type: "string", minLength: 1, maxLength: MAX_QUERY_LENGTH }, limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS } }, ["project", "query"]),
      definition("get_evidence", "Read bounded, redacted evidence for a known artifact ID within one project.", { project: projectParameter, artifact_id: { type: "string", minLength: 1, maxLength: 256 } }, ["project", "artifact_id"]),
      definition("get_file_excerpt", "Read a bounded, redacted line excerpt from an observed current project path.", { project: projectParameter, path: { type: "string", minLength: 1, maxLength: 512 }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } }, ["project", "path"]),
      definition("get_recent_movements", "Get up to 20 recent observed movements for a project.", { project: projectParameter }, ["project"]),
      definition("ask_project", "Ask a bounded, evidence-backed question about one project's current observed snapshot.", { project: projectParameter, question: { type: "string", minLength: 1, maxLength: MAX_QUESTION_LENGTH } }, ["project", "question"]),
    ];
  }

  call(name: string, input: Record<string, unknown> = {}): unknown {
    if (this.profile === "local") return this.callLocal(name, input);
    switch (name) {
      case "list_projects":
        return listProjectsForMcp(this.queries.listProjects());
      case "get_project_state":
        return this.projectState(requiredProject(input));
      case "search_project":
        return this.searchProject(requiredProject(input), requiredBoundedString(input, "query", "invalid_query", MAX_QUERY_LENGTH), optionalBoundedInteger(input, "limit", 1, MAX_RESULTS) ?? 5);
      case "get_evidence":
        return this.getEvidence(requiredProject(input), requiredBoundedString(input, "artifact_id", "invalid_query", 256));
      case "get_file_excerpt":
        return this.getFileExcerpt(requiredProject(input), requiredPath(input), optionalBoundedInteger(input, "start_line", 1, Number.MAX_SAFE_INTEGER), optionalBoundedInteger(input, "end_line", 1, Number.MAX_SAFE_INTEGER));
      case "get_recent_movements":
        return this.getRecentMovements(requiredProject(input));
      case "ask_project":
        return this.ask(requiredProject(input), requiredBoundedString(input, "question", "invalid_question", MAX_QUESTION_LENGTH));
      default: throw new McpToolError("invalid_query");
    }
  }

  private localTools(): McpToolDefinition[] {
    return [
      definition("list_projects", "List registered projects and their current summaries.", {}),
      definition("get_project_state", "Get the latest resolved state, source health, conflicts, and movements.", { project: projectParameter }, ["project"]),
      definition("search_project", "Search current project knowledge with provenance.", { project: projectParameter, query: { type: "string" }, domain: { type: "string" }, type: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["project", "query"]),
      definition("get_recent_changes", "Get movements since a snapshot.", { project: projectParameter, since: { type: "string" } }, ["project"]),
      definition("get_deployments", "Get observed deployments.", { project: projectParameter, environment: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["project"]),
      definition("get_decisions", "Get current decision records.", { project: projectParameter, domain: { type: "string" } }, ["project"]),
      definition("get_known_risks", "Get current known risks.", { project: projectParameter }, ["project"]),
      definition("get_knowledge_item", "Get a knowledge item and its provenance.", { project: projectParameter, item_id: { type: "string" } }, ["project", "item_id"]),
      definition("compare_snapshots", "Get recorded movements between two snapshots.", { project: projectParameter, from_snapshot: { type: "string" }, to_snapshot: { type: "string" } }, ["project", "from_snapshot", "to_snapshot"]),
      definition("get_source_artifact", "Get safe indexed artifact text only; excluded artifacts cannot be returned.", { project: projectParameter, artifact_id: { type: "string" } }, ["project", "artifact_id"]),
      definition("ask_project", "Ask an evidence-backed question about one project's current observed snapshot.", { project: projectParameter, question: { type: "string", minLength: 1, maxLength: MAX_QUESTION_LENGTH } }, ["project", "question"]),
    ];
  }

  private callLocal(name: string, input: Record<string, unknown>): unknown {
    switch (name) {
      case "get_recent_changes": return this.queries.getRecentChanges(localRequiredString(input, "project"), localOptionalString(input, "since"));
      case "get_deployments": return this.queries.getDeployments(localRequiredString(input, "project"), localOptionalString(input, "environment"), localOptionalNumber(input, "limit"));
      case "get_decisions": return this.queries.getDecisions(localRequiredString(input, "project"), localOptionalString(input, "domain"));
      case "get_known_risks": return this.queries.getKnownRisks(localRequiredString(input, "project"));
      case "get_knowledge_item": return this.queries.getKnowledge(localRequiredString(input, "project"), localRequiredString(input, "item_id"));
      case "compare_snapshots": return this.queries.compareSnapshots(localRequiredString(input, "project"), localRequiredString(input, "from_snapshot"), localRequiredString(input, "to_snapshot"));
      case "get_source_artifact": return this.queries.getSourceArtifact(localRequiredString(input, "project"), localRequiredString(input, "artifact_id"));
      case "ask_project": {
        if (!this.askProject) throw new Error("Ask Project is not configured.");
        return this.askProject.ask(localRequiredString(input, "project"), localRequiredString(input, "question"));
      }
      case "list_projects": return this.queries.listProjects();
      case "get_project_state": return this.queries.getProjectState(localRequiredString(input, "project"));
      case "search_project": return this.queries.searchProject(localRequiredString(input, "project"), localRequiredString(input, "query"), { domain: localOptionalString(input, "domain"), type: localOptionalKnowledgeType(input, "type"), limit: localOptionalNumber(input, "limit") });
      default: throw new Error(`Unknown or unsupported read-only tool '${name}'.`);
    }
  }

  private projectState(projectRef: string): unknown {
    const state = this.stateFor(projectRef);
    return {
      project: { slug: state.project.slug, name: redacted(state.project.name, 160), status: state.project.status },
      current: state.snapshot ? {
        snapshotId: redacted(state.snapshot.id, 160),
        observedAt: redacted(state.snapshot.createdAt, 64),
        repositoryRevision: optionalRedacted(state.snapshot.repositoryRevision, 256),
        deploymentRevision: optionalRedacted(state.snapshot.deploymentRevision, 256),
        resolution: state.snapshot.summary.resolution,
        knowledgeCount: state.snapshot.summary.knowledgeCount,
      } : undefined,
      sourceHealth: Object.fromEntries(Object.entries(state.sourceHealth).slice(0, 20).map(([sourceId, health]) => [redacted(sourceId, 160), { state: health.state, checkedAt: redacted(health.checkedAt, 64) }])),
      unresolvedConflictCount: state.unresolvedConflicts.length,
      recentMovementCount: state.latestMovements.length,
    };
  }

  private searchProject(projectRef: string, query: string, limit: number): unknown {
    const project = this.projectFor(projectRef);
    const state = this.stateFor(project.id);
    const currentIds = new Set(state.snapshot?.knowledgeItemIds ?? []);
    const currentRecords = this.queries.searchProject(project.id, query, { limit: MAX_RESULTS })
      .filter((record) => currentIds.has(record.item.id));
    const records = currentRecords
      .slice(0, limit)
      .map((record) => ({
      title: redacted(record.item.title, 300),
      type: record.item.type,
      domain: record.item.domain,
      state: record.item.state,
      evidence: record.provenance.slice(0, 3).map((provenance) => ({
        artifactId: optionalRedacted(provenance.sourceArtifactId, 256),
        path: optionalRedacted(provenance.path, 512),
        repositoryRevision: optionalRedacted(provenance.repositoryCommit, 256),
        startLine: provenance.startLine,
        endLine: provenance.endLine,
        reason: "Current project knowledge matched the requested query.",
      })),
        summary: redacted(record.item.body, 1_000),
      }));
    return {
      project: redacted(project.slug, 160),
      repositoryRevision: optionalRedacted(state.snapshot?.repositoryRevision, 256),
      results: records,
      truncated: currentRecords.length > records.length || currentRecords.length === MAX_RESULTS,
    };
  }

  private getEvidence(projectRef: string, artifactId: string): unknown {
    const project = this.projectFor(projectRef);
    const state = this.stateFor(project.id);
    const scope = this.queries.sourceArtifactScope(project.id, artifactId);
    if (scope === "other_project") throw new McpToolError("evidence_not_in_project");
    if (scope === "missing") throw new McpToolError("evidence_not_found");
    let artifact: Pick<SourceArtifact, "id" | "path" | "revision" | "contentHash" | "content">;
    try {
      artifact = this.queries.getSourceArtifact(project.id, artifactId);
    } catch {
      // An in-project artifact may still be unavailable because it is binary
      // or was excluded by the safe-ingestion policy.
      throw new McpToolError("evidence_not_found");
    }
    if (!state.snapshot?.repositoryRevision || artifact.revision !== state.snapshot.repositoryRevision) throw new McpToolError("evidence_not_found");
    return { project: redacted(project.slug, 160), ...boundedArtifact(artifact, 1, MAX_EXCERPT_LINES) };
  }

  private getFileExcerpt(projectRef: string, path: string, startLine?: number, endLine?: number): unknown {
    const project = this.projectFor(projectRef);
    const artifact = this.queries.getCurrentSourceArtifactByPath(project.id, path);
    if (!artifact) throw new McpToolError("evidence_not_found");
    const totalLines = (artifact.content ?? "").split("\n").length;
    const start = startLine ?? 1;
    const end = endLine ?? Math.min(totalLines, start + 39);
    if (end < start || end - start + 1 > MAX_EXCERPT_LINES) throw new McpToolError("excerpt_range_too_large");
    return { project: redacted(project.slug, 160), ...boundedArtifact(artifact, start, end) };
  }

  private getRecentMovements(projectRef: string): unknown {
    const project = this.projectFor(projectRef);
    const state = this.stateFor(project.id);
    const allMovements = this.queries.getRecentChanges(project.id);
    const movements = allMovements.slice(0, MAX_MOVEMENTS).map(movementForMcp);
    return { project: redacted(project.slug, 160), repositoryRevision: optionalRedacted(state.snapshot?.repositoryRevision, 256), movements, truncated: allMovements.length > MAX_MOVEMENTS };
  }

  private async ask(projectRef: string, question: string): Promise<unknown> {
    const project = this.projectFor(projectRef);
    if (!this.askProject) throw new McpToolError("internal_error");
    const response = await this.askProject.ask(project.id, question);
    return {
      project: redacted(response.project, 160),
      projectName: redacted(response.projectName, 160),
      status: response.status,
      repositoryRevision: optionalRedacted(response.repositoryRevision, 256),
      answer: redacted(response.answer, 4_000),
      evidence: response.evidence.slice(0, 8).map((evidence) => ({
        artifactId: optionalRedacted(evidence.artifactId, 256),
        sourceId: optionalRedacted(evidence.sourceId, 256),
        path: optionalRedacted(evidence.path, 512),
        repositoryRevision: optionalRedacted(evidence.repositoryRevision, 256),
        contentHash: optionalRedacted(evidence.contentHash, 256),
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        role: evidence.role,
        reason: redacted(evidence.reason, 500),
      })),
      conflicts: response.conflicts.slice(0, 8).map((conflict) => ({
        id: redacted(conflict.id, 160),
        type: conflict.type,
        severity: conflict.severity,
        title: redacted(conflict.title, 300),
        description: redacted(conflict.description, 1_000),
        evidence: boundedObject(conflict.evidence),
      })),
    };
  }

  private projectFor(projectRef: string) {
    try { return this.queries.getProject(projectRef); } catch { throw new McpToolError("project_not_found"); }
  }

  private stateFor(projectRef: string) {
    try { return this.queries.getProjectState(projectRef); } catch { throw new McpToolError("project_not_found"); }
  }
}

function listProjectsForMcp(projects: ReturnType<ProjectQueryService["listProjects"]>) {
  const visible = projects.slice(0, 100).map((project) => ({
    id: redacted(project.id, 160),
    slug: redacted(project.slug, 160),
    name: redacted(project.name, 160),
    repositoryRevision: optionalRedacted(project.repositoryRevision, 256),
    deploymentRevision: optionalRedacted(project.deploymentRevision, 256),
    lastRefreshAt: optionalRedacted(project.lastRefreshAt, 64),
    unresolvedConflictCount: project.unresolvedConflictCount,
    recentMovementCount: project.recentMovementCount,
  }));
  return { projects: visible, truncated: projects.length > visible.length };
}

function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): McpToolDefinition {
  const scope = oauthScopeForTool(name);
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: readOnlyAnnotations,
    ...(scope ? { securitySchemes: [{ type: "oauth2" as const, scopes: [scope] }] } : {}),
  };
}

function requiredProject(input: Record<string, unknown>): string {
  return requiredBoundedString(input, "project", "invalid_query", 160);
}

function requiredBoundedString(input: Record<string, unknown>, key: string, code: McpToolErrorCode, maxLength: number): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new McpToolError(code);
  return value.trim();
}

function optionalBoundedInteger(input: Record<string, unknown>, key: string, minimum: number, maximum: number): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) throw new McpToolError(key === "start_line" || key === "end_line" ? "excerpt_range_too_large" : "invalid_query");
  return value;
}

function localRequiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`'${key}' must be a non-empty string.`);
  return value;
}

function localOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`'${key}' must be a string.`);
  return value;
}

function localOptionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`'${key}' must be an integer.`);
  return value;
}

function localOptionalKnowledgeType(input: Record<string, unknown>, key: string): KnowledgeType | undefined {
  const value = localOptionalString(input, key);
  const types: KnowledgeType[] = ["document", "architecture", "decision", "invariant", "implementation", "test_evidence", "deployment", "integration", "risk", "issue", "planned_change", "superseded_behavior", "operational_observation"];
  if (value && !types.includes(value as KnowledgeType)) throw new Error(`'${key}' is not a supported knowledge type.`);
  return value as KnowledgeType | undefined;
}

function requiredPath(input: Record<string, unknown>): string {
  const path = requiredBoundedString(input, "path", "invalid_path", 512);
  if (path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new McpToolError("invalid_path");
  return path;
}

function boundedArtifact(artifact: Pick<SourceArtifact, "id" | "path" | "revision" | "contentHash" | "content">, startLine: number, endLine: number) {
  const lines = (artifact.content ?? "").split("\n");
  const selected = lines.slice(Math.max(0, startLine - 1), Math.max(0, endLine));
  const rawExcerpt = selected.join("\n");
  const excerpt = redacted(rawExcerpt, MAX_EXCERPT_CHARACTERS);
  return {
    artifactId: redacted(artifact.id, 256),
    path: redacted(artifact.path, 512),
    repositoryRevision: redacted(artifact.revision, 256),
    contentHash: redacted(artifact.contentHash, 256),
    startLine,
    endLine: Math.min(endLine, lines.length),
    excerpt,
    truncated: selected.length < lines.length || excerpt.length < safeText(rawExcerpt).length,
  };
}

function movementForMcp(movement: Movement) {
  return {
    movementType: movement.movementType,
    entityType: redacted(movement.entityType, 120),
    entityKey: redacted(movement.entityKey, 300),
    fromSnapshotId: optionalRedacted(movement.fromSnapshotId, 160),
    toSnapshotId: redacted(movement.toSnapshotId, 160),
    observedAt: redacted(movement.createdAt, 64),
    before: boundedObject(movement.before),
    after: boundedObject(movement.after),
  };
}

function boundedObject(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, field]) => [
    redacted(key, 100),
    typeof field === "string" ? redacted(field, 500) : typeof field === "number" || typeof field === "boolean" || field === null ? field : "[OMITTED]",
  ]));
}

function redacted(value: string, maxLength: number): string {
  return safeText(value).slice(0, maxLength);
}

function optionalRedacted(value: string | undefined, maxLength: number): string | undefined {
  return value === undefined ? undefined : redacted(value, maxLength);
}
