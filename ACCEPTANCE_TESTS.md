# Acceptance Tests — Project Observatory v0.1

## Project isolation

- [ ] Register HomeBound without modifying the HomeBound repository.
- [ ] Register a second dummy project using the same core code.
- [ ] No core condition branches on project name or HomeBound domain names.

## Read-only guarantees

- [ ] Repository credential uses read-only permissions.
- [ ] Deployment credential uses read-only permissions.
- [ ] No mutation endpoint exists for observed repositories/deployments.
- [ ] Secret-pattern files are excluded by default.

## Repository observation

- [ ] Detect current default-branch revision.
- [ ] List included artifacts.
- [ ] Exclude configured paths.
- [ ] Persist content hashes.
- [ ] Repeated scan of unchanged revision is idempotent.

## Knowledge

- [ ] Ingest Markdown/document records.
- [ ] Ingest deterministic test evidence.
- [ ] Search returns relevant records.
- [ ] Every result includes provenance.
- [ ] Superseded knowledge can be retained historically.
- [ ] Resolved knowledge is provenance-backed or explicitly marked as an operator assertion.
- [ ] Contradictory evidence is surfaced as a conflict rather than silently overwritten.

## Snapshots/movements

- [ ] Create first snapshot.
- [ ] Create second snapshot after source change.
- [ ] Identify added/removed/changed knowledge.
- [ ] Preserve the earlier snapshot unchanged.
- [ ] No false movements on unchanged refresh.

## Deployment

- [ ] Read latest production deployment.
- [ ] Capture deployment revision when provider exposes it.
- [ ] Flag repository/deployment revision divergence.

## Current state

- [ ] Show documented/implemented/tested/deployed/observed dimensions.
- [ ] Do not claim a dimension is true without evidence or explicit operator assertion.
- [ ] Surface source-health uncertainty.

## AI interface

- [ ] list_projects works.
- [ ] get_project_state(HomeBound) works.
- [ ] search_project(HomeBound, query) works.
- [ ] get_recent_changes(HomeBound) works.
- [ ] compare_snapshots works.
- [ ] returned knowledge includes provenance.
- [ ] no write tool is exposed.

## Operations

- [ ] Failed deployment adapter does not block repository refresh.
- [ ] Refresh records partial failures.
- [ ] Operator can see last successful refresh.
- [ ] Audit log captures project/source administration.
