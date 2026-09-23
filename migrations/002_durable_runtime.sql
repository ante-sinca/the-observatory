-- Align the initial schema with the implemented durable domain. This migration
-- is forward-only: it preserves all existing Observatory state.
ALTER TABLE source_artifacts ADD COLUMN content_text TEXT;

ALTER TABLE source_artifacts DROP CONSTRAINT source_artifacts_source_id_external_id_key;
ALTER TABLE source_artifacts ADD CONSTRAINT source_artifacts_source_external_revision_hash_key
  UNIQUE (source_id, external_id, revision, content_hash);

CREATE INDEX source_artifacts_project_source_idx ON source_artifacts(project_id, source_id);
CREATE INDEX provenance_knowledge_item_idx ON provenance(knowledge_item_id);
CREATE INDEX snapshots_project_created_idx ON snapshots(project_id, created_at);
CREATE INDEX conflicts_project_status_idx ON conflicts(project_id, status);

-- Guard the foreign-key relationships that also carry a project_id. Separate
-- typed trigger functions keep the checks valid for every table row shape.
CREATE FUNCTION observatory_assert_artifact_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM project_sources s WHERE s.id = NEW.source_id AND s.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'source artifact project does not match source project';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION observatory_assert_deployment_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM project_sources s WHERE s.id = NEW.source_id AND s.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'deployment project does not match source project';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION observatory_assert_provenance_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_artifact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM knowledge_items k JOIN source_artifacts a ON a.id = NEW.source_artifact_id
    WHERE k.id = NEW.knowledge_item_id AND k.project_id = a.project_id
  ) THEN RAISE EXCEPTION 'provenance knowledge and artifact projects differ'; END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION observatory_assert_snapshot_item_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM snapshots s JOIN knowledge_items k ON k.id = NEW.knowledge_item_id WHERE s.id = NEW.snapshot_id AND s.project_id = k.project_id) THEN
    RAISE EXCEPTION 'snapshot and knowledge projects differ';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION observatory_assert_conflict_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.id = NEW.snapshot_id AND s.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'conflict project does not match snapshot project';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION observatory_assert_movement_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.id = NEW.to_snapshot_id AND s.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'movement project does not match target snapshot project';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_artifacts_project_isolation BEFORE INSERT OR UPDATE ON source_artifacts FOR EACH ROW EXECUTE FUNCTION observatory_assert_artifact_project();
CREATE TRIGGER deployments_project_isolation BEFORE INSERT OR UPDATE ON deployments FOR EACH ROW EXECUTE FUNCTION observatory_assert_deployment_project();
CREATE TRIGGER provenance_project_isolation BEFORE INSERT OR UPDATE ON provenance FOR EACH ROW EXECUTE FUNCTION observatory_assert_provenance_project();
CREATE TRIGGER snapshot_items_project_isolation BEFORE INSERT OR UPDATE ON snapshot_items FOR EACH ROW EXECUTE FUNCTION observatory_assert_snapshot_item_project();
CREATE TRIGGER conflicts_project_isolation BEFORE INSERT OR UPDATE ON conflicts FOR EACH ROW EXECUTE FUNCTION observatory_assert_conflict_project();
CREATE TRIGGER movements_project_isolation BEFORE INSERT OR UPDATE ON movements FOR EACH ROW EXECUTE FUNCTION observatory_assert_movement_project();
