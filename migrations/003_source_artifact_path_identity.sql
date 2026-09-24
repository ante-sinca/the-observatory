-- Git blobs can be shared by multiple repository paths. Path is therefore
-- required to distinguish independent, provenance-bearing source artifacts.
ALTER TABLE source_artifacts
  DROP CONSTRAINT source_artifacts_source_external_revision_hash_key;

ALTER TABLE source_artifacts
  ADD CONSTRAINT source_artifacts_source_external_path_revision_hash_key
  UNIQUE (source_id, external_id, path, revision, content_hash);
