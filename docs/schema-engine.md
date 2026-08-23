# Schema engine

The runtime-composable data model: object types, attributes, relation types and records defined as rows, with history, uniqueness, search, pipelines, merge and permissions implemented once over the metadata. Design rationale in [brief.md](brief.md) §5. This document is the normative spec; the Prisma schema in §2 is copied verbatim into `packages/db/prisma/schema.prisma`.

## 1. Principles

1. **Metadata is data.** Adding an object type or attribute is an insert; nothing runs DDL.
2. **One write path.** Every mutation goes through `applyWrite` in one transaction: policy → validate → lock → version check → unique keys → data → links → changes → audit → enqueue.
3. **Current state in JSONB, history in a change log, relationships in an edge table, uniqueness in a key table, search in a materialised doc.**
4. **Everything tenant-scoped** by `(organization_id, team_id)`.
5. **Deterministic only.** The engine normalises and matches on structural facts; it never judges content.

## 2. Prisma schema (`packages/db/prisma/schema.prisma`)

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector, pg_trgm]
}

// ───────────────────────── tenancy (UOA 1:1 mirrors) ─────────────────────────

model Organization {
  id            String   @id @default(uuid()) @db.Uuid
  externalOrgId String   @unique @map("external_org_id")
  name          String
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")
  teams         Team[]

  @@map("organizations")
}

model Team {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  externalTeamId String       @unique @map("external_team_id")
  name           String
  schemaVersion  Int          @default(0) @map("schema_version")
  policyVersion  Int          @default(0) @map("policy_version")
  // Commit-ordered change-feed sequence. Allocated via
  // `UPDATE teams SET feed_seq = feed_seq + 1 ... RETURNING` as the LAST
  // statement before commit in applyWrite, so the row lock makes seq order
  // equal commit order per tenant. Never a Postgres sequence: sequences
  // allocate at insert time and a slow transaction would commit a seq the
  // feed cursor has already passed (review C1).
  feedSeq        BigInt       @default(0) @map("feed_seq")
  createdAt      DateTime     @default(now()) @map("created_at")
  updatedAt      DateTime     @updatedAt @map("updated_at")
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId])
  @@map("teams")
}

// ───────────────────────── enums ─────────────────────────

enum ActorType {
  human
  agent
  system
}

enum ObjectTypeKind {
  system
  standard
  custom
}

enum AttributeType {
  text
  rich_text
  number
  currency
  percent
  boolean
  date
  datetime
  select
  status
  rating
  email
  phone
  url
  domain
  location
  personal_name
  actor_reference
  record_reference
  timestamp_system
  json
}

enum Sensitivity {
  public
  internal
  confidential
  restricted
}

enum Cardinality {
  one_to_one
  one_to_many
  many_to_one
  many_to_many
}

enum OnDelete {
  unlink
  cascade
  restrict
}

enum ChangeKind {
  create
  set
  unset
  link
  unlink
  delete
  restore
  merge
  unmerge
  schema_change @map("schema")
}

enum MatchMethod {
  exact
  normalized
  fuzzy
}

enum MatchAction {
  block
  warn
  allow
}

enum PolicyScope {
  organization
  team
  object_type
  record
  list
}

enum PolicyResourceType {
  schema
  object_type
  attribute
  record
  link
  list
  view
  merge
  export
  webhook
  approval
}

enum PolicyAction {
  view
  create
  edit
  delete
  link
  merge
  export
  define
  admin
}

enum PolicyEffect {
  allow
  deny
}

enum ApprovalStatus {
  pending
  approved
  rejected
  expired
  consumed
}

enum AuditOutcome {
  success
  denied
  failure
}

enum JobStatus {
  queued
  running
  completed
  failed
  cancelled
}

// ───────────────────────── metadata ─────────────────────────

model ObjectType {
  id                 String         @id @default(uuid()) @db.Uuid
  organizationId     String         @map("organization_id") @db.Uuid
  teamId             String         @map("team_id") @db.Uuid
  slug               String
  singularName       String         @map("singular_name")
  pluralName         String         @map("plural_name")
  description        String
  icon               String?
  kind               ObjectTypeKind
  templateSlug       String?        @map("template_slug")
  primaryAttributeId String?        @map("primary_attribute_id") @db.Uuid
  archivedAt         DateTime?      @map("archived_at")
  createdByType      ActorType      @map("created_by_type")
  createdById        String         @map("created_by_id")
  createdAt          DateTime       @default(now()) @map("created_at")
  updatedAt          DateTime       @updatedAt @map("updated_at")
  attributes         Attribute[]
  records            Record[]
  relationsFrom      RelationType[] @relation("RelationFrom")
  relationsTo        RelationType[] @relation("RelationTo")
  matchingRules      MatchingRule[]

  @@unique([organizationId, teamId, slug])
  @@index([organizationId, teamId, kind])
  @@map("object_types")
}

