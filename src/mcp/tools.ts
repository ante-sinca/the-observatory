import type { KnowledgeType } from "../domain/types.js";
import { ProjectQueryService } from "../services/query.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const projectParameter = { type: "string", description: "Project ID or slug." };

/**
 * The MCP and HTTP interfaces share this service; it deliberately exposes no
 * observed-system write capability. Project administration remains HTTP-only.
 */
export class ObservatoryToolService {
  constructor(private readonly queries: ProjectQueryService) {}

  listTools(): McpToolDefinition[] {
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
    ];
  }

  call(name: string, input: Record<string, unknown> = {}): unknown {
    switch (name) {
      case "list_projects": return this.queries.listProjects();
      case "get_project_state": return this.queries.getProjectState(requiredString(input, "project"));
      case "search_project": return this.queries.searchProject(requiredString(input, "project"), requiredString(input, "query"), { domain: optionalString(input, "domain"), type: optionalKnowledgeType(input, "type"), limit: optionalNumber(input, "limit") });
      case "get_recent_changes": return this.queries.getRecentChanges(requiredString(input, "project"), optionalString(input, "since"));
      case "get_deployments": return this.queries.getDeployments(requiredString(input, "project"), optionalString(input, "environment"), optionalNumber(input, "limit"));
      case "get_decisions": return this.queries.getDecisions(requiredString(input, "project"), optionalString(input, "domain"));
      case "get_known_risks": return this.queries.getKnownRisks(requiredString(input, "project"));
      case "get_knowledge_item": return this.queries.getKnowledge(requiredString(input, "project"), requiredString(input, "item_id"));
      case "compare_snapshots": return this.queries.compareSnapshots(requiredString(input, "project"), requiredString(input, "from_snapshot"), requiredString(input, "to_snapshot"));
      case "get_source_artifact": return this.queries.getSourceArtifact(requiredString(input, "project"), requiredString(input, "artifact_id"));
      default: throw new Error(`Unknown or unsupported read-only tool '${name}'.`);
    }
  }
}

function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): McpToolDefinition {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`'${key}' must be a non-empty string.`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`'${key}' must be a string.`);
  return value;
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`'${key}' must be an integer.`);
  return value;
}

function optionalKnowledgeType(input: Record<string, unknown>, key: string): KnowledgeType | undefined {
  const value = optionalString(input, key);
  const types: KnowledgeType[] = ["document", "architecture", "decision", "invariant", "implementation", "test_evidence", "deployment", "integration", "risk", "issue", "planned_change", "superseded_behavior", "operational_observation"];
  if (value && !types.includes(value as KnowledgeType)) throw new Error(`'${key}' is not a supported knowledge type.`);
  return value as KnowledgeType | undefined;
}
