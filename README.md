# Project Observatory v0.1

## Implementation

This directory now contains a runnable TypeScript implementation alongside the
v0.1 contract documents. It is an external, evidence-backed, read-only
observer: it never writes to an observed repository, deployment provider,
database, or financial system.

The canonical model is documented in [SOURCE_OF_TRUTH.md](SOURCE_OF_TRUTH.md):

```text
read-only evidence → resolved knowledge with provenance → immutable snapshots
```

### Run locally

Requires Node 20+ and a 32-byte base64 `OBSERVATORY_CONFIG_KEY` for production.
Development uses a deliberately non-production fallback encryption key. The
operator token is required for administrative HTTP calls in production.

```powershell
npm install
npm run check
npm test
npm run build
$env:PORT = 3000
node dist/index.js
```

Open `http://localhost:3000` for the Projects dashboard. `GET /health` is the
health probe. Start the same state service as an MCP stdio process with:

```powershell
node dist/index.js --mcp
```

### Register HomeBound manually

1. Create a GitHub fine-grained token restricted to the HomeBound repository
   with **Contents: read-only** and **Metadata: read-only**. Do not grant any
   write, deployment, workflow, database, or financial scope.
2. Register the project (replace the placeholder token and repository):

```powershell
$body = @{
  slug = "homebound"; name = "HomeBound";
  description = "External read-only project intelligence" 
} | ConvertTo-Json
Invoke-RestMethod -Method Post -ContentType "application/json" -Body $body http://localhost:3000/api/projects
```

3. Add a repository source using the returned project ID. The token is accepted
   only as encrypted source configuration and is never returned by the API.

```powershell
$source = @{
  type = "repository"; provider = "github";
  config = @{
    repository = "OWNER/HOMEBOUND"; token = "READ_ONLY_TOKEN"; defaultBranch = "main"; readOnly = $true;
    include = @("README.md", "AGENTS.md", "docs/**", "package.json", "lib/**", "app/**", "tests/**");
    exclude = @(".env*", "secrets/**", "credentials/**", "node_modules/**", ".next/**", "build/**", "coverage/**")
  }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -ContentType "application/json" -Body $source http://localhost:3000/api/projects/PROJECT_ID/sources
```

4. Optionally add a Vercel deployment source with a read-only token and its
   Vercel project ID. Then trigger `POST /api/projects/PROJECT_ID/refresh`.
   The state, provenance-backed knowledge, movements, conflicts, and snapshots
   become available via `/api/projects/PROJECT_ID/*` and the read-only MCP tools.

`migrations/001_initial.sql` is the PostgreSQL production schema. The supplied
runtime uses a testable in-memory store; connect a transactional PostgreSQL
store before a durable production deployment. That limitation is intentional
and is not represented as a passed production release gate.

Project Observatory is an external, read-only project intelligence service. It connects to software projects without requiring Observatory-specific code inside those repositories, builds a normalized knowledge/state model, tracks changes, and exposes project state to humans and AI clients.

## v0.1 objective

Connect one project (HomeBound) as the proving adapter while keeping the core fully project-agnostic.

v0.1 must be able to:

1. Register a project and repository.
2. Read repository metadata, commits, branches, selected files, and documentation.
3. Ingest deployment metadata through an adapter.
4. Normalize project knowledge into typed records with provenance.
5. Build a current-state snapshot.
6. Record movements between snapshots.
7. Search project knowledge.
8. Expose the read-only state through HTTP and MCP-compatible tools.
9. Never modify project code, deployments, databases, or financial systems.

## Non-goals

- No automatic code changes.
- No merges or deployments.
- No database writes to observed projects.
- No financial execution.
- No autonomous production actions.
- No requirement for HomeBound to change its repository structure.
- No vector database in v0.1.

## Suggested stack

- TypeScript
- Next.js for UI and HTTP API
- PostgreSQL
- Prisma or equivalent ORM
- Background worker/cron for refresh jobs
- Adapter interfaces for GitHub, Vercel, filesystem and future providers
- MCP server layer backed by the same service methods as the HTTP API

See the remaining files in this package for the implementation contract.