model Attribute {
  id             String        @id @default(uuid()) @db.Uuid
  organizationId String        @map("organization_id") @db.Uuid
  teamId         String        @map("team_id") @db.Uuid
  objectTypeId   String?       @map("object_type_id") @db.Uuid
  listId         String?       @map("list_id") @db.Uuid
  slug           String
  name           String
  description    String
  type           AttributeType
  config         Json          @default("{}")
  isMulti        Boolean       @default(false) @map("is_multi")
  isRequired     Boolean       @default(false) @map("is_required")
  isUnique       Boolean       @default(false) @map("is_unique")
  isSystem       Boolean       @default(false) @map("is_system")
  isIndexed      Boolean       @default(false) @map("is_indexed")
  sensitivity    Sensitivity   @default(internal)
  defaultValue   Json?         @map("default_value")
  position       Int           @default(0)
  archivedAt     DateTime?     @map("archived_at")
  createdAt      DateTime      @default(now()) @map("created_at")
  updatedAt      DateTime      @updatedAt @map("updated_at")
  objectType     ObjectType?   @relation(fields: [objectTypeId], references: [id], onDelete: Cascade)
  list           List?         @relation(fields: [listId], references: [id], onDelete: Cascade)
  uniqueKeys     RecordUniqueKey[]

  @@unique([objectTypeId, slug])
  @@unique([listId, slug])
  @@index([organizationId, teamId])
  @@map("attributes")
}

model RelationType {
  id                     String      @id @default(uuid()) @db.Uuid
  organizationId         String      @map("organization_id") @db.Uuid
  teamId                 String      @map("team_id") @db.Uuid
  slug                   String
  fromObjectTypeId       String?     @map("from_object_type_id") @db.Uuid   // null = any
  toObjectTypeId         String?     @map("to_object_type_id") @db.Uuid     // null = any
  forwardName            String      @map("forward_name")
  inverseName            String      @map("inverse_name")
  description            String      @default("")
  cardinality            Cardinality
  onDelete               OnDelete    @default(unlink) @map("on_delete")
  edgeAttributes         Json        @default("[]") @map("edge_attributes")  // AttributeSpec[] for link.data
  projectionAttributeSlug String?    @map("projection_attribute_slug")      // set when backing a record_reference attribute
  isSystem               Boolean     @default(false) @map("is_system")
  archivedAt             DateTime?   @map("archived_at")
  createdAt              DateTime    @default(now()) @map("created_at")
  updatedAt              DateTime    @updatedAt @map("updated_at")
  fromObjectType         ObjectType? @relation("RelationFrom", fields: [fromObjectTypeId], references: [id], onDelete: Cascade)
  toObjectType           ObjectType? @relation("RelationTo", fields: [toObjectTypeId], references: [id], onDelete: Cascade)
  links                  RecordLink[]

  @@unique([organizationId, teamId, slug])
  @@map("relation_types")
}

model MatchingRule {
  id             String      @id @default(uuid()) @db.Uuid
  organizationId String      @map("organization_id") @db.Uuid
  teamId         String      @map("team_id") @db.Uuid
  objectTypeId   String      @map("object_type_id") @db.Uuid
  position       Int
  attributeSlugs String[]    @map("attribute_slugs")
  method         MatchMethod
  threshold      Float?
  action         MatchAction
  createdAt      DateTime    @default(now()) @map("created_at")
  objectType     ObjectType  @relation(fields: [objectTypeId], references: [id], onDelete: Cascade)

  @@index([objectTypeId, position])
  @@map("matching_rules")
}

// ───────────────────────── data ─────────────────────────

model Record {
  id             String     @id @default(uuid()) @db.Uuid
  organizationId String     @map("organization_id") @db.Uuid
  teamId         String     @map("team_id") @db.Uuid
  objectTypeId   String     @map("object_type_id") @db.Uuid
  data           Json       @default("{}")
  displayName    String     @default("") @map("display_name")
  ownerType      ActorType? @map("owner_type")
  ownerId        String?    @map("owner_id")
  version        Int        @default(1)
  lastActivityAt DateTime?  @map("last_activity_at")
  // Transitive redirect pointer: merging B into C re-points every row whose
  // merged_into_id = B to C, so reads stay one hop (review M4). Deliberately
  // no FK: the survivor may be hard-deleted by retention after the loser.
  mergedIntoId   String?    @map("merged_into_id") @db.Uuid
  deletedAt      DateTime?  @map("deleted_at")
  createdByType  ActorType  @map("created_by_type")
  createdById    String     @map("created_by_id")
  createdAt      DateTime   @default(now()) @map("created_at")
  updatedAt      DateTime   @updatedAt @map("updated_at")
  objectType     ObjectType @relation(fields: [objectTypeId], references: [id], onDelete: Cascade)
  linksFrom      RecordLink[] @relation("LinkFrom")
  linksTo        RecordLink[] @relation("LinkTo")
  changes        RecordChange[]
  uniqueKeys     RecordUniqueKey[]
  search         RecordSearch?
  matchKeys      RecordMatchKey[]
  listEntries    ListEntry[]

  @@index([organizationId, teamId, objectTypeId, updatedAt(sort: Desc)])
  @@index([organizationId, teamId, objectTypeId, lastActivityAt])
  @@index([mergedIntoId])
  @@map("records")
}
// Added by raw SQL in the same migration (Prisma cannot express them):
//   CREATE INDEX records_data_gin ON records USING gin (data jsonb_path_ops);
//   CREATE INDEX records_display_name_trgm ON records USING gin (display_name gin_trgm_ops);

