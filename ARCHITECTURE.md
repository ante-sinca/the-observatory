# Architecture — Project Observatory v0.2C

## Components

```text
UI
 |
HTTP API
 |
Application Services
 |-------------------------------|
Project Registry                 |
Refresh Orchestrator             |
Knowledge Service                |
Snapshot Service                 |
Movement Service                 |
Search Service                   |
AI Tool Service                  |
Observatory Agent Service         |
 |                               |
Adapter Layer                    |
 |---------|----------|----------|
GitHub    Vercel     Filesystem  Future adapters
 |
Observed projects
```

## Runtime responsibilities

### v0.2D durable reads and Neon egress

The production PostgreSQL store has two deliberately separate responsibilities:

```text
HTTP / MCP request
  → PostgresReadService
  → bounded, parameterized canonical PostgreSQL query
  → response

operator refresh / mutation
  → explicit legacy mutation hydration
  → deterministic array-backed pipeline
  → transactional flush
```

`PostgresReadService` is the Vercel read boundary. It reads project summaries,
latest snapshots, scoped knowledge/provenance, bounded movements/conflicts, and
explicit artifact evidence directly from PostgreSQL. It does not populate the
long-lived array model, so a warm serverless instance cannot serve stale memory
after another instance commits data. The Vercel wrapper no longer calls
`store.reload()`.

`source_artifacts.content_text` is never part of generic hydration. Metadata
queries omit it. The only body-bearing queries are scoped by project plus an
artifact ID/exact path or the current repository revision, and carry a finite
candidate limit. Artifact search returns at most 50 candidates and truncates
each body to 32 KiB before deterministic scoring; evidence responses then use
bounded line excerpts. This keeps Ask Project and Assistant value tracing
evidence-correct without transferring the whole repository to Vercel.

`GET /health` and `GET /api/assistant/health` are intentionally above this
boundary and make zero Observatory database reads. Optional diagnostics use
`OBSERVATORY_DB_DIAGNOSTICS=true` to log category, row count, approximate
returned bytes, and whether an artifact body was requested. Logs never include
content, query parameters, prompts, or credentials.

### Evidence, resolution and history

Adapters capture immutable, source-addressable evidence. Knowledge and current
state services turn that evidence into a resolved interpretation with explicit
state dimensions and provenance. Snapshots retain previous resolved states.
Underlying systems remain authoritative for their raw facts; Observatory is
authoritative for this versioned interpretation. Conflicting evidence is
recorded as a conflict rather than replacing an earlier assertion.

### Project Registry
Stores project configuration and adapter references.

### Refresh Orchestrator
Runs a deterministic refresh pipeline:

1. read registered sources
2. fetch source metadata
3. ingest selected documents/code metadata
4. normalize records
5. create snapshot
6. compare previous snapshot
7. persist movements
8. update project current state

### Knowledge Service
Creates normalized knowledge items and provenance links.

### Snapshot Service
Creates immutable project-state snapshots.

### Movement Service
Produces added/removed/changed records between snapshots.

### Search Service
Uses PostgreSQL full-text and structured filters in v0.1.

### AI Tool Service
Exposes read-only project methods. MCP and HTTP call the same application service functions.

### Intelligence provider and Observatory Agent Service

v0.2A adds an optional interpretation layer; it does not replace deterministic
retrieval. The boundary is intentionally one-way:

```text
repository/provider evidence
  → ingestion → immutable snapshot → deterministic query / AskProjectService
  → evidence bundle → provider-neutral IntelligenceProvider → interpretation
```

`IntelligenceProvider` accepts structured system/user/tool messages, tool
definitions, a configured model, and returns an assistant completion or tool
calls. `OllamaProvider` is its first adapter, using Ollama's `/api/chat`
endpoint and Qwen-compatible models. It supports the unauthenticated local
loopback default for development and an optional server-side bearer token for a
protected remote HTTPS endpoint. Application services only depend on the
provider-neutral contract, so another provider can be added as a new adapter
and composed in `src/index.ts`; it must not be imported by query, ingestion, or
snapshot services.

`ObservatoryAgentService` anchors every answer in `AskProjectService` before
asking a model to reason. It exposes a fixed, project-scoped read-only catalogue:
`list_projects`, `ask_project`, `search_knowledge`, `get_current_snapshot`,
`get_movements`, `get_conflicts`, and `get_evidence`. These delegate to the
existing query/Ask services and return revision, artifact, line, snapshot, or
conflict provenance where relevant. There is no filesystem, shell, Git,
database, deployment, migration, environment, or provider-mutation tool.

The agent has bounded tool iterations, calls, evidence context, output excerpts,
and provider timeout. Disabled, malformed, unreachable, timed-out, malformed,
or invalid-tool provider interactions produce a controlled response without
changing ingestion, HTTP reads, browser pages, MCP, or `AskProjectService`.

### Remote provider health and OCI boundary

