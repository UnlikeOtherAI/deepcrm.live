-- CreateExtension (explicit, per schema-engine §2)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('human', 'agent', 'system');

-- CreateEnum
CREATE TYPE "ObjectTypeKind" AS ENUM ('system', 'standard', 'custom');

-- CreateEnum
CREATE TYPE "AttributeType" AS ENUM ('text', 'rich_text', 'number', 'currency', 'percent', 'boolean', 'date', 'datetime', 'select', 'status', 'rating', 'email', 'phone', 'url', 'domain', 'registry_id', 'location', 'personal_name', 'actor_reference', 'record_reference', 'timestamp_system', 'json');

-- CreateEnum
CREATE TYPE "Sensitivity" AS ENUM ('public', 'internal', 'confidential', 'restricted');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('team', 'users', 'private');

-- CreateEnum
CREATE TYPE "SuppressionKind" AS ENUM ('email', 'phone', 'domain', 'company_number', 'postal');

-- CreateEnum
CREATE TYPE "SuppressionChannel" AS ENUM ('all', 'email', 'phone_call', 'sms', 'post');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('objection', 'erasure', 'bounce', 'manual');

-- CreateEnum
CREATE TYPE "Cardinality" AS ENUM ('one_to_one', 'one_to_many', 'many_to_one', 'many_to_many');

-- CreateEnum
CREATE TYPE "OnDelete" AS ENUM ('unlink', 'cascade', 'restrict');

-- CreateEnum
CREATE TYPE "ChangeKind" AS ENUM ('create', 'set', 'unset', 'link', 'unlink', 'delete', 'restore', 'merge', 'unmerge', 'schema');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('exact', 'normalized', 'fuzzy');

-- CreateEnum
CREATE TYPE "MatchAction" AS ENUM ('block', 'warn', 'allow');

-- CreateEnum
CREATE TYPE "PolicyScope" AS ENUM ('team', 'object_type', 'record', 'list');

-- CreateEnum
CREATE TYPE "PolicyResourceType" AS ENUM ('schema', 'object_type', 'attribute', 'record', 'link', 'list', 'view', 'merge', 'export', 'webhook', 'approval', 'suppression');

-- CreateEnum
CREATE TYPE "PolicyAction" AS ENUM ('view', 'create', 'edit', 'delete', 'restore', 'erase', 'link', 'merge', 'export', 'define', 'admin');