model RecordLink {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  teamId         String       @map("team_id") @db.Uuid
  relationTypeId String       @map("relation_type_id") @db.Uuid
  fromRecordId   String       @map("from_record_id") @db.Uuid
  toRecordId     String       @map("to_record_id") @db.Uuid
  label          String?
  data           Json         @default("{}")
  activeFrom     DateTime     @default(now()) @map("active_from")
  activeUntil    DateTime?    @map("active_until")
  createdByType  ActorType    @map("created_by_type")
  createdById    String       @map("created_by_id")
  createdAt      DateTime     @default(now()) @map("created_at")
  relationType   RelationType @relation(fields: [relationTypeId], references: [id], onDelete: Cascade)
  fromRecord     Record       @relation("LinkFrom", fields: [fromRecordId], references: [id], onDelete: Cascade)
  toRecord       Record       @relation("LinkTo", fields: [toRecordId], references: [id], onDelete: Cascade)

  @@index([fromRecordId, relationTypeId])
  @@index([toRecordId, relationTypeId])
  @@index([organizationId, teamId, relationTypeId])
  @@map("record_links")
}
// Raw SQL: CREATE UNIQUE INDEX record_links_active_unique
//   ON record_links (relation_type_id, from_record_id, to_record_id) WHERE active_until IS NULL;

model RecordUniqueKey {
  id              String    @id @default(uuid()) @db.Uuid
  organizationId  String    @map("organization_id") @db.Uuid
  teamId          String    @map("team_id") @db.Uuid
  attributeId     String    @map("attribute_id") @db.Uuid
  recordId        String    @map("record_id") @db.Uuid
  // sha-256 hex of the normalized value. The unique index is on the hash so a
  // long text value cannot exceed the btree tuple limit (review M14); the raw
  // normalized value is kept, unindexed, for evidence display.
  normalizedHash  String    @map("normalized_hash")
  normalizedValue String    @map("normalized_value")
  attribute       Attribute @relation(fields: [attributeId], references: [id], onDelete: Cascade)
  record          Record    @relation(fields: [recordId], references: [id], onDelete: Cascade)

  @@unique([attributeId, normalizedHash])
  @@index([recordId])
  @@index([organizationId, teamId])
  @@map("record_unique_keys")
}

/// Materialised keys for `block`-action matching rules (methods exact and
/// normalized only), written in the same transaction as the record so the
/// database enforces the block under concurrency (review C4). This table —
/// not a shadow key inside records.data — is where normalized matching state
/// lives, so redaction of `data` can never leak it (review S5.2).
model RecordMatchKey {
  id             String @id @default(uuid()) @db.Uuid
  organizationId String @map("organization_id") @db.Uuid
  teamId         String @map("team_id") @db.Uuid
  objectTypeId   String @map("object_type_id") @db.Uuid
  rulePosition   Int    @map("rule_position")
  normalizedHash String @map("normalized_hash")
  recordId       String @map("record_id") @db.Uuid
  record         Record @relation(fields: [recordId], references: [id], onDelete: Cascade)

  @@unique([objectTypeId, rulePosition, normalizedHash])
  @@index([recordId])
  @@map("record_match_keys")
}

model RecordChange {
  id             String     @id @default(uuid()) @db.Uuid
  organizationId String     @map("organization_id") @db.Uuid
  teamId         String     @map("team_id") @db.Uuid
  // Null exactly when kind = schema_change (enforced by a raw-SQL check
  // constraint). Link/unlink ops write ONE ROW PER ENDPOINT sharing group_id,
  // so both records' timelines and object-type-filtered feeds see the event
  // (review M2/M3).
  recordId       String?    @map("record_id") @db.Uuid
  groupId        String?    @map("group_id") @db.Uuid
  kind           ChangeKind
  attributeSlug  String?    @map("attribute_slug")
  relationTypeId String?    @map("relation_type_id") @db.Uuid
  linkId         String?    @map("link_id") @db.Uuid
  oldValue       Json?      @map("old_value")
  newValue       Json?      @map("new_value")
  snapshot       Json?                                   // full pre-image for merge/delete
  actorType      ActorType  @map("actor_type")
  actorId        String     @map("actor_id")
  onBehalfOf     String?    @map("on_behalf_of")          // UOA user id
  runId          String?    @map("run_id")
  toolCallId     String?    @map("tool_call_id")
  requestId      String     @map("request_id")
  reason         String?
  // Allocated from teams.feed_seq (commit-ordered, per tenant) — see Team.
  seq            BigInt
  occurredAt     DateTime   @default(now()) @map("occurred_at")
  // Cascade means retention hard-delete of a record removes its change rows;
  // the feed durability bound this implies is documented in events.md §2.
  record         Record?    @relation(fields: [recordId], references: [id], onDelete: Cascade)

  @@unique([teamId, seq])
  @@index([recordId, occurredAt(sort: Desc)])
  @@index([organizationId, teamId, seq])
  @@index([organizationId, teamId, attributeSlug, occurredAt])
  @@map("record_changes")
}
// Raw SQL: ALTER TABLE record_changes ADD CONSTRAINT record_changes_schema_kind
//   CHECK ((kind = 'schema') = (record_id IS NULL));

model RecordSearch {
  recordId       String                      @id @map("record_id") @db.Uuid
  organizationId String                      @map("organization_id") @db.Uuid
  teamId         String                      @map("team_id") @db.Uuid
  objectTypeId   String                      @map("object_type_id") @db.Uuid
  content        String
  embedding      Unsupported("vector(1024)")?
  embeddingModel String?                     @map("embedding_model")
  indexedAt      DateTime                    @default(now()) @map("indexed_at")
  record         Record                      @relation(fields: [recordId], references: [id], onDelete: Cascade)

  @@index([organizationId, teamId, objectTypeId])
  @@map("record_search")
}
// Raw SQL:
//   ALTER TABLE record_search ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
//   CREATE INDEX record_search_tsv ON record_search USING gin (tsv);
//   CREATE INDEX record_search_embedding ON record_search USING hnsw (embedding vector_cosine_ops);

