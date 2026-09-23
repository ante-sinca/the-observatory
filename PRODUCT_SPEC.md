# Product Specification — Project Observatory v0.1

## 1. Purpose

Project Observatory is a reusable external application for observing, indexing and explaining software projects. It provides a durable project knowledge layer that is independent of individual repositories and can be queried by humans, ChatGPT, Codex or other agents.

Underlying systems remain authoritative for raw evidence: the repository for
code and commits, deployment providers for deployment state, and operational
systems for their own records. Observatory is the canonical, versioned source
of truth for the *resolved interpretation* of project state, architecture,
decisions, history and observed production state. It stores derived knowledge,
provenance, snapshots and observations.

Observatory resolves evidence in three explicit layers:

```text
evidence → resolved knowledge → immutable history
```

Contradictory evidence must be retained and surfaced as a conflict, never
silently overwritten. A resolved assertion must have provenance or be visibly
labelled as an operator assertion.

## 2. Core principles

### External by design
No Observatory implementation code is required inside an observed project.

### Read-only first
v0.1 may read repository and deployment state but cannot modify the observed project.

### Provenance required
Every derived fact must identify its source.

### Current truth is explicit
Observatory distinguishes documented, implemented, tested, deployed and observed state.

### Project-agnostic core
HomeBound is project #1, not a hard-coded domain.

### Historical state is retained
Changes are recorded as movements between snapshots rather than overwriting prior understanding.

## 3. Primary users

- Project owner/operator
- Software developer using Codex
- ChatGPT or another AI agent
- Technical reviewer/auditor

## 4. Primary v0.1 workflows

### Register a project
Operator supplies project name, repository provider, repository identifier, default branch and optional deployment adapter configuration.

### Refresh project
Observatory scans configured sources and creates a new snapshot.

### View current state
Operator sees repository head, latest known deployment, detected documentation, current knowledge items, conflicts and recent movements.

### Search project knowledge
Search by natural text across titles, content, paths, decisions, detected invariants and state records.

### Ask through AI interface
An AI client calls read-only tools such as get_project_state or search_project.

### Inspect provenance
Every fact can be traced to a file, commit, deployment or observation.

## 5. Current-truth dimensions

Each relevant knowledge item can carry zero or more state dimensions:

- documented
- implemented
- tested
- deployed
- observed

Example:

Fixed daily FX
- documented: true
- implemented: true
- tested: true
- deployed: false
- observed: false

v0.1 does not need perfect semantic inference. It must support storing and presenting these dimensions and deriving them from explicit rules where possible.

## 6. Knowledge item types

- document
- architecture
- decision
- invariant
- implementation
- test_evidence
- deployment
- integration
- risk
- issue
- planned_change
- superseded_behavior
- operational_observation

## 7. v0.1 screens

### Projects
Cards showing project name, repository head, latest deployment, last refresh, unresolved conflicts and recent movements.

### Project Overview
- repository head
- deployment head
- last snapshot
- knowledge counts by type
- recent changes
- conflicts

### Current State
Normalized facts grouped by domain and current-truth dimension.

### Knowledge
Searchable knowledge records with source/provenance.

### Movements
Chronological changes between snapshots.

### Sources
Registered repository/deployment integrations and health.

## 8. HomeBound proving configuration

HomeBound should be registered using configuration, not HomeBound-specific core code.

Suggested domains:
- treasury
- reconciliation
- pricing
- payout
- integrations
- deployment

Suggested repository include paths:
- README.md
- AGENTS.md
- docs/**
- lib/**
- app/**
- tests/**

Suggested excludes:
- node_modules/**
- .next/**
- coverage/**
- generated artifacts
- secrets

## 9. Security

- Provider tokens encrypted at rest.
- Least-privilege read-only credentials.
- Secrets never indexed as project knowledge.
- Environment values redacted by default.
- No write scopes requested in v0.1.
- Audit log for project registration, credential changes and refresh runs.

## 10. Success criteria

v0.1 is ready when an operator can register HomeBound, run a refresh, view repository/deployment state, search ingested knowledge, inspect provenance, compare two snapshots, and query the same information through the AI tool interface without any write access to HomeBound.
