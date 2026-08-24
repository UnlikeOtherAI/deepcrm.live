-- T57 semantic metadata foundation. Additive only: template semantics stay in
-- runtime metadata, not template-named tables.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM attributes
    WHERE type = 'status'::"AttributeType"
      AND (config ? 'pipeline_id' OR config ? 'pipeline_stage_id')
  ) THEN
    RAISE EXCEPTION 'cannot migrate legacy status attributes with undecidable pipeline mapping';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AttributeValueSource') THEN
    CREATE TYPE "AttributeValueSource" AS ENUM ('stored', 'formula', 'rollup', 'relation_sync', 'score', 'system');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PipelineStageCategory') THEN
    CREATE TYPE "PipelineStageCategory" AS ENUM ('open', 'won', 'lost', 'neutral');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DerivationRefreshState') THEN
    CREATE TYPE "DerivationRefreshState" AS ENUM ('ready', 'pending', 'refreshing', 'failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ListKind') THEN
    CREATE TYPE "ListKind" AS ENUM ('static', 'dynamic');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ListRefreshState') THEN
    CREATE TYPE "ListRefreshState" AS ENUM ('ready', 'refreshing', 'failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FileLinkTargetType') THEN
    CREATE TYPE "FileLinkTargetType" AS ENUM ('record', 'activity', 'event');
  END IF;
END $$;

ALTER TABLE attributes
  ADD COLUMN IF NOT EXISTS group_id uuid,
  ADD COLUMN IF NOT EXISTS value_source "AttributeValueSource" NOT NULL DEFAULT 'stored';

ALTER TABLE relation_types
  ADD COLUMN IF NOT EXISTS max_active_edges_from integer,
  ADD COLUMN IF NOT EXISTS max_active_edges_to integer,
  ADD COLUMN IF NOT EXISTS edge_limit_config jsonb NOT NULL DEFAULT '{}';

ALTER TABLE lists
  ADD COLUMN IF NOT EXISTS kind "ListKind" NOT NULL DEFAULT 'static',
  ADD COLUMN IF NOT EXISTS definition jsonb,
  ADD COLUMN IF NOT EXISTS evaluation_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refresh_state "ListRefreshState" NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS refresh_error_code text,
  ADD COLUMN IF NOT EXISTS last_evaluated_at timestamp(3);

