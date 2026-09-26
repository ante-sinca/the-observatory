-- v0.2D targeted durable reads. These indexes support project-scoped latest
-- state and bounded evidence lookups without introducing vendor-specific APIs.
CREATE INDEX IF NOT EXISTS refresh_runs_project_started_idx
  ON refresh_runs(project_id, started_at DESC);

CREATE INDEX IF NOT EXISTS deployments_project_environment_deployed_idx
  ON deployments(project_id, environment, deployed_at DESC);

CREATE INDEX IF NOT EXISTS source_artifacts_project_revision_seen_idx
  ON source_artifacts(project_id, revision, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS source_artifacts_project_revision_path_idx
  ON source_artifacts(project_id, revision, path);

CREATE INDEX IF NOT EXISTS knowledge_items_project_status_created_idx
  ON knowledge_items(project_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS snapshot_items_knowledge_snapshot_idx
  ON snapshot_items(knowledge_item_id, snapshot_id);
