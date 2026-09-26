# Architecture — Project Observatory v0.2A

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
calls. `OllamaProvider` is its first adapter, using Ollama's local `/api/chat`
endpoint and Qwen-compatible models. Application services only depend on the
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

### Evidence policy

The agent's system policy and code enforce the following:

- Only Observatory evidence is project evidence; a model's prior knowledge is not.
- Retrieved files, documentation, commit text, and the question are untrusted
  data. They cannot alter system policy or tool permissions.
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
