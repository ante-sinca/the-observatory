import { isAllowedArtifact, safeText } from "../core/security.js";
import type { ObservatoryStore } from "../core/store.js";
import type { Conflict, KnowledgeItem, Project, Provenance, Snapshot, SourceArtifact } from "../domain/types.js";
import { ProjectQueryService } from "./query.js";

export type QuestionIntent = "location" | "behavior" | "change_path" | "history" | "tests" | "state_config";
export type AskProjectStatus = "verified_current" | "partial" | "insufficient_evidence" | "conflicted";
export type EvidenceRole = "runtime_implementation" | "configuration" | "database_schema" | "migration" | "historical_configuration" | "admin_ui" | "test" | "documentation" | "deployment_evidence" | "other";

/** Stable, public provenance returned by the Ask HTTP endpoint and future MCP tool. */
export interface AskProjectEvidence {
  artifactId?: string;
  sourceId?: string;
  path?: string;
  repositoryRevision?: string;
  contentHash?: string;
  startLine?: number;
  endLine?: number;
  role: EvidenceRole;
  reason: string;
}

export interface AskProjectConflict {
  id: string;
  type: Conflict["type"];
  severity: Conflict["severity"];
  title: string;
  description: string;
  evidence: Record<string, unknown>;
}

export interface AskProjectResponse {
  project: string;
  projectName: string;
  question: string;
  status: AskProjectStatus;
  repositoryRevision?: string;
  answer: string;
  evidence: AskProjectEvidence[];
  conflicts: AskProjectConflict[];
}

interface AnswerEvidence extends AskProjectEvidence {
  /** A short, redacted line-level extract; never returned as a separate API field. */
  excerpt?: string;
  title?: string;
  current: boolean;
}

export interface EvidenceBundle {
  snapshot?: Snapshot;
  selected: AnswerEvidence[];
  conflicts: AskProjectConflict[];
}

export interface ProjectAnswerGenerator {
  answer(input: {
    project: Project;
    question: string;
    intent: QuestionIntent;
    status: AskProjectStatus;
    evidence: EvidenceBundle;
  }): Promise<string>;
}

interface Candidate {
  artifact?: SourceArtifact;
  item?: KnowledgeItem;
  provenance?: Provenance;
  role: EvidenceRole;
  current: boolean;
  score: number;
  matchedTerms: string[];
  primaryMatches: string[];
  primaryLineMatches: number;
  line?: { startLine: number; endLine: number; excerpt: string; primaryMatchCount: number };
}

const MAX_QUESTION_LENGTH = 2_000;
const MAX_EVIDENCE = 8;
const STOP_WORDS = new Set(["a", "an", "and", "are", "at", "be", "can", "code", "contain", "contains", "current", "defined", "do", "does", "for", "from", "how", "i", "in", "is", "it", "me", "of", "or", "particular", "safely", "the", "this", "to", "value", "values", "what", "where", "which", "with", "would", "you"]);

/**
 * Deterministic, project-scoped retrieval over the durable snapshot read
 * model. It intentionally has no adapters, credentials, write methods, or
 * external model dependency.
 */
export class AskProjectService {
  constructor(
    private readonly store: ObservatoryStore,
    private readonly queries: ProjectQueryService,
    private readonly generator: ProjectAnswerGenerator = new DeterministicProjectAnswerGenerator(),
  ) {}

  async ask(projectRef: string, rawQuestion: string): Promise<AskProjectResponse> {
    const question = validateQuestion(rawQuestion);
    const project = this.queries.getProject(projectRef);
    const snapshot = latestSnapshot(this.store, project.id);
    const intent = classifyQuestionIntent(question);
    const candidates = snapshot ? this.retrieve(project.id, snapshot, question, intent) : [];
    const selected = selectEvidence(candidates, intent);
    const conflicts = snapshot ? this.relevantConflicts(project.id, snapshot, question, selected) : [];
    const status = answerStatus(snapshot, selected, conflicts, intent);
    const answer = await this.generator.answer({ project, question, intent, status, evidence: { snapshot, selected, conflicts } });

    return {
      project: project.slug,
      projectName: project.name,
      question,
      status,
      repositoryRevision: snapshot?.repositoryRevision,
      answer: safeText(answer),
      evidence: selected.map(({ excerpt: _excerpt, title: _title, current: _current, ...evidence }) => evidence),
      conflicts,
    };
  }