CREATE TABLE IF NOT EXISTS attribute_groups (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  object_type_id uuid NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  archived_at timestamp(3),
  created_by_type "ActorType" NOT NULL,
  created_by_id text NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT attribute_groups_object_type_id_fkey
    FOREIGN KEY (object_type_id) REFERENCES object_types(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS pipelines (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  object_type_id uuid NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_default boolean NOT NULL DEFAULT false,
  archived_at timestamp(3),
  created_by_type "ActorType" NOT NULL,
  created_by_id text NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT pipelines_object_type_id_fkey
    FOREIGN KEY (object_type_id) REFERENCES object_types(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  position integer NOT NULL,
  probability double precision,
  category "PipelineStageCategory" NOT NULL DEFAULT 'open',
  archived_at timestamp(3),
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT pipeline_stages_pipeline_id_fkey
    FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS attribute_derivations (
  attribute_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  value_source "AttributeValueSource" NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  materialized boolean NOT NULL DEFAULT true,
  refresh_state "DerivationRefreshState" NOT NULL DEFAULT 'ready',
  refresh_error_code text,
  last_refreshed_at timestamp(3),
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT attribute_derivations_attribute_id_fkey
    FOREIGN KEY (attribute_id) REFERENCES attributes(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS attribute_derivation_dependencies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  attribute_id uuid NOT NULL,
  source_attribute_id uuid,
  relation_type_id uuid,
  source_kind text NOT NULL,
  source_path text[] DEFAULT ARRAY[]::text[],
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT attribute_derivation_dependencies_attribute_id_fkey
    FOREIGN KEY (attribute_id) REFERENCES attribute_derivations(attribute_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT attribute_derivation_dependencies_source_attribute_id_fkey
    FOREIGN KEY (source_attribute_id) REFERENCES attributes(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT attribute_derivation_dependencies_relation_type_id_fkey
    FOREIGN KEY (relation_type_id) REFERENCES relation_types(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS record_stage_history (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  record_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  started_at timestamp(3) NOT NULL,
  ended_at timestamp(3),
  change_id uuid,
  actor_type "ActorType" NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT record_stage_history_record_id_fkey
    FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT record_stage_history_pipeline_id_fkey
    FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT record_stage_history_stage_id_fkey
    FOREIGN KEY (stage_id) REFERENCES pipeline_stages(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS file_objects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  provider text NOT NULL,
  provider_key text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  checksum_sha256 text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by_type "ActorType" NOT NULL,
  created_by_id text NOT NULL,
  on_behalf_of text,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS file_links (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  file_id uuid NOT NULL,
  target_type "FileLinkTargetType" NOT NULL,
  record_id uuid,
  event_id uuid,
  purpose text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by_type "ActorType" NOT NULL,
  created_by_id text NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT file_links_file_id_fkey
    FOREIGN KEY (file_id) REFERENCES file_objects(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT file_links_record_id_fkey
    FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS event_types (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  subject_object_type_id uuid,
  property_schema jsonb NOT NULL DEFAULT '{}',
  archived_at timestamp(3),
  created_by_type "ActorType" NOT NULL,
  created_by_id text NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT event_types_subject_object_type_id_fkey
    FOREIGN KEY (subject_object_type_id) REFERENCES object_types(id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  event_type_id uuid NOT NULL,
  source text NOT NULL,
  external_id text NOT NULL,
  occurred_at timestamp(3) NOT NULL,
  subject_record_id uuid,
  actor_type "ActorType",
  actor_id text,
  properties jsonb NOT NULL DEFAULT '{}',
  correction_of_event_id uuid,
  created_by_type "ActorType" NOT NULL,
  created_by_id text NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT events_event_type_id_fkey
    FOREIGN KEY (event_type_id) REFERENCES event_types(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT events_subject_record_id_fkey
    FOREIGN KEY (subject_record_id) REFERENCES records(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT events_correction_of_event_id_fkey
    FOREIGN KEY (correction_of_event_id) REFERENCES events(id) ON DELETE SET NULL ON UPDATE CASCADE
);

DO $$ BEGIN
  ALTER TABLE file_links
    ADD CONSTRAINT file_links_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS migration_reports (
  id uuid PRIMARY KEY,
  organization_id uuid,
  team_id uuid,
  migration_name text NOT NULL,
  code text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS attribute_groups_organization_id_team_id_idx
  ON attribute_groups(organization_id, team_id);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_groups_organization_id_team_id_object_type_id_slu_key
  ON attribute_groups(organization_id, team_id, object_type_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_groups_object_type_id_position_key
  ON attribute_groups(object_type_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS attributes_group_id_position_key
  ON attributes(group_id, position);

CREATE INDEX IF NOT EXISTS pipelines_organization_id_team_id_object_type_id_idx
  ON pipelines(organization_id, team_id, object_type_id);
CREATE UNIQUE INDEX IF NOT EXISTS pipelines_organization_id_team_id_slug_key
  ON pipelines(organization_id, team_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS pipelines_object_type_id_slug_key
  ON pipelines(object_type_id, slug);
CREATE INDEX IF NOT EXISTS pipeline_stages_organization_id_team_id_idx
  ON pipeline_stages(organization_id, team_id);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_pipeline_id_slug_key
  ON pipeline_stages(pipeline_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_pipeline_id_position_key
  ON pipeline_stages(pipeline_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS pipelines_one_default
  ON pipelines(object_type_id) WHERE is_default AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS attribute_derivations_organization_id_team_id_value_source_idx
  ON attribute_derivations(organization_id, team_id, value_source);
CREATE INDEX IF NOT EXISTS attribute_derivations_organization_id_team_id_refresh_state_idx
  ON attribute_derivations(organization_id, team_id, refresh_state);
CREATE INDEX IF NOT EXISTS attribute_derivation_dependencies_organization_id_team_id_idx
  ON attribute_derivation_dependencies(organization_id, team_id);
CREATE INDEX IF NOT EXISTS attribute_derivation_dependencies_source_attribute_id_idx
  ON attribute_derivation_dependencies(source_attribute_id);
CREATE INDEX IF NOT EXISTS attribute_derivation_dependencies_relation_type_id_idx
  ON attribute_derivation_dependencies(relation_type_id);

CREATE INDEX IF NOT EXISTS record_stage_history_organization_id_team_id_pipeline_id_st_idx
  ON record_stage_history(organization_id, team_id, pipeline_id, stage_id, started_at);
CREATE INDEX IF NOT EXISTS record_stage_history_record_id_pipeline_id_started_at_idx
  ON record_stage_history(record_id, pipeline_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS record_stage_history_one_open
  ON record_stage_history(record_id, pipeline_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS lists_organization_id_team_id_kind_refresh_state_idx
  ON lists(organization_id, team_id, kind, refresh_state);

CREATE INDEX IF NOT EXISTS file_objects_organization_id_team_id_created_at_idx
  ON file_objects(organization_id, team_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS file_objects_organization_id_team_id_provider_provider_key_key
  ON file_objects(organization_id, team_id, provider, provider_key);
CREATE INDEX IF NOT EXISTS file_links_organization_id_team_id_target_type_idx
  ON file_links(organization_id, team_id, target_type);
CREATE INDEX IF NOT EXISTS file_links_record_id_idx ON file_links(record_id);
CREATE INDEX IF NOT EXISTS file_links_event_id_idx ON file_links(event_id);

CREATE INDEX IF NOT EXISTS event_types_organization_id_team_id_idx
  ON event_types(organization_id, team_id);
CREATE UNIQUE INDEX IF NOT EXISTS event_types_organization_id_team_id_slug_key
  ON event_types(organization_id, team_id, slug);
CREATE INDEX IF NOT EXISTS events_organization_id_team_id_occurred_at_idx
  ON events(organization_id, team_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_subject_record_id_occurred_at_idx
  ON events(subject_record_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS events_organization_id_team_id_event_type_id_source_externa_key
  ON events(organization_id, team_id, event_type_id, source, external_id);

CREATE INDEX IF NOT EXISTS migration_reports_migration_name_code_idx
  ON migration_reports(migration_name, code);
CREATE INDEX IF NOT EXISTS migration_reports_organization_id_team_id_idx
  ON migration_reports(organization_id, team_id);

DO $$ BEGIN
  ALTER TABLE attributes
    ADD CONSTRAINT attributes_group_same_parent
    CHECK (group_id IS NULL OR object_type_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE relation_types
    ADD CONSTRAINT relation_types_edge_limits_positive
    CHECK (
      (max_active_edges_from IS NULL OR max_active_edges_from > 0)
      AND (max_active_edges_to IS NULL OR max_active_edges_to > 0)
      AND jsonb_typeof(edge_limit_config) = 'object'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE lists
    ADD CONSTRAINT lists_dynamic_definition_shape
    CHECK (
      (kind = 'static'::"ListKind" AND definition IS NULL)
      OR (kind = 'dynamic'::"ListKind" AND object_type_id IS NOT NULL AND jsonb_typeof(definition) = 'object')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE pipeline_stages
    ADD CONSTRAINT pipeline_stages_probability_bounds
    CHECK (probability IS NULL OR (probability >= 0 AND probability <= 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE attribute_derivations
    ADD CONSTRAINT attribute_derivations_non_stored
    CHECK (value_source <> 'stored'::"AttributeValueSource");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE file_links
    ADD CONSTRAINT file_links_target_shape
    CHECK (
      (target_type IN ('record'::"FileLinkTargetType", 'activity'::"FileLinkTargetType")
        AND record_id IS NOT NULL AND event_id IS NULL)
      OR (target_type = 'event'::"FileLinkTargetType" AND event_id IS NOT NULL AND record_id IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE file_objects
    ADD CONSTRAINT file_objects_size_nonnegative CHECK (size_bytes >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE event_types
    ADD CONSTRAINT event_types_property_schema_object CHECK (jsonb_typeof(property_schema) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE events
    ADD CONSTRAINT events_properties_object CHECK (jsonb_typeof(properties) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION prevent_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events are immutable; write a correction event instead';
END;
$$;

DROP TRIGGER IF EXISTS events_immutable ON events;
CREATE TRIGGER events_immutable
BEFORE UPDATE OR DELETE ON events
FOR EACH ROW EXECUTE FUNCTION prevent_event_mutation();

DO $$ BEGIN
  ALTER TABLE attributes
    ADD CONSTRAINT attributes_group_id_fkey
    FOREIGN KEY (group_id) REFERENCES attribute_groups(id) ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