-- CreateEnum
CREATE TYPE "PolicyEffect" AS ENUM ('allow', 'deny');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired', 'consumed');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('success', 'denied', 'failure');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "external_org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "external_team_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 0,
    "policy_version" INTEGER NOT NULL DEFAULT 0,
    "feed_seq" BIGINT NOT NULL DEFAULT 0,
    "rejected_origins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "require_origin" BOOLEAN NOT NULL DEFAULT false,
    "team_visibility_only_apps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "object_types" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "singular_name" TEXT NOT NULL,
    "plural_name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT,
    "kind" "ObjectTypeKind" NOT NULL,
    "template_slug" TEXT,
    "primary_attribute_id" UUID,
    "archived_at" TIMESTAMP(3),
    "created_by_type" "ActorType" NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "object_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attributes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "object_type_id" UUID,
    "list_id" UUID,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" "AttributeType" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "is_multi" BOOLEAN NOT NULL DEFAULT false,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "is_unique" BOOLEAN NOT NULL DEFAULT false,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_indexed" BOOLEAN NOT NULL DEFAULT false,
    "sensitivity" "Sensitivity" NOT NULL DEFAULT 'internal',
    "default_value" JSONB,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relation_types" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "from_object_type_id" UUID,
    "to_object_type_id" UUID,
    "forward_name" TEXT NOT NULL,
    "inverse_name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "cardinality" "Cardinality" NOT NULL,
    "on_delete" "OnDelete" NOT NULL DEFAULT 'unlink',
    "edge_attributes" JSONB NOT NULL DEFAULT '[]',
    "projection_attribute_slug" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relation_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matching_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "object_type_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "attribute_slugs" TEXT[],
    "method" "MatchMethod" NOT NULL,
    "threshold" DOUBLE PRECISION,
    "action" "MatchAction" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matching_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "object_type_id" UUID NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "display_name" TEXT NOT NULL DEFAULT '',
    "owner_type" "ActorType",
    "owner_id" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'team',
    "created_on_behalf_of" TEXT,
    "origin" TEXT,
    "erased_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "last_activity_at" TIMESTAMP(3),
    "merged_into_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_by_type" "ActorType" NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "relation_type_id" UUID NOT NULL,
    "from_record_id" UUID NOT NULL,
    "to_record_id" UUID NOT NULL,
    "label" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER,
    "active_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active_until" TIMESTAMP(3),
    "created_by_type" "ActorType" NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_unique_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "attribute_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "normalized_hash" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,

    CONSTRAINT "record_unique_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_match_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "object_type_id" UUID NOT NULL,
    "rule_position" INTEGER NOT NULL,
    "normalized_hash" TEXT NOT NULL,
    "record_id" UUID NOT NULL,

    CONSTRAINT "record_match_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_visibility_grants" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "uoa_user_id" TEXT NOT NULL,

    CONSTRAINT "record_visibility_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "kind" "SuppressionKind" NOT NULL,
    "channel" "SuppressionChannel" NOT NULL DEFAULT 'all',
    "key_hash" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "sub_reason" TEXT,
    "expires_at" TIMESTAMP(3),
    "note" TEXT,
    "source_record_id" UUID,
    "created_by_type" "ActorType" NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "on_behalf_of" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_changes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "record_id" UUID,
    "group_id" UUID,
    "kind" "ChangeKind" NOT NULL,
    "attribute_slug" TEXT,
    "relation_type_id" UUID,
    "link_id" UUID,
    "old_value" JSONB,
    "new_value" JSONB,
    "snapshot" JSONB,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "on_behalf_of" TEXT,
    "run_id" TEXT,
    "tool_call_id" TEXT,
    "request_id" TEXT NOT NULL,
    "reason" TEXT,
    "resulting_version" INTEGER NOT NULL,
    "seq" BIGINT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_search" (
    "record_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "object_type_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024),
    "embedding_model" TEXT,
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_search_pkey" PRIMARY KEY ("record_id")
);

-- CreateTable
CREATE TABLE "lists" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "object_type_id" UUID,
    "created_by_type" "ActorType" NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "list_entries" (
    "id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "list_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "views" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "object_type_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "filter" JSONB NOT NULL DEFAULT '{}',
    "sort" JSONB NOT NULL DEFAULT '[]',
    "attributes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_type" "ActorType" NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "scope" "PolicyScope" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "resource_type" "PolicyResourceType" NOT NULL,
    "action" "PolicyAction" NOT NULL,
    "effect" "PolicyEffect" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "conditions" JSONB,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_bindings" (
    "id" UUID NOT NULL,
    "policy_rule_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,

    CONSTRAINT "policy_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "arguments_hash" TEXT NOT NULL,
    "arguments_snapshot" JSONB NOT NULL,
    "requester_type" "ActorType" NOT NULL,
    "requester_id" TEXT NOT NULL,
    "on_behalf_of" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "continuation_token_hash" TEXT NOT NULL,
    "resolver_uoa_user_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "on_behalf_of" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "outcome" "AuditOutcome" NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "request_id" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "prev_hash" TEXT,
    "entry_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "team_id" UUID,
    "type" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "idempotency_key" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "visible_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "result" JSONB,
    "progress" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "subscribing_uoa_user_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secret_ciphertext" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_delivered_seq" BIGINT NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "principal_last_seen" (
    "team_id" UUID NOT NULL,
    "uoa_user_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "principal_last_seen_pkey" PRIMARY KEY ("team_id","uoa_user_id")
);

-- CreateTable
CREATE TABLE "idempotency_replays" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "principal_user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "arguments_hash" TEXT NOT NULL,
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_replays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_external_org_id_key" ON "organizations"("external_org_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_external_team_id_key" ON "teams"("external_team_id");

-- CreateIndex
CREATE INDEX "teams_organization_id_idx" ON "teams"("organization_id");