  private retrieve(projectId: string, snapshot: Snapshot, question: string, intent: QuestionIntent): Candidate[] {
    const terms = expandedTerms(question);
    const primary = primaryTerms(question);
    const topical = topicalTerms(question);
    if (terms.length === 0) return [];
    const currentItems = snapshot.knowledgeItemIds.flatMap((id) => {
      const item = this.store.knowledge.find((candidate) => candidate.id === id && candidate.projectId === projectId);
      return item ? [item] : [];
    });
    const currentItemIds = new Set(currentItems.map((item) => item.id));
    const candidates: Candidate[] = [];

    // Snapshot knowledge gives the strongest membership signal. Artifact
    // content supplies precise line locations where that content is durable.
    for (const item of currentItems) {
      const provenance = this.store.provenance.filter((candidate) => candidate.knowledgeItemId === item.id);
      if (provenance.length === 0) candidates.push(this.candidateFor(projectId, item, undefined, undefined, true, terms, primary, intent));
      for (const source of provenance) {
        const artifact = source.sourceArtifactId
          ? this.store.artifacts.find((candidate) => candidate.id === source.sourceArtifactId && candidate.projectId === projectId)
          : undefined;
        candidates.push(this.candidateFor(projectId, item, source, artifact, true, terms, primary, intent));
      }
    }

    // Some source files deliberately produce no knowledge record yet are still
    // indexed current evidence. Keep them project- and revision-scoped.
    for (const artifact of this.store.artifacts) {
      if (artifact.projectId !== projectId || artifact.content === undefined || !isAllowedArtifact(artifact.path)) continue;
      if (artifact.revision !== snapshot.repositoryRevision) continue;
      const alreadyCovered = candidates.some((candidate) => candidate.artifact?.id === artifact.id);
      if (!alreadyCovered) candidates.push(this.candidateFor(projectId, undefined, undefined, artifact, true, terms, primary, intent));
    }

    // Historical questions may inspect prior durable evidence, but it is never
    // relabelled as current editable implementation.
    if (intent === "history") {
      for (const item of this.store.knowledge) {
        if (item.projectId !== projectId || currentItemIds.has(item.id)) continue;
        const provenance = this.store.provenance.filter((candidate) => candidate.knowledgeItemId === item.id);
        for (const source of provenance) {
          const artifact = source.sourceArtifactId
            ? this.store.artifacts.find((candidate) => candidate.id === source.sourceArtifactId && candidate.projectId === projectId)
            : undefined;
          candidates.push(this.candidateFor(projectId, item, source, artifact, false, terms, primary, intent));
        }
      }
    }

    return candidates.filter((candidate) => candidate.score > 0 && (topical.length === 0 || candidate.matchedTerms.some((term) => topical.includes(term))) && (primary.length === 0 || candidate.primaryMatches.length > 0) && (primary.length < 2 || candidate.primaryLineMatches >= 2));
  }

  private candidateFor(projectId: string, item: KnowledgeItem | undefined, provenance: Provenance | undefined, artifact: SourceArtifact | undefined, current: boolean, terms: string[], primary: string[], intent: QuestionIntent): Candidate {
    // Project checks on every source prevent a malformed provenance relation
    // from ever crossing the service boundary, even before database triggers.
    if (item && item.projectId !== projectId) throw new Error("Evidence does not belong to the requested project.");
    if (artifact && artifact.projectId !== projectId) throw new Error("Evidence does not belong to the requested project.");
    const role = evidenceRole(artifact?.path ?? provenance?.path, item);
    const path = artifact?.path ?? provenance?.path ?? "";
    const title = item?.title ?? "";
    const body = item?.body ?? "";
    const content = artifact?.content ?? "";
    const match = scoreText(path, title, body, content, terms, primary);
    const line = artifact?.content ? locateLine(artifact.content, terms, primary) : undefined;
    const provenanceLine = line ? undefined : validRange(provenance);
    const score = match.score + intentWeight(intent, role) + (current ? 10 : 0);
    return {
      artifact,
      item,
      provenance,
      role,
      current,
      score,
      matchedTerms: match.terms,
      primaryMatches: match.primary,
      primaryLineMatches: line?.primaryMatchCount ?? 0,
      line: line ?? provenanceLine,
    };
  }

