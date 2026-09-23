-- Project Observatory v0.1: PostgreSQL schema. All observed-project evidence is
-- read-only; this database stores Observatory's derived, versioned knowledge.
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_sources (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL CHECK (type IN ('repository', 'deployment')),
  provider TEXT NOT NULL,
  config_json_encrypted TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_health_status JSONB,
  last_checked_at TIMESTAMPTZ
);

CREATE TABLE refresh_runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  source_revision_json JSONB NOT NULL DEFAULT '{}',
  errors_json JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE source_artifacts (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  source_id UUID NOT NULL REFERENCES project_sources(id),
  external_id TEXT NOT NULL,
  path TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  revision TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  UNIQUE(source_id, external_id)
);

CREATE TABLE knowledge_items (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL,
  domain TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  documented_state TEXT NOT NULL DEFAULT 'unknown',
  implemented_state TEXT NOT NULL DEFAULT 'unknown',
  tested_state TEXT NOT NULL DEFAULT 'unknown',
  deployed_state TEXT NOT NULL DEFAULT 'unknown',
  observed_state TEXT NOT NULL DEFAULT 'unknown',
  fingerprint TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  valid_from_snapshot_id UUID,
  valid_to_snapshot_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, fingerprint)
);

CREATE TABLE provenance (
  id UUID PRIMARY KEY,
  knowledge_item_id UUID NOT NULL REFERENCES knowledge_items(id),
  source_artifact_id UUID REFERENCES source_artifacts(id),
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  repository_commit TEXT,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  metadata_json JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE deployments (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  source_id UUID NOT NULL REFERENCES project_sources(id),
  external_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  revision TEXT,
  status TEXT NOT NULL,
  deployed_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  UNIQUE(source_id, external_id)
);

CREATE TABLE snapshots (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  created_at TIMESTAMPTZ NOT NULL,
  repository_revision TEXT,
  deployment_revision TEXT,
  source_health_json JSONB NOT NULL,
  summary_json JSONB NOT NULL
);
CREATE TABLE snapshot_items (
  snapshot_id UUID NOT NULL REFERENCES snapshots(id),
  knowledge_item_id UUID NOT NULL REFERENCES knowledge_items(id),
  PRIMARY KEY(snapshot_id, knowledge_item_id)
);
CREATE TABLE movements (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  from_snapshot_id UUID,
  to_snapshot_id UUID NOT NULL REFERENCES snapshots(id),
  movement_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  before_json JSONB,
  after_json JSONB,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE conflicts (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  snapshot_id UUID NOT NULL REFERENCES snapshots(id),
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_json JSONB NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  actor_id TEXT,
  project_id UUID REFERENCES projects(id),
  action TEXT NOT NULL,
  metadata_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_items_search_idx ON knowledge_items
USING GIN (to_tsvector('simple', title || ' ' || body));
CREATE INDEX movements_project_created_idx ON movements(project_id, created_at DESC);
