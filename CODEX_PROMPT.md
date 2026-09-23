# Codex Implementation Prompt — Project Observatory v0.1

Build Project Observatory v0.1 as a new standalone application. Do not modify HomeBound.

Read all specification files in this package before changing code.

## Product rule

Project Observatory is an external read-only project intelligence service. HomeBound is the first registered project, but the core must remain project-agnostic.

Observatory is the canonical, versioned source of truth for its resolved
interpretation of registered-project state. Git, deployment providers and
operational systems remain authoritative for raw evidence. Preserve that
evidence, resolve it with provenance, and surface contradictions as conflicts.

## Required architecture rules

1. No `if project === HomeBound` logic in core services.
2. Integrations must use adapter interfaces.
3. Observed project credentials must be read-only.
4. Every derived knowledge item must retain provenance.
5. Snapshots and movements are immutable.
6. An unchanged refresh must be idempotent.
7. Failure of one source must not discard successful data from another source.
8. Secrets and .env files are excluded from ingestion.
9. MCP/AI tools must call the same application/query services used by the HTTP API; do not duplicate business logic.
10. v0.1 exposes no project mutation, code write, merge, deploy, SQL execution or financial action capability.
11. Every AI response that makes a current-state assertion must identify the
    snapshot/resolution context when one exists.

## Implementation sequence

Follow IMPLEMENTATION_PLAN.md stages in order. Do not jump to semantic/vector AI extraction before deterministic ingestion, provenance, snapshots and source health work.

## Preferred v0.1 stack

Use TypeScript. Prefer Next.js + PostgreSQL and a conventional ORM if starting from an empty project, unless the existing standalone Observatory repository already has an established compatible stack.

## Tests required

Implement automated tests corresponding to ACCEPTANCE_TESTS.md. Include tests proving:

- a second dummy project works without HomeBound-specific code
- unchanged refresh is idempotent
- excluded secret paths cannot be ingested
- provenance is returned with knowledge results
- deployment-adapter failure does not abort repository ingestion
- no write-capability AI tools are registered

## HomeBound

Use HOMEBOUND_ADAPTER.md only as configuration for the first project. Do not move these rules into generic core code.

## Completion report

At the end, report:
- files added/changed
- migrations created
- adapters implemented
- API routes implemented
- AI/MCP tools implemented
- tests run and results
- known limitations
- exact manual setup steps for registering HomeBound

Do not claim v0.1 complete until the release gate in ACCEPTANCE_TESTS.md passes.