  private relevantConflicts(projectId: string, snapshot: Snapshot, question: string, selected: AnswerEvidence[]): AskProjectConflict[] {
    const terms = expandedTerms(question);
    const topical = topicalTerms(question);
    const selectedArtifactIds = new Set(selected.map((item) => item.artifactId).filter((id): id is string => Boolean(id)));
    const selectedPaths = new Set(selected.map((item) => item.path).filter((path): path is string => Boolean(path)));
    return this.store.conflicts
      .filter((conflict) => conflict.projectId === projectId && conflict.snapshotId === snapshot.id && conflict.status === "open")
      .filter((conflict) => {
        const searchable = `${conflict.title}\n${conflict.description}\n${JSON.stringify(conflict.evidence)}`.toLocaleLowerCase();
        const termMatch = (topical.length ? topical : terms).some((term) => containsTerm(normalizeSearch(searchable), term));
        const evidence = conflict.evidence;
        const linkedArtifact = typeof evidence.artifactId === "string" && selectedArtifactIds.has(evidence.artifactId);
        const linkedPath = typeof evidence.path === "string" && selectedPaths.has(evidence.path);
        return termMatch || linkedArtifact || linkedPath;
      })
      .map((conflict) => ({
        id: conflict.id,
        type: conflict.type,
        severity: conflict.severity,
        title: safeText(conflict.title),
        description: safeText(conflict.description),
        evidence: redactRecord(conflict.evidence),
      }));
  }
}

/** A replaceable fallback generator. It receives only selected, redacted evidence. */
export class DeterministicProjectAnswerGenerator implements ProjectAnswerGenerator {
  async answer(input: { project: Project; question: string; intent: QuestionIntent; status: AskProjectStatus; evidence: EvidenceBundle }): Promise<string> {
    const { evidence, intent, status } = input;
    if (status === "insufficient_evidence") return "Observatory cannot verify this from the currently indexed evidence.";
    if (status === "conflicted") {
      const positions = evidence.conflicts.map((conflict) => `${conflict.title}: ${conflict.description}`).join(" ");
      return `Observatory found relevant conflicting current evidence and cannot verify a single answer. ${positions}`.trim();
    }

    const findings = evidence.selected.slice(0, 4).map((item) => describeEvidence(item));
    const prefix = status === "partial"
      ? "Observatory found relevant evidence, but cannot verify every part of this question."
      : "Observatory verified the following against the current indexed snapshot.";
    const changeNote = intent === "change_path" ? changePathNote(evidence.selected) : "";
    const testNote = intent === "tests" && !evidence.selected.some((item) => item.role === "test")
      ? " Observatory found related implementation evidence but no matching indexed test evidence."
      : "";
    return `${prefix} ${findings.join(" ")}${changeNote}${testNote}`.trim();
  }
}

export function classifyQuestionIntent(question: string): QuestionIntent {
  const normalized = question.toLocaleLowerCase();
  if (/\b(test|tests|spec|specs|coverage|covered)\b/.test(normalized)) return "tests";
  if (/\b(change|edit|update|modify|set|configure|configuration|safe(?:ly)?|where .* (?:change|edit))\b/.test(normalized)) return "change_path";
  if (/\b(introduced|origin|originate|history|historical|when|what changed|changed)\b/.test(normalized)) return "history";
  if (/\b(current value|current (?:setting|config)|value|configuration|configured|setting|settings|state)\b/.test(normalized)) return "state_config";
  if (/\b(how|work|works|behavio(?:u)?r|flow|calculate|establish(?:ed)?)\b/.test(normalized)) return "behavior";
  return "location";
}

function validateQuestion(question: string): string {
  if (typeof question !== "string" || !question.trim()) throw new Error("Question must be a non-empty string.");
  const trimmed = question.trim();
  if (trimmed.length > MAX_QUESTION_LENGTH) throw new Error(`Question must be at most ${MAX_QUESTION_LENGTH} characters.`);
  return trimmed;
}

function latestSnapshot(store: ObservatoryStore, projectId: string): Snapshot | undefined {
  return store.snapshots.filter((snapshot) => snapshot.projectId === projectId).at(-1);
}

function expandedTerms(question: string): string[] {
  return expandTermList(primaryTerms(question));
}

function primaryTerms(question: string): string[] { return tokenize(question).map(canonicalTerm).filter((term) => term.length > 1 && !STOP_WORDS.has(term)); }

function topicalTerms(question: string): string[] {
  const intentOnly = new Set(["behaviour", "behavior", "change", "chang", "config", "configuration", "configur", "configure", "coverage", "edit", "establish", "feature", "history", "how", "introduc", "modify", "origin", "safe", "safely", "setting", "state", "test", "update", "work", "works"]);
  const base = tokenize(question).map(canonicalTerm).filter((term) => term.length > 1 && !STOP_WORDS.has(term) && !intentOnly.has(term));
  return expandTermList(base);
}

