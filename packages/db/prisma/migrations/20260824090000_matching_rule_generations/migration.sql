-- T16 matching-rule generations. This is forward-only: the init migration is immutable.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM matching_rules WHERE action::text = 'allow') THEN
    RAISE EXCEPTION 'cannot migrate matching rules containing action=allow';
  END IF;
  IF EXISTS (
    SELECT 1 FROM matching_rules GROUP BY object_type_id, position HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot migrate duplicate matching rule positions';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM record_match_keys k
    LEFT JOIN matching_rules r
      ON r.object_type_id = k.object_type_id AND r.position = k.rule_position
    WHERE r.id IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot migrate match keys without their positional matching rule';
  END IF;
END $$;

CREATE TYPE "MatchingRuleGenerationState" AS ENUM ('active', 'pending_backfill', 'collision_blocked');

CREATE TABLE "matching_rule_generations" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "object_type_id" UUID NOT NULL,
  "state" "MatchingRuleGenerationState" NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "backfill_job_id" UUID,
  "backfill_attempt" INTEGER NOT NULL DEFAULT 0,
  "bootstrap_job_id" UUID,
  "bootstrap_attempt" INTEGER NOT NULL DEFAULT 0,
  "processed_records" INTEGER NOT NULL DEFAULT 0,
  "total_records" INTEGER,
  "collision_groups" INTEGER NOT NULL DEFAULT 0,
  "collision_records" INTEGER NOT NULL DEFAULT 0,
  "keys_ready_at" TIMESTAMP(3),
  "request_id" TEXT,
  "provenance" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activated_at" TIMESTAMP(3),
  CONSTRAINT "matching_rule_generations_pkey" PRIMARY KEY ("id")
);

INSERT INTO matching_rule_generations (
  id, organization_id, team_id, object_type_id, state, fingerprint
)
SELECT gen_random_uuid(), r.organization_id, r.team_id, r.object_type_id,
  'active', 'legacy:' || r.object_type_id::text
FROM matching_rules r
GROUP BY r.organization_id, r.team_id, r.object_type_id;

ALTER TABLE matching_rules ADD COLUMN generation_id UUID;
UPDATE matching_rules r
SET generation_id = g.id
FROM matching_rule_generations g
WHERE g.object_type_id = r.object_type_id AND g.state = 'active';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM matching_rules WHERE generation_id IS NULL) THEN
    RAISE EXCEPTION 'matching rule generation backfill left nulls';
  END IF;
END $$;
ALTER TABLE matching_rules ALTER COLUMN generation_id SET NOT NULL;

ALTER TABLE record_match_keys ADD COLUMN matching_rule_id UUID;
UPDATE record_match_keys k
SET matching_rule_id = r.id
FROM matching_rules r
WHERE r.object_type_id = k.object_type_id AND r.position = k.rule_position;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM record_match_keys WHERE matching_rule_id IS NULL) THEN
    RAISE EXCEPTION 'record match key rule backfill left nulls';
  END IF;
END $$;
ALTER TABLE record_match_keys ALTER COLUMN matching_rule_id SET NOT NULL;

CREATE TABLE "record_match_lookup_keys" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "matching_rule_id" UUID NOT NULL,
  "normalized_hash" TEXT NOT NULL,
  "record_id" UUID NOT NULL,
  CONSTRAINT "record_match_lookup_keys_pkey" PRIMARY KEY ("id")
);

-- Temporary continuity only. The bootstrap recomputes all canonical rows before enablement.
INSERT INTO record_match_lookup_keys (
  id, organization_id, team_id, matching_rule_id, normalized_hash, record_id
)
SELECT gen_random_uuid(), organization_id, team_id, matching_rule_id, normalized_hash, record_id
FROM record_match_keys;

DROP INDEX "record_match_keys_object_type_id_rule_position_normalized_h_key";
ALTER TABLE record_match_keys DROP COLUMN object_type_id;
ALTER TABLE record_match_keys DROP COLUMN rule_position;

ALTER TYPE "MatchAction" RENAME TO "MatchAction_old";
CREATE TYPE "MatchAction" AS ENUM ('block', 'warn');
ALTER TABLE matching_rules
  ALTER COLUMN action TYPE "MatchAction" USING action::text::"MatchAction";
DROP TYPE "MatchAction_old";

ALTER TABLE matching_rules
  ADD CONSTRAINT "matching_rules_generation_id_fkey"
  FOREIGN KEY (generation_id) REFERENCES matching_rule_generations(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE matching_rule_generations
  ADD CONSTRAINT "matching_rule_generations_object_type_id_fkey"
  FOREIGN KEY (object_type_id) REFERENCES object_types(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE record_match_keys
  ADD CONSTRAINT "record_match_keys_matching_rule_id_fkey"
  FOREIGN KEY (matching_rule_id) REFERENCES matching_rules(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE record_match_lookup_keys
  ADD CONSTRAINT "record_match_lookup_keys_matching_rule_id_fkey"
  FOREIGN KEY (matching_rule_id) REFERENCES matching_rules(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE record_match_lookup_keys
  ADD CONSTRAINT "record_match_lookup_keys_record_id_fkey"
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "matching_rule_generations_one_active"
  ON matching_rule_generations (object_type_id) WHERE state = 'active';
CREATE UNIQUE INDEX "matching_rule_generations_one_replacement"
  ON matching_rule_generations (object_type_id) WHERE state IN ('pending_backfill', 'collision_blocked');
CREATE UNIQUE INDEX "matching_rule_generations_backfill_job_id_key"
  ON matching_rule_generations (backfill_job_id) WHERE backfill_job_id IS NOT NULL;
CREATE UNIQUE INDEX "matching_rule_generations_bootstrap_job_id_key"
  ON matching_rule_generations (bootstrap_job_id) WHERE bootstrap_job_id IS NOT NULL;
CREATE UNIQUE INDEX "matching_rules_generation_id_position_key"
  ON matching_rules (generation_id, position);
CREATE INDEX "matching_rules_organization_id_team_id_idx"
  ON matching_rules (organization_id, team_id);
CREATE INDEX "matching_rules_object_type_id_generation_id_position_idx"
  ON matching_rules (object_type_id, generation_id, position);
CREATE UNIQUE INDEX "record_match_keys_matching_rule_id_normalized_hash_key"
  ON record_match_keys (matching_rule_id, normalized_hash);
CREATE INDEX "record_match_keys_matching_rule_id_record_id_idx"
  ON record_match_keys (matching_rule_id, record_id);
CREATE INDEX "record_match_keys_organization_id_team_id_idx"
  ON record_match_keys (organization_id, team_id);
CREATE UNIQUE INDEX "record_match_lookup_keys_matching_rule_id_normalized_hash_record_id_key"
  ON record_match_lookup_keys (matching_rule_id, normalized_hash, record_id);
CREATE INDEX "record_match_lookup_keys_matching_rule_id_normalized_hash_idx"
  ON record_match_lookup_keys (matching_rule_id, normalized_hash);
CREATE INDEX "record_match_lookup_keys_record_id_idx" ON record_match_lookup_keys (record_id);
CREATE INDEX "record_match_lookup_keys_organization_id_team_id_idx"
  ON record_match_lookup_keys (organization_id, team_id);
CREATE INDEX "matching_rule_generations_organization_id_team_id_idx"
  ON matching_rule_generations (organization_id, team_id);
CREATE INDEX "matching_rule_generations_object_type_id_state_idx"
  ON matching_rule_generations (object_type_id, state);