// ───────────────────────── lists & views ─────────────────────────

model List {
  id             String      @id @default(uuid()) @db.Uuid
  organizationId String      @map("organization_id") @db.Uuid
  teamId         String      @map("team_id") @db.Uuid
  slug           String
  name           String
  description    String      @default("")
  objectTypeId   String?     @map("object_type_id") @db.Uuid   // null = mixed
  createdByType  ActorType   @map("created_by_type")
  createdById    String      @map("created_by_id")
  createdAt      DateTime    @default(now()) @map("created_at")
  updatedAt      DateTime    @updatedAt @map("updated_at")
  attributes     Attribute[]
  entries        ListEntry[]

  @@unique([organizationId, teamId, slug])
  @@map("lists")
}

model ListEntry {
  id        String   @id @default(uuid()) @db.Uuid
  listId    String   @map("list_id") @db.Uuid
  recordId  String   @map("record_id") @db.Uuid
  data      Json     @default("{}")
  position  Int      @default(0)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  list      List     @relation(fields: [listId], references: [id], onDelete: Cascade)
  record    Record   @relation(fields: [recordId], references: [id], onDelete: Cascade)

  @@unique([listId, recordId])
  @@map("list_entries")
}

model View {
  id             String    @id @default(uuid()) @db.Uuid
  organizationId String    @map("organization_id") @db.Uuid
  teamId         String    @map("team_id") @db.Uuid
  objectTypeId   String    @map("object_type_id") @db.Uuid
  slug           String
  name           String
  description    String    @default("")
  filter         Json      @default("{}")
  sort           Json      @default("[]")
  attributes     String[]  @default([])
  createdByType  ActorType @map("created_by_type")
  createdById    String    @map("created_by_id")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  @@unique([organizationId, teamId, slug])
  @@map("views")
}

// ───────────────────────── policy, approvals, audit ─────────────────────────

model PolicyRule {
  id             String             @id @default(uuid()) @db.Uuid
  organizationId String             @map("organization_id") @db.Uuid
  teamId         String             @map("team_id") @db.Uuid
  scope          PolicyScope
  scopeId        String             @map("scope_id")
  resourceType   PolicyResourceType @map("resource_type")
  action         PolicyAction
  effect         PolicyEffect
  priority       Int                @default(0)
  conditions     Json?
  requiresApproval Boolean          @default(false) @map("requires_approval")
  createdById    String             @map("created_by_id")
  createdAt      DateTime           @default(now()) @map("created_at")
  bindings       PolicyBinding[]

  @@index([organizationId, teamId, resourceType, action, scopeId, priority])
  @@map("policy_rules")
}

model PolicyBinding {
  id           String     @id @default(uuid()) @db.Uuid
  policyRuleId String     @map("policy_rule_id") @db.Uuid
  actorType    String     @map("actor_type")   // human | agent | role
  actorId      String     @map("actor_id")
  policyRule   PolicyRule @relation(fields: [policyRuleId], references: [id], onDelete: Cascade)

  @@unique([policyRuleId, actorType, actorId])
  @@index([actorType, actorId])
  @@map("policy_bindings")
}

model ApprovalRequest {
  id                String         @id @default(uuid()) @db.Uuid
  organizationId    String         @map("organization_id") @db.Uuid
  teamId            String         @map("team_id") @db.Uuid
  action            String                      // tool name; consumption is bound to it
  resourceType      String         @map("resource_type")
  resourceId        String?        @map("resource_id")
  argumentsHash     String         @map("arguments_hash")
  argumentsSnapshot Json           @map("arguments_snapshot")
  requesterType     ActorType      @map("requester_type")
  requesterId       String         @map("requester_id")
  onBehalfOf        String         @map("on_behalf_of")
  reason            String
  status            ApprovalStatus @default(pending)
  // sha-256 of the bearer token (>= 128-bit CSPRNG, prefixed apr_); the raw
  // value is returned once inside requestState and never stored.
  continuationTokenHash String     @unique @map("continuation_token_hash")
  resolverUoaUserId String?        @map("resolver_uoa_user_id")
  resolvedAt        DateTime?      @map("resolved_at")
  resolutionNote    String?        @map("resolution_note")
  expiresAt         DateTime       @map("expires_at")
  createdAt         DateTime       @default(now()) @map("created_at")

  @@index([organizationId, teamId, status])
  @@map("approval_requests")
}

/// INTENTIONALLY no FK on organization_id: audit rows survive tenant deletion.
model AuditLog {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  teamId         String?      @map("team_id") @db.Uuid
  actorType      ActorType    @map("actor_type")
  actorId        String       @map("actor_id")
  onBehalfOf     String?      @map("on_behalf_of")
  action         String
  resourceType   String       @map("resource_type")
  resourceId     String?      @map("resource_id")
  outcome        AuditOutcome
  reason         String?
  metadata       Json?
  requestId      String       @map("request_id")
  ipAddress      String?      @map("ip_address")
  userAgent      String?      @map("user_agent")
  prevHash       String?      @map("prev_hash")
  entryHash      String?      @map("entry_hash")
  createdAt      DateTime     @default(now()) @map("created_at")

  @@index([organizationId, createdAt(sort: Desc)])
  @@index([organizationId, resourceType, resourceId])
  @@map("audit_logs")
}

// ───────────────────────── jobs, webhooks, idempotency ─────────────────────────