function expandTermList(base: string[]): string[] {
  const terms = new Set(base);
  const synonyms: Array<[RegExp, string[]]> = [
    [/\b(fee|fees|platform|service|merchant|transaction|billing|pricing|revenue|waived)\b/i, ["fee", "service", "platform", "transaction", "merchant", "billing", "pricing", "revenue", "waive"]],
    [/\b(donation|donate|gift|preset|presets|amount|amounts)\b/i, ["donation", "donate", "gift", "preset", "amount"]],
    [/\b(rate|rates|exchange|currency|gbp|php|foreign)\b/i, ["rate", "exchange", "currency", "gbp", "php"]],
    [/\b(payout|payouts|settlement|complete|completion|transfer)\b/i, ["payout", "settlement", "complete", "transfer"]],
    [/\b(test|tests|spec|specs|coverage)\b/i, ["test", "spec", "coverage"]],
    [/\b(config|configure|configuration|setting|settings|environment)\b/i, ["config", "configuration", "setting", "policy"]],
  ];
  const joined = base.join(" ");
  for (const [pattern, aliases] of synonyms) if (pattern.test(joined)) for (const alias of aliases) terms.add(alias);
  return [...terms].sort();
}

function tokenize(value: string): string[] { return value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean); }
function canonicalTerm(value: string): string {
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s") && value.length > 3 && !value.endsWith("ss")) return value.slice(0, -1);
  if (value.endsWith("ed") && value.length > 5) return value.slice(0, -2);
  return value;
}

function scoreText(path: string, title: string, body: string, content: string, terms: string[], primary: string[]): { score: number; terms: string[]; primary: string[] } {
  // Score source and knowledge text at the most relevant line, rather than
  // accumulating broad words scattered through a long document.
  const fields: Array<[string, number]> = [[normalizeSearch(path), 7], [normalizeSearch(title), 5], [normalizeSearch(mostRelevantLine(body, terms, primary)), 3], [normalizeSearch(mostRelevantLine(content, terms, primary)), 2]];
  let score = 0;
  const matched: string[] = [];
  const primaryMatches: string[] = [];
  for (const term of terms) {
    let count = 0;
    // Repeated boilerplate in a large README must not outrank a concise,
    // current implementation simply because it repeats a query word.
    for (const [field, weight] of fields) count += Math.min(occurrences(field, term), 2) * weight;
    if (count > 0) {
      const exactTopical = primary.includes(term);
      score += Math.min(count, 24) * (exactTopical ? 5 : 1);
      matched.push(term);
      if (exactTopical) primaryMatches.push(term);
    }
  }
  for (const phrase of adjacentPhrases(primary)) {
    if (fields.some(([field]) => field.includes(phrase))) score += phrase.split(" ").length * 35;
  }
  // Require at least one query/concept term, and favour candidates that
  // corroborate more than one distinct term over a generic one-word match.
  if (matched.length > 1) score += (matched.length - 1) * 6;
  return { score, terms: matched, primary: primaryMatches };
}