-- CreateIndex
CREATE INDEX "object_types_organization_id_team_id_kind_idx" ON "object_types"("organization_id", "team_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "object_types_organization_id_team_id_slug_key" ON "object_types"("organization_id", "team_id", "slug");

-- CreateIndex
CREATE INDEX "attributes_organization_id_team_id_idx" ON "attributes"("organization_id", "team_id");

-- CreateIndex
CREATE UNIQUE INDEX "attributes_object_type_id_slug_key" ON "attributes"("object_type_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "attributes_list_id_slug_key" ON "attributes"("list_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "relation_types_organization_id_team_id_slug_key" ON "relation_types"("organization_id", "team_id", "slug");

-- CreateIndex
CREATE INDEX "matching_rules_object_type_id_position_idx" ON "matching_rules"("object_type_id", "position");

-- CreateIndex
CREATE INDEX "records_organization_id_team_id_object_type_id_updated_at_idx" ON "records"("organization_id", "team_id", "object_type_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "records_organization_id_team_id_object_type_id_last_activit_idx" ON "records"("organization_id", "team_id", "object_type_id", "last_activity_at");

-- CreateIndex
CREATE INDEX "records_merged_into_id_idx" ON "records"("merged_into_id");

-- CreateIndex
CREATE INDEX "record_links_from_record_id_relation_type_id_idx" ON "record_links"("from_record_id", "relation_type_id");

-- CreateIndex
CREATE INDEX "record_links_to_record_id_relation_type_id_idx" ON "record_links"("to_record_id", "relation_type_id");

-- CreateIndex
CREATE INDEX "record_links_organization_id_team_id_relation_type_id_idx" ON "record_links"("organization_id", "team_id", "relation_type_id");

-- CreateIndex
CREATE INDEX "record_unique_keys_record_id_idx" ON "record_unique_keys"("record_id");

-- CreateIndex
CREATE INDEX "record_unique_keys_organization_id_team_id_idx" ON "record_unique_keys"("organization_id", "team_id");

-- CreateIndex
CREATE UNIQUE INDEX "record_unique_keys_attribute_id_normalized_hash_key" ON "record_unique_keys"("attribute_id", "normalized_hash");

-- CreateIndex
CREATE INDEX "record_match_keys_record_id_idx" ON "record_match_keys"("record_id");

-- CreateIndex
CREATE UNIQUE INDEX "record_match_keys_object_type_id_rule_position_normalized_h_key" ON "record_match_keys"("object_type_id", "rule_position", "normalized_hash");

-- CreateIndex
CREATE INDEX "record_visibility_grants_uoa_user_id_idx" ON "record_visibility_grants"("uoa_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "record_visibility_grants_record_id_uoa_user_id_key" ON "record_visibility_grants"("record_id", "uoa_user_id");

-- CreateIndex
CREATE INDEX "suppression_entries_organization_id_team_id_idx" ON "suppression_entries"("organization_id", "team_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_entries_team_id_kind_key_hash_channel_key" ON "suppression_entries"("team_id", "kind", "key_hash", "channel");

-- CreateIndex
CREATE INDEX "record_changes_record_id_occurred_at_idx" ON "record_changes"("record_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "record_changes_organization_id_team_id_seq_idx" ON "record_changes"("organization_id", "team_id", "seq");

-- CreateIndex
CREATE INDEX "record_changes_organization_id_team_id_attribute_slug_occur_idx" ON "record_changes"("organization_id", "team_id", "attribute_slug", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "record_changes_team_id_seq_key" ON "record_changes"("team_id", "seq");

-- CreateIndex
CREATE INDEX "record_search_organization_id_team_id_object_type_id_idx" ON "record_search"("organization_id", "team_id", "object_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "lists_organization_id_team_id_slug_key" ON "lists"("organization_id", "team_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "list_entries_list_id_record_id_key" ON "list_entries"("list_id", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "views_organization_id_team_id_slug_key" ON "views"("organization_id", "team_id", "slug");

-- CreateIndex
CREATE INDEX "policy_rules_organization_id_team_id_resource_type_action_s_idx" ON "policy_rules"("organization_id", "team_id", "resource_type", "action", "scope_id", "priority");

-- CreateIndex
CREATE INDEX "policy_bindings_actor_type_actor_id_idx" ON "policy_bindings"("actor_type", "actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_bindings_policy_rule_id_actor_type_actor_id_key" ON "policy_bindings"("policy_rule_id", "actor_type", "actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_continuation_token_hash_key" ON "approval_requests"("continuation_token_hash");

-- CreateIndex
CREATE INDEX "approval_requests_organization_id_team_id_status_idx" ON "approval_requests"("organization_id", "team_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_resource_type_resource_id_idx" ON "audit_logs"("organization_id", "resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_jobs_idempotency_key_key" ON "queue_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "queue_jobs_status_visible_at_idx" ON "queue_jobs"("status", "visible_at");

-- CreateIndex
CREATE INDEX "queue_jobs_organization_id_team_id_type_created_at_idx" ON "queue_jobs"("organization_id", "team_id", "type", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "webhooks_organization_id_team_id_url_key" ON "webhooks"("organization_id", "team_id", "url");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_replays_organization_id_team_id_principal_user__key" ON "idempotency_replays"("organization_id", "team_id", "principal_user_id", "tool", "key");

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attributes" ADD CONSTRAINT "attributes_object_type_id_fkey" FOREIGN KEY ("object_type_id") REFERENCES "object_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attributes" ADD CONSTRAINT "attributes_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relation_types" ADD CONSTRAINT "relation_types_from_object_type_id_fkey" FOREIGN KEY ("from_object_type_id") REFERENCES "object_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relation_types" ADD CONSTRAINT "relation_types_to_object_type_id_fkey" FOREIGN KEY ("to_object_type_id") REFERENCES "object_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matching_rules" ADD CONSTRAINT "matching_rules_object_type_id_fkey" FOREIGN KEY ("object_type_id") REFERENCES "object_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "records" ADD CONSTRAINT "records_object_type_id_fkey" FOREIGN KEY ("object_type_id") REFERENCES "object_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_links" ADD CONSTRAINT "record_links_relation_type_id_fkey" FOREIGN KEY ("relation_type_id") REFERENCES "relation_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_links" ADD CONSTRAINT "record_links_from_record_id_fkey" FOREIGN KEY ("from_record_id") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_links" ADD CONSTRAINT "record_links_to_record_id_fkey" FOREIGN KEY ("to_record_id") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_unique_keys" ADD CONSTRAINT "record_unique_keys_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_unique_keys" ADD CONSTRAINT "record_unique_keys_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_match_keys" ADD CONSTRAINT "record_match_keys_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_visibility_grants" ADD CONSTRAINT "record_visibility_grants_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_changes" ADD CONSTRAINT "record_changes_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_search" ADD CONSTRAINT "record_search_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_entries" ADD CONSTRAINT "list_entries_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_entries" ADD CONSTRAINT "list_entries_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_bindings" ADD CONSTRAINT "policy_bindings_policy_rule_id_fkey" FOREIGN KEY ("policy_rule_id") REFERENCES "policy_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Raw statements from docs/schema-engine.md §2 (Prisma cannot express them).
-- record_search_model index is intentionally omitted here; T48 owns it (R13).

CREATE INDEX records_data_gin ON records USING gin (data jsonb_path_ops);

CREATE INDEX records_display_name_trgm ON records USING gin (display_name gin_trgm_ops);

CREATE UNIQUE INDEX record_links_active_unique
  ON record_links (relation_type_id, from_record_id, to_record_id) WHERE active_until IS NULL;

CREATE UNIQUE INDEX record_links_active_position_unique
  ON record_links (organization_id, team_id, from_record_id, relation_type_id, position)
  WHERE active_until IS NULL AND position IS NOT NULL;

ALTER TABLE record_search ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;

CREATE INDEX record_search_tsv ON record_search USING gin (tsv);

CREATE INDEX record_search_embedding ON record_search USING hnsw (embedding vector_cosine_ops);

ALTER TABLE record_changes ADD CONSTRAINT record_changes_schema_kind
  CHECK ((kind = 'schema') = (record_id IS NULL));