model QueueJob {
  id             String    @id @default(uuid()) @db.Uuid
  // Null ONLY for system jobs (retention). Every client-addressable job
  // (bulk, dedup, export) carries both; tasks/get and tasks/cancel resolve by
  // (id, tenant) and answer NOT_FOUND on mismatch (review S1.1).
  organizationId String?   @map("organization_id") @db.Uuid
  teamId         String?   @map("team_id") @db.Uuid
  type           String
  // Lanes: delivery/reindex run in a high-priority pool bulk jobs cannot
  // starve; claim uses FOR UPDATE SKIP LOCKED with a lease — locked_at older
  // than the lease is reclaimable (review M7).
  priority       Int       @default(0)
  payload        Json
  idempotencyKey String?   @unique @map("idempotency_key")
  status         JobStatus @default(queued)
  attempts       Int       @default(0)
  maxAttempts    Int       @default(5) @map("max_attempts")
  visibleAt      DateTime  @default(now()) @map("visible_at")
  lockedAt       DateTime? @map("locked_at")
  lockedBy       String?   @map("locked_by")
  lastError      String?   @map("last_error")
  result         Json?
  progress       Json?
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  @@index([status, visibleAt])
  @@index([organizationId, teamId, type, createdAt(sort: Desc)])
  @@map("queue_jobs")
}

model Webhook {
  id             String    @id @default(uuid()) @db.Uuid
  organizationId String    @map("organization_id") @db.Uuid
  teamId         String    @map("team_id") @db.Uuid
  url            String
  events         String[]
  secretCiphertext String  @map("secret_ciphertext")
  active         Boolean   @default(true)
  lastDeliveredSeq BigInt  @default(0) @map("last_delivered_seq")
  lastError      String?   @map("last_error")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  @@unique([organizationId, teamId, url])
  @@map("webhooks")
}

