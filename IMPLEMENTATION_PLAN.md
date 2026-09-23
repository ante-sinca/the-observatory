# Implementation Plan — v0.1

## Stage 0 — Bootstrap

Deliver:
- TypeScript project
- database connection
- migrations
- environment validation
- authentication shell for operator access
- health endpoint

Exit criteria:
- app boots locally and in chosen deployment environment
- database migrations run cleanly

## Stage 1 — Project Registry

Deliver:
- projects CRUD
- project_sources CRUD
- encrypted source configuration
- source health status
- Projects UI

Exit criteria:
- HomeBound can be registered without changing HomeBound

## Stage 2 — Repository Adapter

Deliver:
- generic SourceAdapter interface
- GitHub repository adapter or filesystem adapter for local development
- revision detection
- artifact listing
- include/exclude filtering
- safe text artifact reading
- content hashing

Exit criteria:
- Observatory can enumerate and read configured HomeBound files read-only

## Stage 3 — Knowledge Ingestion

Deliver:
- source_artifacts persistence
- Markdown parser
- deterministic knowledge extraction
- provenance records
- deduplication by fingerprint
- PostgreSQL full-text index

Exit criteria:
- README/docs/tests can be searched with source provenance

## Stage 4 — Snapshots and Movements

Deliver:
- immutable snapshots
- snapshot_items
- previous/current comparison
- movement creation
- movement timeline UI
- idempotent unchanged refresh

Exit criteria:
- two different repository revisions produce a readable movement set
- unchanged refresh produces no duplicate movement noise

## Stage 5 — Deployment Adapter

Deliver:
- DeploymentAdapter interface
- Vercel adapter first
- deployment revision/environment/status ingestion
- deployment timeline
- repository/deployment revision comparison

Exit criteria:
- Observatory can state whether latest repository head is known to be deployed

## Stage 6 — Current State

Deliver:
- documented/implemented/tested/deployed/observed fields
- rule-based state resolution
- conflict records
- Current State UI

Minimum conflict rules:
- documented fact with explicit implementation evidence mismatch
- repository head != latest production deployment revision
- source unavailable/stale

Exit criteria:
- state is explainable and every resolved assertion has provenance

## Stage 7 — AI Interface

Deliver:
- shared ProjectQueryService
- read-only HTTP endpoints
- MCP tool handlers backed by ProjectQueryService
- pagination/limits
- authorization

Exit criteria:
- external AI client can list projects, get HomeBound state, search HomeBound and retrieve recent changes

## Stage 8 — Hardening

Deliver:
- secret redaction
- audit logging
- rate limiting
- adapter timeouts
- partial refresh handling
- tests
- deployment documentation

Exit criteria:
- read-only security review passes
- no provider write scopes are required

## v0.1 release gate

Release only when all ACCEPTANCE_TESTS.md items pass.
