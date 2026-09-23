import { randomUUID } from "node:crypto";
import { sha256 } from "../core/security.js";
import type { KnowledgeItem, KnowledgeType, Provenance, SourceArtifact, StateDimensions } from "../domain/types.js";

export interface ExtractedKnowledge {
  item: Omit<KnowledgeItem, "id" | "createdAt" | "validFromSnapshotId" | "validToSnapshotId">;
  provenance: Omit<Provenance, "id" | "knowledgeItemId">;
}

function dimensions(type: KnowledgeType): StateDimensions {
  return {
    documented: ["document", "architecture", "decision", "invariant", "planned_change", "risk"].includes(type) ? "evidenced" : "unknown",
    implemented: type === "implementation" ? "evidenced" : "unknown",
    tested: type === "test_evidence" ? "evidenced" : "unknown",
    deployed: type === "deployment" ? "evidenced" : "unknown",
    observed: type === "operational_observation" ? "evidenced" : "unknown",
  };
}

function kindForMarkdown(path: string): KnowledgeType {
  const lower = path.toLowerCase();
  if (/(^|\/)(adr|decision)[-_/.]/.test(lower) || lower.includes("architecture-decision")) return "decision";
  if (lower.includes("architecture")) return "architecture";
  if (lower.includes("risk")) return "risk";
  return "document";
}

function compact(value: string): string {
  return value.replace(/\r/g, "").trim().replace(/\n{3,}/g, "\n\n");
}

function assertionCandidates(projectId: string, artifact: SourceArtifact, type: "invariant" | "implementation"): ExtractedKnowledge[] {
  const results: ExtractedKnowledge[] = [];
  const lines = (artifact.content ?? "").replace(/\r/g, "").split("\n");
  for (const [index, line] of lines.entries()) {
    // Deliberately explicit: this is a deterministic v0.1 conflict signal,
    // not an attempt to infer product semantics from arbitrary code.
    const match = line.match(/observatory:assert\s+([a-z0-9][a-z0-9_.-]*)\s*=\s*([^\s<]+)(?:\s*-->)?\s*$/i);
    if (!match) continue;
    const [, key, value] = match;
    results.push(extracted(projectId, artifact, type, `Assertion: ${key}`, `${key} = ${value}`, index + 1, index + 1));
  }
  return results;
}

function extracted(projectId: string, artifact: SourceArtifact, type: KnowledgeType, title: string, body: string, startLine: number, endLine: number): ExtractedKnowledge {
  const normalizedBody = compact(body);
  const entityKey = `${artifact.path}:${type}:${title.toLowerCase()}`;
  return {
    item: {
      projectId,
      type,
      title,
      body: normalizedBody,
      status: "current",
      state: dimensions(type),
      fingerprint: sha256(`${type}\u0000${artifact.path}\u0000${title}\u0000${normalizedBody}`),
      entityKey,
    },
    provenance: {
      sourceArtifactId: artifact.id,
      sourceType: "repository",
      sourceRef: artifact.externalId,
      repositoryCommit: artifact.revision,
      path: artifact.path,
      startLine,
      endLine,
      metadata: { extractor: "deterministic-v0.1" },
    },
  };
}

/**
 * This deliberately performs deterministic extraction only. It turns Markdown
 * headings and test declarations into inspectable evidence instead of claiming
 * ungrounded semantic facts.
 */
export function extractKnowledge(projectId: string, artifact: SourceArtifact): ExtractedKnowledge[] {
  const content = artifact.content ?? "";
  const path = artifact.path.toLowerCase();
  const lines = content.replace(/\r/g, "").split("\n");
  const results: ExtractedKnowledge[] = [];

  if (/\.(md|mdx|txt)$/i.test(path)) {
    const headingIndexes = lines.flatMap((line, index) => /^#{1,6}\s+(.+?)\s*$/.test(line) ? [index] : []);
    if (headingIndexes.length === 0) {
      results.push(extracted(projectId, artifact, kindForMarkdown(path), `Document: ${artifact.path}`, content, 1, lines.length));
    } else {
      for (const [headingPosition, start] of headingIndexes.entries()) {
        const title = lines[start]?.replace(/^#{1,6}\s+/, "").trim() || artifact.path;
        const end = (headingIndexes[headingPosition + 1] ?? lines.length) - 1;
        results.push(extracted(projectId, artifact, kindForMarkdown(path), title, lines.slice(start, end + 1).join("\n"), start + 1, end + 1));
      }
    }
    results.push(...assertionCandidates(projectId, artifact, "invariant"));
    return results;
  }

  if (/(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) {
    const testDeclarations = lines.flatMap((line, index) => {
      const match = line.match(/\b(?:it|test|describe)\s*\(\s*[`'\"]([^`'\"]+)/);
      return match ? [{ title: match[1]!, line: index }] : [];
    });
    for (const declaration of testDeclarations) {
      results.push(extracted(projectId, artifact, "test_evidence", declaration.title, lines[declaration.line] ?? declaration.title, declaration.line + 1, declaration.line + 1));
    }
    if (results.length === 0) results.push(extracted(projectId, artifact, "test_evidence", `Test file: ${artifact.path}`, content.slice(0, 10_000), 1, lines.length));
    return results;
  }

  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|cs)$/i.test(path)) {
    results.push(extracted(projectId, artifact, "implementation", `Implementation: ${artifact.path}`, `Implementation evidence indexed from ${artifact.path}.`, 1, 1));
    results.push(...assertionCandidates(projectId, artifact, "implementation"));
  }
  return results;
}

export function materializeExtracted(extractedItem: ExtractedKnowledge, now: string): { item: KnowledgeItem; provenance: Provenance } {
  const item: KnowledgeItem = { ...extractedItem.item, id: randomUUID(), createdAt: now };
  return { item, provenance: { ...extractedItem.provenance, id: randomUUID(), knowledgeItemId: item.id } };
}