model IdempotencyReplay {
  id              String   @id @default(uuid()) @db.Uuid
  organizationId  String   @map("organization_id") @db.Uuid
  teamId          String   @map("team_id") @db.Uuid
  // Replays are bound to the calling principal so a cached result shaped by
  // one caller's redaction can never be served to another (review S9.5).
  principalUserId String   @map("principal_user_id")
  key             String
  tool            String
  argumentsHash   String   @map("arguments_hash")
  // Null while the reserving transaction is in flight (step 0 of the write
  // path); filled in the same commit as the mutation (review C2).
  result          Json?
  createdAt       DateTime @default(now()) @map("created_at")

  @@unique([organizationId, teamId, principalUserId, tool, key])
  @@map("idempotency_replays")
}
```

## 3. Attribute type registry (`packages/schema-engine/src/attribute-types/`)

One module per type exporting `AttributeTypeDef`:

```ts
type AttributeTypeDef = {
  type: AttributeType
  configSchema: z.ZodType            // validates attributes.config at define time
  valueSchema: (config) => z.ZodType // validates one value
  normalize: (value, config) => string | null   // for unique keys + matching; null = not keyable
  toSearchText: (value, config) => string | null
  supportsMulti: boolean
  supportsUnique: boolean
  supportsIndexed: boolean
  filterOps: FilterOp[]
}
```

| type | value shape | config | normalize | notes |
|---|---|---|---|---|
| `text` | string ≤ `maxLength` (default 4000) | `{maxLength?}` | trim, lower, collapse whitespace | |
| `rich_text` | markdown string ≤ 100k | — | — | not unique/indexed |
| `number` | number | `{precision?, min?, max?}` | canonical decimal string | |
| `currency` | `{amount: string (decimal), currency: ISO4217}` | `{defaultCurrency}` | — | amount stored as string to avoid float drift |
| `percent` | number 0–100 | — | — | |
| `boolean` | boolean | — | `"true"/"false"` | |
| `date` | `YYYY-MM-DD` | — | same | |
| `datetime` | ISO 8601 UTC | — | same | |
| `select` | option id string | `{options: [{id, label, color?}]}` | option id | `isMulti` ⇒ multi-select |
| `status` | option id | `{options: [{id, label, category: open\|won\|lost\|neutral, position}]}` | option id | pipeline stages; never `isMulti` |
| `rating` | int 0–`max` | `{max: 5}` | — | |
| `email` | RFC 5322 address | — | lower-case, strip display name | unique-capable |
| `phone` | E.164 string | `{defaultRegion}` | E.164 via `libphonenumber-js` | unique-capable |
| `url` | absolute http(s) URL | — | lower host, strip trailing slash | |
| `domain` | hostname | — | registrable domain (`tldts`), lower | unique-capable |
| `location` | `{line1?, city?, region?, country? (ISO2), postal?, lat?, lng?}` | — | — | |
| `personal_name` | `{first?, last?, full}` | — | lower(full) collapse | `full` derived when absent |
| `actor_reference` | `{type: human\|agent, id}` | `{allow: [human, agent]}` | `type:id` | |
| `record_reference` | record id (string) or array when `isMulti` | `{objectTypes: [slug…], relationTypeSlug}` | record id | backed by a `RelationType`; see §4.4 |
| `timestamp_system` | ISO datetime | `{source: created_at\|updated_at\|last_activity_at}` | — | read-only, computed |
| `json` | any JSON ≤ 64 KiB | `{schema?: JSON Schema}` | — | unindexed, not unique |

Reserved attribute slugs on every object type (system, not stored in `data`): `id`, `created_at`, `updated_at`, `last_activity_at`, `display_name`, `owner`.

## 4. Write path — `applyWrite(tx, ctx, schema, op)`

Ops: `create`, `update`, `assert`, `delete`, `restore`, `link`, `unlink`, `merge`, `unmerge`. All inside `prisma.$transaction` (ReadCommitted) with explicit advisory locks. **Advisory locks use the two-int form** `pg_advisory_xact_lock(namespace, hashtext(tenantId ∥ key))` with a fixed namespace constant per concern (`1` records, `2` unique/match keys, `3` provisioning, `4` webhooks, `5` audit), so concerns and tenants never false-share a 32-bit bucket.

0. **Idempotency reservation (when `idempotency_key` given).** Take the key advisory lock, then `INSERT INTO idempotency_replays (…, principal_user_id, tool, key, arguments_hash, result NULL)`. Unique violation ⇒ read the row: same `arguments_hash` with a result ⇒ return it; same hash, null result ⇒ the winner is in flight — `IDEMPOTENCY_IN_PROGRESS` (client retries); different hash ⇒ `IDEMPOTENCY_MISMATCH`. The `result` is filled at step 12 **in the same commit** as the mutation, so "applied" and "replayable" are atomic (never stored after commit).
1. **Policy** — `checkPolicy(ctx, 'record', action, [record?, objectType, team])`; per touched `confidential|restricted` attribute, `checkPolicy(ctx, 'attribute', 'edit', …)`. Deny ⇒ `POLICY_DENIED` (audited with `outcome: denied`); a matching rule with `requiresApproval` for this actor ⇒ the MRTR approval path (mcp-surface §0.4).
2. **Schema** — `loadSchema(tenant)` cached by `(team_id, schema_version)` (the version is read in the same query that resolves the tenant, so the cache is self-invalidating with no TTL). Unknown slug ⇒ `UNKNOWN_ATTRIBUTE`; archived ⇒ `ATTRIBUTE_ARCHIVED`; system read-only ⇒ `ATTRIBUTE_READ_ONLY`.
3. **Validate & normalise (pure input checks only)** — per-attribute `valueSchema`; `isMulti` ⇒ array de-duplicated by `normalize`; `null` unsets (rejected on `isRequired`), `[]` is an empty list, distinct from unset; per-record `data` ≤ 256 KiB serialized. Values for `record_reference` attributes are *extracted as link operations* here — they are never written into `data` (§4a). Checks that depend on other rows (target existence, restrict blockers) move to step 5.
4. **Lock** — `lockRecords(tx, ids)` for every record touched, sorted ids; for the create/assert branch of a unique or match key, also the key lock on `hashtext(tenant ∥ attributeId ∥ normalizedHash)`.
5. **Locked-state validation** — record exists, tenant matches, not deleted; a merged id redirects transitively (`MERGED {redirect_to}` only when the final survivor is itself deleted); `record_reference` targets exist and are live; delete discovers dependents and evaluates `restrict` **after** locks (never before).
6. **Version** — `expected_version` mismatch ⇒ `VERSION_CONFLICT {current}`. Link/unlink bump `records.version` on **both** endpoints.
7. **Unique & match keys** — diff and write `record_unique_keys` (hash-indexed) and, for `block` rules, `record_match_keys`. Unique violation ⇒ `DUPLICATE_FOUND {attribute, record_id}` (conflicting id read back in-tx; only if the caller may view it, else the generic form). For `assert`: create runs under a savepoint — on unique violation, roll back to the savepoint and re-run as an update of the conflicting record (bounded to one retry). Match-key violation ⇒ `DUPLICATE_FOUND {candidates}`.
8. **Matching rules** (create/assert) — `warn` rules evaluated by read (§6), result attached as `duplicates`; `block` rules are enforced by step 7's constraint, not by a read.
9. **Data** — merge patch into `records.data`; recompute `display_name` from the primary attribute (whose sensitivity may not exceed `internal` — enforced at schema define/update); a no-op patch (normalised diff empty) writes nothing and does not bump `version`.
10. **Links** — apply extracted link ops and explicit `link`/`unlink`: cardinality enforced by ending conflicting active links (`active_until = now`), which the result reports (`ended_links`).
11. **Changes** — one row per attribute set/unset; **two rows per link/unlink (one per endpoint, shared `group_id`)**; delete/restore/merge rows carry `snapshot` (§7). `snapshot` is engine-internal: it is **never** serialized into any tool result, feed event or webhook.
12. **Audit + idempotency result** — take the audit advisory lock (namespace 5, per organization) and insert the hash-chained `audit_logs` row; **no further locks may be taken after the audit lock**. Fill the reserved idempotency row's `result`.
13. **Feed sequence** — allocate `seq` for every change row written: `UPDATE teams SET feed_seq = feed_seq + n WHERE id = $1 RETURNING feed_seq` as the **last** statement before commit (commit-ordered by the row lock; see the Team model comment).
14. **Enqueue (same tx, after allocation)** — `record.reindex {recordId}` (idempotency `reindex:<recordId>:<lastSeq>`) for every touched record, and `change.deliver {teamId}` (idempotency `deliver:<teamId>:<floor(now/30s)>`, `visibleAt = now + 30 s`) when the team has active webhooks.

### 4a. `record_reference` projections are computed, never stored

`data[slug]` for a reference attribute exists only in serialized output, assembled from active `record_links` at read time. Consequences, all deliberate (review C6): merge re-points one edge row and no third-party record is written; there is no projection drift; filtering on a reference attribute compiles to an `EXISTS` over `record_links`; replay of `record_changes` reproduces stored `data` exactly (reference state replays from link/unlink rows).

### 4b. `assert`

Resolve `match_attribute` (must be `isUnique`, else `VALIDATION_FAILED` naming the rule). **Multi-value match attributes:** the match key is the **first element** of the submitted array; if any *other* element resolves to a different record, fail with `DUPLICATE_FOUND` listing every candidate — the agent's cue to merge. Lookup by `(attribute_id, normalizedHash)` → update if found (redirecting through `merged_into_id`), else create via the savepoint path of step 7. Returns `{record, created}`.

### 4c. `delete` / `restore`

Soft delete sets `deleted_at`, ends active links per relation `on_delete` (`unlink` end; `cascade` soft-deletes `*_to_one` dependents, every cascaded delete change sharing a `group_id`; `restrict` ⇒ `DELETE_RESTRICTED {link_id}`), **releases unique and match keys** (recorded in the delete change's `snapshot`), and writes the `delete` change. `restore` reverses within the retention window, restoring the cascade set by `group_id` and re-claiming keys — a key taken meanwhile ⇒ `RESTORE_CONFLICT {attribute, held_by}` with an MRTR confirmation offering restore-without-the-conflicting-value.

## 5. Query grammar — `compileFilter(schema, filter) → Prisma where + raw SQL fragments`

```json
{ "and": [
    { "attribute": "stage", "op": "in", "value": ["qualified", "proposal"] },
    { "attribute": "amount", "op": "gte", "value": 10000 },
    { "or": [
        { "attribute": "owner", "op": "eq", "value": { "type": "human", "id": "usr_1" } },
        { "attribute": "tags", "op": "contains", "value": "enterprise" }
    ]},
    { "not": { "attribute": "close_date", "op": "is_null" } },
    { "linked_to": { "relation": "deal_for_company", "record_id": "…", "direction": "from" } },
    { "system": "last_activity_at", "op": "lt", "value": "2026-07-01T00:00:00Z" },
    { "text": "packaging" }
]}
```

Ops by type: `eq neq in not_in is_null is_not_null` (all); `contains starts_with` (text, email, url, domain, personal_name, select-multi); `gt gte lt lte between` (number, currency.amount, percent, rating, date, datetime, timestamp_system). `text` = full-text on `record_search.tsv`. Sort: `[{attribute|system, direction}]`, max 3 keys. Pagination: opaque cursor = base64 of the last sort values + id, **bound to (tool, tenant, full argument set)** — a mismatched cursor is `VALIDATION_FAILED {detail: "cursor_mismatch"}`; `limit` 1–200 (default 50). Filters are capped at depth 8, 100 nodes, 16 KiB serialized. Object-valued attributes (`actor_reference`, `currency`, `location`, `personal_name`) compare with JSONB equality (`data->slug = $::jsonb`) against values canonicalised at write (fixed key order), never `->>` text comparison. A filter on a `record_reference` attribute compiles to an `EXISTS` over `record_links` (§4a). Attribute values are read as `data->>slug` with casts per type; indexed attributes use expression indexes named `idx_records_<first 8 hex of the attribute id>` (stable, unique, inside the 63-byte identifier limit) `ON records ((data->>'slug')) WHERE object_type_id = '…'`, created by the worker job `attribute.index` when `isIndexed` is set — the one exception to "no DDL": `CONCURRENTLY`, idempotent, and the job first drops any `INVALID` index of that name (a crashed build). Unsetting `isIndexed` or archiving the attribute runs `DROP INDEX CONCURRENTLY`. Indexed attributes are capped per tenant (`LIMIT_EXCEEDED`).

## 6. Matching rules

`{attribute_slugs, method, threshold?, action}` ordered by `position`, validated at `crm_matching_rule_set`:

- **`block` requires `method ∈ {exact, normalized}`** — a block must be enforceable by the database. Each block rule materialises a compound key (`sha256` of the rule's normalized attribute values joined with `\x1f`) into `record_match_keys`, written in the write transaction; the unique constraint is what blocks, so concurrent duplicates cannot race past it (review C4). Setting a block rule over existing data runs a backfill Task and reports pre-existing collisions rather than failing.
- **`fuzzy` may only `warn`**, `threshold ≥ 0.5`, allowed on `text`/`personal_name`/`domain` only; evaluated as `similarity(display_name, $) ≥ threshold` served by the trigram index, capped at the top 20 candidates per write.
- `warn` rules with `exact|normalized` are evaluated by lookup against the `record_unique_keys`/`record_match_keys` hashes.

Result: `candidates: [{record, rule_position, evidence}]`. Evidence values are redacted for the caller (`{kind, attribute, matched: true}` when the attribute is not viewable — review S4.4). The engine never merges on its own.

## 7. Merge — `planMerge` + `executeMerge`

Input: `survivor_id`, `merged_ids[]` (1–10), `field_choices?: {slug: record_id}`, `reason`. Approval-gated by policy default.

1. Lock all records (sorted). Same object type, same tenant, none deleted; merged inputs rejected.
2. Per attribute: chosen value = `field_choices[slug]` if given, else survivor's non-null, else newest non-null among losers (by last `set` change). `isMulti` ⇒ union de-duplicated by `normalize`. A `field_choices` id outside the merge set ⇒ `VALIDATION_FAILED`.
3. **Keys follow data, no exceptions** (review M5): a loser's unique key moves to the survivor only when its value is present in the survivor's post-merge `data` (union for multi; explicit `field_choices` replacement for single). Keys whose values did not survive are dropped and recorded in the snapshot.
4. Links: re-point losers' `record_links` rows to the survivor (one edge write each — projections are computed, §4a, so no third-party records are touched); duplicates on `(relation_type, from, to)` collapse keeping the oldest; a `*_to_one` conflict keeps the survivor's own link and ends the loser's. Every re-point/end writes its paired change rows.
5. List entries re-pointed; duplicates dropped and recorded.
6. Losers: `merged_into_id = survivor`, `deleted_at = now`; **every existing row whose `merged_into_id` is a loser is re-pointed to the survivor**, so redirects stay one hop after chained merges (review M4). One `merge` change on the survivor carries the snapshot; one on each loser.
7. **Snapshot shape (normative — the producer writes exactly what unmerge consumes, review B38):** `{ survivorBefore: data, losers: [{ id, data, uniqueKeys }], repointedLinks: [{ linkId, originalFrom, originalTo }], endedLinks: [linkId], movedKeys: [{ attributeId, normalizedHash, fromRecordId }], droppedKeys: […], movedEntries: [{ listId, recordId }] }`. Snapshots are engine-internal, never serialized outward, and live as long as their change row (removed only by retention hard-delete of the record).
8. Reads by a loser id resolve the redirect and return the survivor with `redirected_from`; `MERGED {redirect_to}` is raised only when the survivor is itself deleted.
9. `crm_unmerge(merge_change_id)`: restore losers' `data` and keys from the snapshot; re-point `repointedLinks` back and un-end `endedLinks`; remove keys/entries the merge moved where the survivor did not hold them pre-merge; changes made to the survivor **after** the merge win, and every collision (a key or link the survivor now legitimately holds) is returned in `conflicts: [{kind, attribute?, link_id?, held_by}]` rather than silently dropped (review C5). Clear the losers' `merged_into_id` and recompute chained pointers.

## 8. Search document

`buildSearchContent(record, schema, links)`: `display_name`, then each `public|internal` attribute's `toSearchText`, then for each active link the relation `forward_name` + target `display_name` (one hop). Max 8 KiB. A `display_name` change enqueues one `record.reindex_neighbours` job that re-renders inbound-linked records' content in batches, re-embedding only when a stored `content_hash` changed (review M9); the `crm_search` description states the eventual-consistency window. Embedded via Ledger `/v1/jina` with `dimensions = EMBEDDING_DIMENSIONS`; `embedding_model` recorded. Embedding requests are batched (≤ 64 records per call) behind a circuit breaker — on failure records stay keyword-searchable and the job dead-letters rather than blocking the queue. Semantic queries run a tenant-filtered iterative scan (`hnsw.iterative_scan`, pgvector ≥ 0.8) so small tenants keep recall in a shared index; an `embed.model_migrate` job re-embeds rows whose `embedding_model` differs from current. Per-tenant index partitioning is deferred until one tenant exceeds ~1M vectors. Hybrid search = reciprocal rank fusion (k = 60) of tsvector rank and cosine distance, top 50 each, then policy redaction.

## 9. Templates (`packages/schema-engine/src/templates/*.json`)

`standard_crm` (person, company, deal + relations + matching rules as in brief §5.6), `system` (activity, note, task, their relation types — applied automatically on tenant provision), later `saas`, `agency`. Template application is idempotent: existing slugs are left untouched; new ones added; never archives.

System object types created on provision:
- `activity`: `kind (select: email|call|meeting|note|message|task_event|custom)`, `occurred_at (datetime, required)`, `direction (select: inbound|outbound|internal)`, `subject (text)`, `body (rich_text)`, `participants (actor_reference, multi)`, `external_ref (text, unique)`.
- `note`: `title (text)`, `body (rich_text, required)`.
- `task`: `title (text, required)`, `body (rich_text)`, `status (status: open|in_progress|done|cancelled)`, `due_at (datetime)`, `assignee (actor_reference)`, `priority (select: low|normal|high|urgent)`.
- Relation types (`fromObjectTypeId` set, `toObjectTypeId` null = any): `activity_about`, `note_about`, `task_about` — `many_to_many`, `on_delete: unlink`.

## 10. Error codes (`@deepcrm/schemas/errors.ts`)

`POLICY_DENIED`, `APPROVAL_REQUIRED`, `UNKNOWN_OBJECT_TYPE`, `UNKNOWN_ATTRIBUTE`, `ATTRIBUTE_ARCHIVED`, `ATTRIBUTE_READ_ONLY`, `VALIDATION_FAILED {issues}`, `VERSION_CONFLICT {current}`, `DUPLICATE_FOUND {attribute?, record_id?, candidates?}`, `NOT_FOUND`, `MERGED {redirect_to}`, `CARDINALITY_VIOLATION`, `DELETE_RESTRICTED`, `SCHEMA_CONFLICT {detail}`, `IDEMPOTENCY_MISMATCH`, `IDEMPOTENCY_IN_PROGRESS`, `RESTORE_CONFLICT {attribute, held_by}`, `UNKNOWN_TEMPLATE {available}`, `TENANT_MISMATCH`, `LIMIT_EXCEEDED {limit}`, `INTERNAL {correlation_id}`. Error messages are templates and never echo submitted values; `VALIDATION_FAILED.issues[].path` is an RFC 6901 JSON Pointer, and op/type-mismatch issues name the ops valid for the attribute's type.
