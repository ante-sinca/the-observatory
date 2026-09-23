# HTTP and AI Tool Contract — v0.1

All interfaces are read-only except project administration and manual refresh.

All state and knowledge responses represent Observatory's resolved
interpretation and include source provenance. Callers should use the returned
snapshot and resolution status to understand the point-in-time context.

## HTTP API

### Projects
GET /api/projects
POST /api/projects
GET /api/projects/:projectId
PATCH /api/projects/:projectId

### Sources
POST /api/projects/:projectId/sources
GET /api/projects/:projectId/sources
POST /api/projects/:projectId/sources/:sourceId/health

### Refresh
POST /api/projects/:projectId/refresh
GET /api/projects/:projectId/refresh-runs

### State
GET /api/projects/:projectId/state
GET /api/projects/:projectId/snapshots
GET /api/projects/:projectId/snapshots/:snapshotId
GET /api/projects/:projectId/movements
GET /api/projects/:projectId/conflicts

### Knowledge
GET /api/projects/:projectId/knowledge
GET /api/projects/:projectId/knowledge/:itemId
GET /api/projects/:projectId/search?q=...

### Deployments
GET /api/projects/:projectId/deployments

## AI/MCP tools

### list_projects
Returns project IDs, names and current summary.

### get_project_state
Input:
- project

Returns:
- current repository revision
- current deployment revision
- source health
- current-state summary
- unresolved conflicts
- latest movements

### search_project
Input:
- project
- query
- optional domain
- optional type
- optional limit

Returns ranked knowledge items with provenance.

### get_recent_changes
Input:
- project
- since or snapshot

Returns movements.

### get_deployments
Input:
- project
- optional environment
- optional limit

### get_decisions
Input:
- project
- optional domain

### get_known_risks
Input:
- project

### get_knowledge_item
Input:
- project
- item_id

Returns complete knowledge item and provenance.

### compare_snapshots
Input:
- project
- from_snapshot
- to_snapshot

### get_source_artifact
Input:
- project
- artifact_id

Returns safe indexed content only. Secret/private excluded artifacts must never be returned.

## Explicitly absent from v0.1

- edit_file
- commit
- merge
- deploy
- execute_sql
- send_payment
- mutate_production