function occurrences(text: string, term: string): number {
  const expression = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?=$|[^\\p{L}\\p{N}])`, "gu");
  return [...text.matchAll(expression)].length;
}
function containsTerm(text: string, term: string): boolean { return occurrences(text, term) > 0; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function normalizeSearch(value: string): string { return value.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[^\p{L}\p{N}]+/gu, " ").toLocaleLowerCase().split(/\s+/).filter(Boolean).map(canonicalTerm).join(" "); }
function adjacentPhrases(terms: string[]): string[] { return terms.flatMap((term, index) => index + 1 < terms.length ? [`${term} ${terms[index + 1]}`] : []); }

function evidenceRole(path: string | undefined, item: KnowledgeItem | undefined): EvidenceRole {
  const lower = (path ?? "").toLocaleLowerCase();
  if (item?.type === "deployment") return "deployment_evidence";
  if (item?.type === "test_evidence" || /(^|\/)(test|tests|__tests__)\//.test(lower) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) return "test";
  if (/(^|\/)(migrations?|history)\//.test(lower) || /(?:^|[_-])\d{3,}[_-].*\.(sql|ts|js)$/i.test(lower)) return "historical_configuration";
  if (/(^|\/)(admin|backoffice|dashboard)\//.test(lower) || /admin\.(tsx?|jsx?)$/.test(lower)) return "admin_ui";
  if (/(^|\/)(prisma\/)?schema\.(prisma|sql)$/i.test(lower) || /schema\.(sql|prisma)$/i.test(lower)) return "database_schema";
  if (/\.(json|ya?ml|toml|ini|properties)$/i.test(lower) || /(^|\/)(config|settings)(\/|\.|-|_)/.test(lower)) return "configuration";
  if (/\.(md|mdx|txt)$/i.test(lower) || ["document", "architecture", "decision", "invariant"].includes(item?.type ?? "")) return "documentation";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|cs)$/i.test(lower) || item?.type === "implementation") return "runtime_implementation";
  return "other";
}

function intentWeight(intent: QuestionIntent, role: EvidenceRole): number {
  const weights: Record<QuestionIntent, Partial<Record<EvidenceRole, number>>> = {
    location: { runtime_implementation: 55, configuration: 50, database_schema: 42, admin_ui: 42, test: 30, documentation: 18, migration: 12, historical_configuration: 10 },
    behavior: { runtime_implementation: 65, configuration: 44, database_schema: 35, test: 28, documentation: 22, admin_ui: 18, historical_configuration: 8 },
    change_path: { runtime_implementation: 64, configuration: 62, admin_ui: 60, database_schema: 48, test: 32, documentation: 18, migration: 4, historical_configuration: 2 },
    history: { historical_configuration: 72, migration: 70, documentation: 38, runtime_implementation: 20, configuration: 18, test: 10 },
    tests: { test: 100, runtime_implementation: 28, configuration: 12, documentation: 10, historical_configuration: 6 },
    state_config: { configuration: 70, admin_ui: 62, runtime_implementation: 58, database_schema: 48, documentation: 24, test: 8, historical_configuration: -12 },
  };
  return weights[intent][role] ?? 0;
}

function locateLine(content: string, terms: string[], primary: string[]): { startLine: number; endLine: number; excerpt: string; primaryMatchCount: number } | undefined {
  const lines = safeText(content).replace(/\r/g, "").split("\n");
  let best: { index: number; hits: number; primaryMatchCount: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const { hits, primaryMatchCount } = lineMatchStrength(line, terms, primary);
    if (!best || hits > best.hits) best = { index, hits, primaryMatchCount };
  }
  if (!best || best.hits === 0) return undefined;
  return { startLine: best.index + 1, endLine: best.index + 1, excerpt: compactExcerpt(lines[best.index] ?? ""), primaryMatchCount: best.primaryMatchCount };
}

function mostRelevantLine(value: string, terms: string[], primary: string[]): string {
  let best = "";
  let bestHits = 0;
  for (const line of safeText(value).replace(/\r/g, "").split("\n")) {
    const { hits } = lineMatchStrength(line, terms, primary);
    if (hits > bestHits) {
      best = line;
      bestHits = hits;
    }
  }
  return best;
}

function lineMatchStrength(line: string, terms: string[], primary: string[]): { hits: number; primaryMatchCount: number } {
  const normalized = normalizeSearch(line);
  const primaryMatchCount = primary.filter((term) => containsTerm(normalized, term)).length;
  const hits = terms.reduce((total, term) => total + (containsTerm(normalized, term) ? primary.includes(term) ? 5 : 1 : 0), 0) + adjacentPhrases(primary).filter((phrase) => normalized.includes(phrase)).length * 10;
  return { hits, primaryMatchCount };
}

function validRange(provenance: Provenance | undefined): { startLine: number; endLine: number; excerpt: string; primaryMatchCount: number } | undefined {
  if (!provenance?.startLine || !provenance.endLine || provenance.startLine < 1 || provenance.endLine < provenance.startLine) return undefined;
  return { startLine: provenance.startLine, endLine: provenance.endLine, excerpt: "", primaryMatchCount: 0 };
}

function selectEvidence(candidates: Candidate[], intent: QuestionIntent): AnswerEvidence[] {
  const sorted = [...candidates].sort((left, right) => right.score - left.score || evidenceKey(left).localeCompare(evidenceKey(right)));
  const selected: Candidate[] = [];
  const seen = new Set<string>();
  const take = (candidate: Candidate | undefined): void => {
    if (!candidate || selected.length >= MAX_EVIDENCE) return;
    const key = evidenceKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(candidate);
  };
  const preferredRoles: Partial<Record<QuestionIntent, EvidenceRole[]>> = {
    tests: ["test", "runtime_implementation"],
    history: ["historical_configuration", "migration", "documentation", "runtime_implementation"],
    change_path: ["configuration", "admin_ui", "runtime_implementation", "database_schema", "test", "historical_configuration"],
    state_config: ["configuration", "admin_ui", "runtime_implementation", "database_schema"],
  };
  for (const role of preferredRoles[intent] ?? []) take(sorted.find((candidate) => candidate.role === role));
  for (const candidate of sorted) take(candidate);
  return selected
    .sort((left, right) => right.score - left.score || evidenceKey(left).localeCompare(evidenceKey(right)))
    .map((candidate) => toAnswerEvidence(candidate));
}

function evidenceKey(candidate: Candidate): string { return candidate.artifact?.id ?? `${candidate.provenance?.id ?? ""}:${candidate.item?.id ?? ""}`; }
function toAnswerEvidence(candidate: Candidate): AnswerEvidence {
  const artifact = candidate.artifact;
  const provenance = candidate.provenance;
  const path = artifact?.path ?? provenance?.path;
  return {
    artifactId: artifact?.id ?? provenance?.sourceArtifactId,
    sourceId: artifact?.sourceId,
    path,
    repositoryRevision: artifact?.revision ?? provenance?.repositoryCommit,
    contentHash: artifact?.contentHash,
    startLine: candidate.line?.startLine,
    endLine: candidate.line?.endLine,
    role: candidate.role,
    reason: relevanceReason(candidate, path),
    excerpt: candidate.line?.excerpt || undefined,
    title: candidate.item?.title,
    current: candidate.current,
  };
}

function relevanceReason(candidate: Candidate, path?: string): string {
  const terms = candidate.matchedTerms.slice(0, 4).join(", ");
  const current = candidate.current ? "Current snapshot" : "Historical snapshot";
  const source = path ? `${current} evidence in ${path}` : `${current} evidence`;
  return terms ? `${source} matches: ${terms}.` : `${source} is relevant to this question.`;
}

function answerStatus(snapshot: Snapshot | undefined, selected: AnswerEvidence[], conflicts: AskProjectConflict[], intent: QuestionIntent): AskProjectStatus {
  if (!snapshot || selected.length === 0) return "insufficient_evidence";
  if (conflicts.some((conflict) => conflict.type === "evidence_mismatch" || conflict.type === "repository_deployment_divergence")) return "conflicted";
  if (Object.values(snapshot.sourceHealth).some((health) => health.state !== "healthy")) return "partial";
  if (intent === "tests" && !selected.some((item) => item.role === "test")) return "partial";
  if (intent === "change_path" && !selected.some((item) => ["runtime_implementation", "configuration", "admin_ui", "database_schema"].includes(item.role))) return "partial";
  return "verified_current";
}

function describeEvidence(item: AnswerEvidence): string {
  const location = item.path ? `${item.path}${item.startLine ? ` (lines ${item.startLine}${item.endLine && item.endLine !== item.startLine ? `–${item.endLine}` : ""})` : ""}` : "the indexed source";
  const historical = item.current ? "" : " Historical evidence:";
  const excerpt = item.excerpt ? ` It contains: “${item.excerpt}”.` : "";
  return `${historical} ${roleLabel(item.role)}: ${location}.${excerpt}`.trim();
}

function changePathNote(evidence: AnswerEvidence[]): string {
  const historical = evidence.filter((item) => !item.current || item.role === "historical_configuration" || item.role === "migration");
  const editable = evidence.filter((item) => ["runtime_implementation", "configuration", "admin_ui", "database_schema"].includes(item.role));
  const historicalNote = historical.length
    ? " Historical migration/configuration evidence is shown as origin only, not as a verified current edit point."
    : "";
  const editableNote = editable.length
    ? " The current implementation/configuration evidence above is the verified change-path starting point."
    : " Observatory cannot verify a current editable source or whether a forward migration is required."
  return `${historicalNote}${editableNote}`;
}

function roleLabel(role: EvidenceRole): string { return role.replaceAll("_", " "); }
function compactExcerpt(value: string): string { return value.trim().replace(/\s+/g, " ").slice(0, 280); }

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /(?:token|secret|password|authorization|database[_-]?url|private[_-]?key)/i.test(key) ? "[REDACTED]" : redactValue(entry)]));
}
function redactValue(value: unknown): unknown {
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return redactRecord(value as Record<string, unknown>);
  return value;
}
