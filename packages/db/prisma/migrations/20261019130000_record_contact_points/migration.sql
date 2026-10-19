-- Contact points (schema-engine §4d‴): the state of each email and phone a
-- record holds — provenance, confirmation, the last successful contact, and
-- the archive of values another value replaced. A new table; nothing
-- existing changes. A value with no row has unknown provenance.
CREATE TABLE "record_contact_points" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "attribute_id" UUID NOT NULL,
    "value" TEXT NOT NULL,
    "value_hash" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL,
    "added_at" TIMESTAMP(3),
    "added_by_type" "ActorType",
    "added_by_id" TEXT,
    "added_on_behalf_of" TEXT,
    "source_kind" TEXT,
    "source_id" TEXT,
    "source_name" TEXT,
    "reached_at" TIMESTAMP(3),
    "reached_by_type" "ActorType",
    "reached_by_id" TEXT,
    "reached_on_behalf_of" TEXT,
    "reached_note" TEXT,
    "archived_at" TIMESTAMP(3),
    "archived_by_type" "ActorType",
    "archived_by_id" TEXT,
    "archived_on_behalf_of" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "record_contact_points_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "record_contact_points_record_id_attribute_id_value_hash_key"
    ON "record_contact_points"("record_id", "attribute_id", "value_hash");

CREATE INDEX "record_contact_points_tenant_value_idx"
    ON "record_contact_points"("organization_id", "team_id", "attribute_id", "value_hash");

ALTER TABLE "record_contact_points" ADD CONSTRAINT "record_contact_points_record_id_fkey"
    FOREIGN KEY ("record_id") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "record_contact_points" ADD CONSTRAINT "record_contact_points_attribute_id_fkey"
    FOREIGN KEY ("attribute_id") REFERENCES "attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
