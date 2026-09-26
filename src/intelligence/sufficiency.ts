import type { AskProjectEvidence, AskProjectStatus } from "../services/ask-project.js";

/** What the question needs, independently of whether selected evidence is current. */
export type AssistantQuestionIntent = "value_lookup" | "location_lookup" | "implementation_explanation" | "test_coverage" | "recent_change" | "safe_change_location" | "state_status" | "evidence_provenance";
export type AnswerSufficiency = "sufficient" | "incomplete" | "insufficient" | "conflicted";

export interface EvaluatedEvidence {
  evidence: AskProjectEvidence;
  /** Bounded, safe source text associated with this evidence; never model memory. */
  excerpt?: string;
}

export interface SufficiencyAssessment {
  intent: AssistantQuestionIntent;
  answerSufficiency: AnswerSufficiency;
  reason: "current_value_or_rule" | "value_referenced_without_rule" | "no_relevant_evidence" | "deterministic_conflict" | "deterministic_partial" | "current_evidence";
  valueEvidence?: EvaluatedEvidence;
  valueStatement?: string;
}

/** Lightweight deterministic planning, deliberately not a free-form model decision. */
export function classifyAssistantQuestion(question: string): AssistantQuestionIntent {
  const normalized = question.toLocaleLowerCase();
  if (/\b(how much|how many|what (?:is|are) (?:the )?(?:amount|value|rate|fee|timeout|threshold|limit|retry)|what rate|what percentage|what percent|which amount)\b/.test(normalized)) return "value_lookup";
  if (/\b(which tests?|test coverage|coverage)\b/.test(normalized)) return "test_coverage";
  if (/\b(what changed|recent changes?|recently|movement|movements)\b/.test(normalized)) return "recent_change";
  if (/\b(where would|where can|safe(?:ly)? (?:change|edit|update)|change safely)\b/.test(normalized)) return "safe_change_location";
  if (/\b(status|state|enabled|current (?:setting|config|value))\b/.test(normalized)) return "state_status";
  if (/\b(evidence|provenance|source|revision)\b/.test(normalized)) return "evidence_provenance";
  if (/\b(how (?:does|do)|behavio(?:u)?r|work(?:s)?)\b/.test(normalized)) return "implementation_explanation";
  return "location_lookup";
}

/**
 * A code-governed value check. A symbol being copied, stored, or passed along
 * does not establish its amount. A literal/default or a numeric calculation
 * tied to the requested concept does.
 */
export function evaluateAnswerSufficiency(question: string, status: AskProjectStatus, evidence: EvaluatedEvidence[]): SufficiencyAssessment {
  const intent = classifyAssistantQuestion(question);
  if (status === "conflicted") return { intent, answerSufficiency: "conflicted", reason: "deterministic_conflict" };
  if (evidence.length === 0 || status === "insufficient_evidence") return { intent, answerSufficiency: "insufficient", reason: "no_relevant_evidence" };
  if (intent !== "value_lookup") {
    return status === "partial"
      ? { intent, answerSufficiency: "incomplete", reason: "deterministic_partial" }
      : { intent, answerSufficiency: "sufficient", reason: "current_evidence" };
  }

  const concept = conceptTerms(question);
  for (const candidate of evidence) {
    const statement = establishedValueStatement(candidate.excerpt ?? "", concept);
    if (statement) return { intent, answerSufficiency: "sufficient", reason: "current_value_or_rule", valueEvidence: candidate, valueStatement: statement };
  }
  return { intent, answerSufficiency: "incomplete", reason: "value_referenced_without_rule" };
}

/** Symbols make bounded follow-up retrieval narrower without a second index. */
export function valueTracingQueries(question: string, evidence: EvaluatedEvidence[]): string[] {
  const concept = conceptTerms(question);
  const queries = new Set<string>();
  for (const candidate of evidence) {
    for (const symbol of symbols(candidate.excerpt ?? "")) {
      const normalized = splitIdentifier(symbol).join(" ").toLocaleLowerCase();
      if (concept.some((term) => normalized.includes(term)) || /(?:fee|rate|amount|timeout|threshold|limit|retry|price|cost)/i.test(symbol)) {
        queries.add(splitIdentifier(symbol).join(" "));
      }
    }
  }
  // The original concept is useful when no implementation symbol was exposed.
  if (queries.size === 0 && concept.length) queries.add(concept.join(" "));
  return [...queries].filter((query) => query.length >= 3).slice(0, 3);
}

function establishedValueStatement(excerpt: string, concept: string[]): string | undefined {
  const lines = excerpt.replace(/\r/g, "").split("\n");
  const contextual = lines.some((line) => conceptMatch(line, concept));
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !contextual && !conceptMatch(line, concept)) continue;
    // Direct constants/defaults/object fields, e.g. platformFeeMinor = 200,
    // PLATFORM_FEE_PERCENT: 2, or timeoutMs: 30_000.
    if (/(?:\b(?:const|let|var)\s+)?[A-Za-z_$][\w$]*(?:\s*:\s*[A-Za-z_$][\w$<>\[\]| ]*)?\s*(?:=|:)\s*(?:[-+]?\d[\d_]*(?:\.\d+)?\s*(?:%|ms|s|minutes?|hours?|p|pence|cents?)?|["'][^"']*\d[^"']*["'])\b/i.test(line)) return line.slice(0, 500);
    // A numeric calculation establishes a deterministic rule only when the
    // surrounding observed excerpt identifies the queried concept.
    if (/\breturn\b.*(?:\*|\/|Math\.(?:round|floor|ceil)|percentage|percent|rate).*\d/.test(line) && contextual) return line.slice(0, 500);
    if (/\b(?:waived|waive|free)\b/i.test(line) && /\b(?:true|false|0)\b/.test(line) && contextual) return line.slice(0, 500);
  }
  return undefined;
}

function conceptTerms(question: string): string[] {
  const ignored = new Set(["how", "much", "many", "what", "is", "are", "the", "a", "an", "configured", "current", "value", "amount"]);
  return question.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 1 && !ignored.has(term)).slice(0, 8);
}

function conceptMatch(value: string, terms: string[]): boolean {
  const normalized = splitIdentifier(value).join(" ").toLocaleLowerCase();
  return terms.some((term) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}(?=$|[^a-z0-9])`, "i").test(normalized));
}

function symbols(value: string): string[] {
  return [...new Set(value.match(/\b[A-Za-z_$][\w$]{2,}\b/g) ?? [])].slice(0, 20);
}

function splitIdentifier(value: string): string[] {
  return value.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function escapeRegExp(value: string): string { return value.replace(/[.*+^${}()|[\]\\]/g, "\\$&"); }
