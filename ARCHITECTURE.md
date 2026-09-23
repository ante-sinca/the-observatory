# Architecture — Project Observatory v0.1

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