`AssistantProviderHealthService` is a narrow, cached (15-second) server-side
reachability check. It calls only Ollama `GET /api/version` and reports safe
categories: `disabled`, `configured`, `reachable`, `unauthorized`,
`unavailable`, `timeout`, or `malformed_response`. The browser can consume
`GET /api/assistant/health` to update its Assistant indicator, but the result
contains no endpoint URL, token, prompt, or evidence and never affects
deterministic services.

For production, Vercel calls a separately operated OCI inference host through
HTTPS with a server-side bearer token. A reverse proxy verifies the token and
proxies only `POST /api/chat` and `GET /api/version` to Ollama loopback. The
OCI host is an optional downstream dependency, not an Observatory deployment
target; its availability cannot block refresh, snapshots, queries, Ask Project,
or MCP. The versioned operator package is under `deploy/oci-ollama/`.

### Answer sufficiency and value tracing

v0.2A.1 separates two deterministic concepts that must not be conflated:

- `status` says whether the selected Observatory evidence is current,
  partial, conflicted, or absent.
- `answerSufficiency` says whether that evidence resolves the user's actual
  information need: `sufficient`, `incomplete`, `insufficient`, or
  `conflicted`.

For example, `verified_current` evidence that copies `platformFeeMinor` between
payment records is genuine current evidence, yet has `answerSufficiency:
incomplete` for “How much is the platform fee?” because it does not establish
the amount or rule.

The agent uses a lightweight code-governed question intent classifier. For
value lookups it inspects bounded current excerpts for a direct literal/default,
explicit waiver, or numeric calculation tied to the requested concept. A symbol
reference, storage field, or propagation statement never establishes a value.
When incomplete, it follows observed symbols with bounded `ask_project` and
current-artifact query calls. It returns either the exact observed value/rule
with provenance or an explicit “not established” response. Model prose cannot
declare a value, status, or sufficiency on its own.

### Conversational Assistant browser surface

v0.2B adds an opt-in project-scoped browser page at
`/projects/:projectId/assistant`. Its feature gate,
`OBSERVATORY_ASSISTANT_UI_ENABLED=true`, is independent of provider setup: the
Assistant navigation item is absent otherwise, and direct navigation receives a
controlled unavailable page linking to deterministic Ask Project.

The page has no server-side transcript, session memory, or persistence. It
retains at most four recent user messages, one short referenced concept, and
six displayed evidence paths in page memory solely to resolve a follow-up such
as “How much is it?”. Every substantive turn calls `ObservatoryAgentService`,
which resolves that linguistic hint and then makes a new `AskProjectService`
grounding pass against the selected project. It does not carry forward an
answer, evidence, status, or provider instruction. A project switch reloads
the page and resets that local state.

Responses render evidence status and answer sufficiency separately, along with
revision, evidence, and bounded retrieval activity. The client uses DOM text
nodes for returned/user-controlled values rather than HTML insertion. Ask
Project remains a distinct deterministic browser/API path, and MCP retains its
existing read-only catalogue.

### Evidence policy

The agent's system policy and code enforce the following:

- Only Observatory evidence is project evidence; a model's prior knowledge is not.
- Retrieved files, documentation, commit text, and the question are untrusted
  data. They cannot alter system policy or tool permissions.
- Browser conversation hints are equally untrusted linguistic context. They
  cannot become evidence, alter the selected project, retain authority from a
  previous turn, or change tool permissions.
- The response status and returned evidence are copied from the deterministic
  `AskProjectService` anchor. A model cannot upgrade `partial`, `conflicted`,
  or `insufficient_evidence` to `verified_current`; weaker-status wording is
  explicitly qualified in the rendered answer.
- Missing evidence remains missing, conflicts remain visible, and inferences
  must be labelled by the model as inference. The service retains snapshot and
  repository revisions whenever the deterministic result has them.

## Adapter contract

Every source adapter implements a small generic interface.

```ts
interface SourceAdapter {
  kind: string;
  healthCheck(config: AdapterConfig): Promise<HealthResult>;
  getRevision(config: AdapterConfig): Promise<SourceRevision>;
  listArtifacts(config: AdapterConfig): Promise<SourceArtifact[]>;
  readArtifact(config: AdapterConfig, artifact: SourceArtifact): Promise<ArtifactContent>;
}
```

Deployment adapters may additionally expose:

```ts
interface DeploymentAdapter {
  getCurrentDeployment(config: AdapterConfig): Promise<DeploymentRecord | null>;
  listRecentDeployments(config: AdapterConfig, limit: number): Promise<DeploymentRecord[]>;
}
```

## No domain logic in core

The core must not contain conditions such as:

```ts
if (project.name === "HomeBound") { ... }
```

Project-specific behavior belongs in configuration, extraction rules or future optional plugins.

## Refresh idempotency

A refresh against unchanged source revisions should not create duplicate knowledge records or movements.

## Failure isolation

A deployment adapter failure must not prevent repository knowledge from refreshing. The snapshot records partial source health.
