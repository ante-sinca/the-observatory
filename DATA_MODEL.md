# Data Model — v0.1

## projects
- id
- slug
- name
- description
- status
- created_at
- updated_at

## project_sources
- id
- project_id
- type
- provider
- config_json_encrypted
- enabled
- last_health_status
- last_checked_at

## refresh_runs
- id
- project_id
- started_at
- completed_at
- status
- source_revision_json
- errors_json

## source_artifacts
- id
- project_id
- source_id
- external_id
- path
- artifact_type
- revision
- content_hash
- metadata_json
- first_seen_at
- last_seen_at

## knowledge_items
- id
- project_id
- type
- domain
- title
- body
- status
- documented_state
- implemented_state
- tested_state
- deployed_state
- observed_state
- fingerprint
- valid_from_snapshot_id
- valid_to_snapshot_id nullable
- created_at

## provenance
- id
- knowledge_item_id
- source_artifact_id nullable
- source_type
- source_ref
- repository_commit nullable
- path nullable
- start_line nullable
- end_line nullable
- metadata_json

## deployments
- id
- project_id
- source_id
- external_id
- environment
- revision
- status
- deployed_at
- metadata_json

## snapshots
- id
- project_id
- created_at
- repository_revision nullable
- deployment_revision nullable
- source_health_json
- summary_json

## snapshot_items
- snapshot_id
- knowledge_item_id

## movements
- id
- project_id
- from_snapshot_id nullable
- to_snapshot_id
- movement_type  // added | removed | changed | deployed | source_health
- entity_type
- entity_key
- before_json nullable
- after_json nullable
- created_at

## conflicts
- id
- project_id
- snapshot_id
- type
- severity
- title
- description
- evidence_json
- status

## audit_events
- id
- actor_id nullable
- project_id nullable
- action
- metadata_json
- created_at

## Constraints

- knowledge_items fingerprint unique per active project state where appropriate
- snapshots immutable
- movements immutable
- project source credentials never stored in plaintext
- each resolved knowledge item has provenance, or an explicit `operator` provenance type
- conflict records preserve contradictory evidence; they do not erase it
- a snapshot identifies the resolved project interpretation at a point in time
