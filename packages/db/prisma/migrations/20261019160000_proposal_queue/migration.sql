-- Bounded proposal queues (schema-engine §4d″) in place of the 25-per-record and 1 000-per-team caps, past
-- which a submission was refused with LIMIT_EXCEEDED. A submission is never refused now: an identical
-- proposal collapses into the open one (a count, the latest source, the newest place in its queue), and past
-- a pending window — 5 per queue (an amendment's record and attribute, a match's email and phone) and 1 000 per
-- team — the oldest pending proposals become `superseded`: still listed and decidable, and deleted by retention
-- DEEPCRM_RETENTION_DAYS after being superseded.

-- Proposals get their own status type: `superseded` means nothing for approval_requests.
CREATE TYPE "ProposalStatus" AS ENUM ('pending', 'approved', 'rejected', 'superseded');

ALTER TABLE "record_proposals" DROP CONSTRAINT "record_proposals_status";
ALTER TABLE "record_proposals" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "record_proposals" ALTER COLUMN "status" TYPE "ProposalStatus" USING ("status"::text::"ProposalStatus");
ALTER TABLE "record_proposals" ALTER COLUMN "status" SET DEFAULT 'pending';

ALTER TABLE "record_proposals"
    ADD COLUMN "queue_key" TEXT,
    ADD COLUMN "submissions" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "last_submitted_at" TIMESTAMP(3),
    ADD COLUMN "submitted_seq" BIGSERIAL NOT NULL;

-- Existing rows: their queue (as proposal-store.ts computes it), their one submission, and submission order by
-- creation. A match created before this keeps its proposed_hash (which included its source and activity time),
-- so only later submissions collapse into each other.
UPDATE "record_proposals"
SET "queue_key" = CASE "kind"
        WHEN 'amendment' THEN 'amendment:' || "record_id"::text || ':' || "attribute_slug"
        ELSE 'match:' || encode(sha256(convert_to(
            coalesce("proposed"->>'email', '') || chr(10) || coalesce("proposed"->>'phone', ''), 'UTF8')), 'hex')
    END,
    "last_submitted_at" = "created_at";

UPDATE "record_proposals" AS p
SET "submitted_seq" = o."seq"
FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "seq" FROM "record_proposals") AS o
WHERE p."id" = o."id";

SELECT setval(pg_get_serial_sequence('"record_proposals"', 'submitted_seq'),
    coalesce((SELECT max("submitted_seq") FROM "record_proposals"), 0) + 1, false);

ALTER TABLE "record_proposals" ALTER COLUMN "queue_key" SET NOT NULL;
ALTER TABLE "record_proposals" ALTER COLUMN "last_submitted_at" SET NOT NULL;
ALTER TABLE "record_proposals" ALTER COLUMN "last_submitted_at" SET DEFAULT CURRENT_TIMESTAMP;

-- The windows hold from here on: the newest 5 pending per queue, then the newest 1 000 pending per team.
UPDATE "record_proposals" SET "status" = 'superseded', "resolved_at" = CURRENT_TIMESTAMP
WHERE "id" IN (
    SELECT "id" FROM (
        SELECT "id", row_number() OVER (
            PARTITION BY "organization_id", "team_id", "queue_key" ORDER BY "submitted_seq" DESC) AS "place"
        FROM "record_proposals" WHERE "status" = 'pending'
    ) AS ranked
    WHERE "place" > 5
);

UPDATE "record_proposals" SET "status" = 'superseded', "resolved_at" = CURRENT_TIMESTAMP
WHERE "id" IN (
    SELECT "id" FROM (
        SELECT "id", row_number() OVER (
            PARTITION BY "organization_id", "team_id" ORDER BY "submitted_seq" DESC) AS "place"
        FROM "record_proposals" WHERE "status" = 'pending'
    ) AS ranked
    WHERE "place" > 1000
);

-- One open (pending or superseded) row per identity, found by the store before it writes.
CREATE INDEX "record_proposals_open_identity_idx"
    ON "record_proposals"("organization_id", "team_id", "queue_key", "proposed_hash")
    WHERE "status" IN ('pending', 'superseded');

-- The per-queue and per-team windows, newest first.
CREATE INDEX "record_proposals_pending_queue_idx"
    ON "record_proposals"("organization_id", "team_id", "queue_key", "submitted_seq")
    WHERE "status" = 'pending';

CREATE INDEX "record_proposals_pending_seq_idx"
    ON "record_proposals"("organization_id", "team_id", "submitted_seq")
    WHERE "status" = 'pending';

-- Retention of superseded rows.
CREATE INDEX "record_proposals_superseded_idx"
    ON "record_proposals"("resolved_at")
    WHERE "status" = 'superseded';
