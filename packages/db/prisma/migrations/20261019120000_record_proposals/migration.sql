-- Record proposals (schema-engine §4d″): what a data subject's submission
-- would change but a person decides — an amendment to one field of the record
-- it paired with, or a match whose email and phone point at more than one
-- person. A new table; nothing existing changes.
CREATE TYPE "ProposalKind" AS ENUM ('amendment', 'match');

CREATE TABLE "record_proposals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "kind" "ProposalKind" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "object_type_id" UUID NOT NULL,
    "record_id" UUID,
    "attribute_slug" TEXT,
    "proposed" JSONB NOT NULL,
    "proposed_hash" TEXT NOT NULL,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "source_kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_name" TEXT NOT NULL,
    "requester_type" "ActorType" NOT NULL,
    "requester_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "resolver_uoa_user_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_record_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_proposals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "record_proposals_kind_shape" CHECK (
        ("kind" = 'amendment') = ("record_id" IS NOT NULL AND "attribute_slug" IS NOT NULL)
    ),
    CONSTRAINT "record_proposals_status" CHECK ("status" IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX "record_proposals_organization_id_team_id_status_created_at_idx"
    ON "record_proposals"("organization_id", "team_id", "status", "created_at");

CREATE INDEX "record_proposals_record_id_status_idx" ON "record_proposals"("record_id", "status");

ALTER TABLE "record_proposals" ADD CONSTRAINT "record_proposals_record_id_fkey"
    FOREIGN KEY ("record_id") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
