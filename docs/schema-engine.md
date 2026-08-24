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
  // `UPDATE teams SET feed_seq = feed_seq + n ... RETURNING` in applyWrite
  // AFTER all data/links writes and change-intent formation but BEFORE the
  // change-row inserts, the enqueues, the idempotency result and the audit
  // insert (§4 step 12), so the row lock makes seq order equal commit order
  // per tenant. Never a Postgres sequence: sequences
  // allocate at insert time and a slow transaction would commit a seq the
  // feed cursor has already passed (review C1).
  feedSeq        BigInt       @default(0) @map("feed_seq")
  // Origin write-guard (defence in depth for taint boundaries like DeepSignal's
  // per-user connector gate): a write whose declared `origin` is in this list
  // is refused with ORIGIN_REJECTED. Owner-set via crm_origin_guard_set.
  rejectedOrigins String[]    @default([]) @map("rejected_origins")
  // Write-guard extensions (R1/R16): refuse origin-less writes; refuse
  // non-team visibility from listed app keys (server-enforces a product's
  // "everything we write is team-visible" invariant).
  requireOrigin  Boolean      @default(false) @map("require_origin")
  teamVisibilityOnlyApps String[] @default([]) @map("team_visibility_only_apps")
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
  registry_id
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

enum Visibility {
  team
  users
  private
}

enum SuppressionKind {
  email
  phone
  domain
  company_number
  postal
}

enum SuppressionChannel {
  all
  email
  phone_call
  sms
  post
}

enum SuppressionReason {
  objection
  erasure
  bounce
  manual
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
  suppression
}

enum PolicyAction {
  view
  create
  edit
  delete
  restore
  erase
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
  // Per-record visibility (DATA, not policy — deepsignal policy-asks §1):
  // team (default) = tenant policy applies; users = only the humans in
  // record_visibility_grants (plus the creator); private = the creating
  // on_behalf_of human only. Evaluated BEFORE policy on every read and write;
  // unlisted principals get NOT_FOUND. Admins are NOT exempt — the one
  // recovery path is an owner-only, approval-gated visibility change.
  visibility     Visibility @default(team)
  createdOnBehalfOf String? @map("created_on_behalf_of")
  // Declared origin class of the data (set-once, caller-supplied); checked
  // against Team.rejectedOrigins at write.
  origin         String?
  // Set by crm_record_erase: data scrubbed, tombstone retained (§4d).
  erasedAt       DateTime?  @map("erased_at")
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
  visibilityGrants RecordVisibilityGrant[]
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
  // Non-null only on links backing a multi record_reference attribute:
  // the target's slot in the projected array — contiguous, 0-based, one
  // active link per position (unique partial index below). Direct links
  // (crm_link, scalar references) always carry null.
  position       Int?
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
// Raw SQL: CREATE UNIQUE INDEX record_links_active_position_unique
//   ON record_links (organization_id, team_id, from_record_id, relation_type_id, position)
//   WHERE active_until IS NULL AND position IS NOT NULL;

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

/// Explicit principal list for visibility = users. Grants name HUMANS (UOA
/// user ids); an agent sees the record when its on_behalf_of human is granted.
model RecordVisibilityGrant {
  id        String @id @default(uuid()) @db.Uuid
  recordId  String @map("record_id") @db.Uuid
  uoaUserId String @map("uoa_user_id")
  record    Record @relation(fields: [recordId], references: [id], onDelete: Cascade)

  @@unique([recordId, uoaUserId])
  @@index([uoaUserId])
  @@map("record_visibility_grants")
}

/// Compliance note: suppression_entries INTENTIONALLY has no FK to
/// organizations/teams/records. A suppression list must outlive the data it
/// protects: tenant deletion and record erasure must never delete the fact
/// that a person objected (deepsignal policy-asks §3). Rows hold NO readable
/// personal data — only sha-256 hashes of normalized structural facts.
model SuppressionEntry {
  id             String            @id @default(uuid()) @db.Uuid
  organizationId String            @map("organization_id") @db.Uuid
  teamId         String            @map("team_id") @db.Uuid
  kind           SuppressionKind
  // PECR routing is per channel: an address lawful for post may be suppressed
  // for email. 'all' suppresses every channel (R7).
  channel        SuppressionChannel @default(all)
  // sha256hex(kind + '\x1f' + normalized value). Normalisations are pinned
  // byte-exactly in §4d — clients pre-filtering against crm_suppression_list
  // hashes must reproduce them.
  keyHash        String            @map("key_hash")
  reason         SuppressionReason
  // Queryable refinement (opt_out, not_interested, complaint, existing_client…);
  // `note` is prose and not queryable.
  subReason      String?           @map("sub_reason")
  // Time-boxed suppression ("not interested" ⇒ 12 months). NEVER allowed on
  // reason objection|erasure — those are permanent. Expired entries answer
  // suppressed:false and are pruned by retention.
  expiresAt      DateTime?         @map("expires_at")
  note           String?
  sourceRecordId String?           @map("source_record_id") @db.Uuid
  createdByType  ActorType         @map("created_by_type")
  createdById    String            @map("created_by_id")
  onBehalfOf     String?           @map("on_behalf_of")
  createdAt      DateTime          @default(now()) @map("created_at")

  @@unique([teamId, kind, keyHash, channel])
  @@index([organizationId, teamId])
  @@map("suppression_entries")
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
  // The record's version immediately after this change applied — the field
  // crm_record_at derives `version_at` from. Non-null on EVERY row: record
  // rows carry the record's post-write version (paired link/unlink rows each
  // carry their own endpoint's post-write version); kind = schema_change rows
  // carry the tenant's current schema version (teams.schema_version) — never
  // a null or sentinel. Set at change-intent formation, before seq
  // allocation (§4 step 12).
  resultingVersion Int      @map("resulting_version")
  // Allocated from teams.feed_seq (commit-ordered, per tenant) as a block
  // BEFORE these rows are inserted, so change rows are written with a final
  // non-null seq in one insert — never allocated at insert time (see Team).
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
//   (record_search_model on embedding_model is NOT created here — it lands
//    with the R13 model-migration machinery in T48's migration.)

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
  // The human who registered it: events are visibility-filtered as this
  // principal (events.md §1). Deliveries pause when this principal has not
  // been seen (principal_last_seen) within DEEPCRM_WEBHOOK_PRINCIPAL_STALE_DAYS
  // and resume on their next authenticated call (R11).
  subscribingUoaUserId String @map("subscribing_uoa_user_id")
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

/// Operational liveness evidence, NOT an identity store: one row per human
/// seen in a team through a verified delegation, upserted on every request.
/// Backs webhook-subscriber staleness (R11), actor-reference validation (R25 —
/// owner/grant/subowner ids must have been seen in this team, or be the
/// caller), and the data-quality stale_actors bucket. Also the PG-backed
/// single-use requestId seen-set lives here-adjacent (unlogged table
/// seen_request_ids, raw SQL) so replay bounds hold across API replicas.
model PrincipalLastSeen {
  teamId     String   @map("team_id") @db.Uuid
  uoaUserId  String   @map("uoa_user_id")
  lastSeenAt DateTime @map("last_seen_at")

  @@id([teamId, uoaUserId])
  @@map("principal_last_seen")
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
| `rich_text` | markdown string ≤ 100k | — | — | not unique/indexed; search strips Markdown delimiters but preserves ordinary punctuation |
| `number` | number | `{precision?, min?, max?}` | canonical decimal string | |
| `currency` | `{amount: string (decimal), currency: supported ISO4217 code}` | `{defaultCurrency, fixedCurrency?}` | — | codes are checked against the supported ISO-4217 set, not merely a three-letter regex; amount as string; range filters compare `amount` **ignoring currency** — set `fixedCurrency` on columns meant to be comparable (R19) |
| `percent` | number 0–100 | — | — | |
| `boolean` | boolean | — | `"true"/"false"` | |
| `date` | `YYYY-MM-DD` | — | same | |
| `datetime` | ISO 8601 UTC | — | same | |
| `select` | option id string | `{options: [{id: Slug, label: 1–120 chars, color?: 1–32 chars}]}` | option id | `isMulti` ⇒ multi-select; ids unique |
| `status` | option id | `{options: [{id: Slug, label: 1–120 chars, color?: 1–32 chars, category: open\|won\|lost\|neutral, position}]}` | option id | pipeline stages; never `isMulti`; ids/positions unique and positions contiguous from zero |
| `rating` | int 0–`max` | `{max: 5}` | — | |
| `email` | RFC 5322 address | — | lower-case, strip display name | unique-capable |
| `phone` | international number (`+` required; only whitespace formatting is permitted) | — | canonical E.164 via `libphonenumber-js`; no regional guessing and no extensions | unique-capable |
| `url` | absolute http(s) URL | — | lower host, strip trailing slash | |
| `domain` | hostname or absolute http(s) URL | — | validates the host in either form, then returns registrable domain (`tldts`), lower | unique-capable |
| `registry_id` | company/registry number string | `{jurisdiction?}` | uppercase; strip spaces, hyphens, dots; strip leading zeros | unique-capable; the one normalizer for Companies-House-style ids (R19) |
| `location` | `{line1?: ≤200, line2?: ≤200, city?: ≤120, region?: ≤120, country?: ISO2, postal?: ≤32, lat?, lng?}` | — | — | latitude −90…90; longitude −180…180 |
| `personal_name` | `{first?: ≤120, last?: ≤120, full?: ≤250}` | — | lower(full) collapse | at least one field; `full` derived when absent |
| `actor_reference` | `{type: human\|agent, id}` | `{allow: [human, agent]}` | `type:id` | |
| `record_reference` | record id (string) or array when `isMulti` | `{objectTypes: [slug…], relationTypeSlug}` | record id | backed by a `RelationType`; see §4.4 |
| `timestamp_system` | ISO datetime | `{source: created_at\|updated_at\|last_activity_at}` | — | virtual, computed and read-only; it is never stored in `records.data`; T12 owns the write-time rejection gate |
| `json` | any JSON ≤ 64 KiB | `{schema?: JSON Schema}` | — | unindexed, not unique, **no type filterOps**; global null tests are handled outside the registry — promote queryable keys to real attributes (R19) |

Registry notes: `currency`, `percent`, `rating` and `location` have no `normalize` and therefore cannot back a unique key or a matching rule — stated here so nobody designs a match rule on money (R19). `isMulti` is **immutable after define**, like `type` and `slug` (R19). Each type's `toSearchText` follows its `normalize` where present; `rich_text` **is** included in search content as stripped markdown truncated to 2 KiB per value (R14); composite quantity values (number + unit + tolerance) are an open question (brief §9).

Capability matrix (`multi`, `unique`, `indexed`): text Y/Y/Y; rich_text Y/N/N; number Y/Y/Y; currency Y/N/N; percent Y/N/Y; boolean Y/Y/Y; date Y/Y/Y; datetime Y/Y/Y; select Y/Y/Y; status N/N/Y; rating Y/N/Y; email Y/Y/Y; phone Y/Y/Y; url Y/Y/Y; domain Y/Y/Y; registry_id Y/Y/Y; location Y/N/N; personal_name Y/Y/N; actor_reference Y/Y/N; record_reference Y/N/Y; timestamp_system N/N/N; json Y/N/N. `record_reference` indexing is satisfied only by the existing `record_links` indexes and `EXISTS` compilation; it creates no JSON expression index.

Validation details: number precision rejects excess fractional precision rather than rounding, uses `decimal.js`, and stores canonical non-exponent decimals. Dates are real Gregorian `YYYY-MM-DD`; datetimes require RFC3339 with `Z` or an explicit offset and normalize to UTC millisecond `Z`. Currency codes must be members of the maintained supported ISO-4217 set (not merely `/^[A-Z]{3}$/`); `fixedCurrency` requires such a code and comparisons otherwise remain explicitly currency-agnostic. Phone input is already international: a leading `+` is required, whitespace is the only allowed presentation formatting, and extensions or regional/default-country interpretation are refused. Select/status option ids use `Slug`, labels are 1–120 characters, and optional colors are 1–32 characters; select ids are unique, and status ids and positions are unique with positions contiguous from zero. URLs require absolute http(s), lowercase host, remove a trailing slash only from an otherwise empty path, and preserve meaningful path/query. Domains validate their host whether supplied as a hostname or absolute http(s) URL, then normalize with `tldts` to lowercase registrable domain. Rich-text search removes Markdown delimiters while retaining ordinary punctuation. Location and personal-name fields observe the caps in the registry table. JSON Schema validation uses Draft 2020-12 with Ajv v8, no external references; Ajv is a direct T09 dependency.

Reserved attribute slugs on every object type (system, not stored in `data`): `id`, `created_at`, `updated_at`, `last_activity_at`, `display_name`, `owner`.

## 3a. Schema evolution over live data (R9)

- **Config changes that alter `normalize`** (text normalisation, select option ids) are refused with `SCHEMA_CONFLICT` unless run with a **key-recompute backfill Task** (MRTR states the affected row count) that rewrites `record_unique_keys`/`record_match_keys` hashes — a silent config change would strand every stored hash and make asserts mint duplicates.
- **Select/status options are archivable, never deletable while referenced.** An archived option remains a valid *stored* value (reads, filters, history) and an invalid value for *new writes*; `crm_attribute_update` reports the live-value count via MRTR before archiving an option.
- **Tightening bounds** (`maxLength`, `min`/`max`, `rating.max`) over existing values: MRTR reports violations; stored values are **grandfathered** — they stay valid until the next write touches that attribute on that record.
- **Raising `sensitivity` past `internal`, or archiving an attribute with values, enqueues a bulk `record.reindex` Task for the object type in the same commit** (MRTR states the record count; the tool result names the Task) — stored search content and embeddings must stop carrying the now-sensitive value (R5a). The same trigger applies to config changes that alter `toSearchText`.

## 4. Write path — `applyWrite(tx, ctx, schema, op)`

Ops: `create`, `update`, `assert`, `delete`, `restore`, `erase`, `link`, `unlink`, `merge`, `unmerge`. All inside `prisma.$transaction` (ReadCommitted) with explicit advisory locks. **Advisory locks use the two-int form** `pg_advisory_xact_lock(namespace, hashtext(tenantId ∥ key))` with a fixed namespace constant per concern (`1` records, `2` unique/match keys, `3` provisioning, `4` webhooks, `5` audit), so concerns and tenants never false-share a 32-bit bucket.

0. **Idempotency reservation (when `idempotency_key` given).** Take the key advisory lock, then `INSERT INTO idempotency_replays (…, principal_user_id, tool, key, arguments_hash, result NULL)`. Unique violation ⇒ read the row: same `arguments_hash` with a result ⇒ return it; same hash, null result ⇒ the winner is in flight — `IDEMPOTENCY_IN_PROGRESS` (client retries); different hash ⇒ `IDEMPOTENCY_MISMATCH`. The `result` is filled at step 12 **in the same commit** as the mutation, so "applied" and "replayable" are atomic (never stored after commit).
1. **Visibility gate (before policy)** — every record touched or read passes `canSee(ctx, record)`: `team` ⇒ yes; `users` ⇒ `ctx.onBehalfOf.uoaUserId` equals `created_on_behalf_of` or is in `record_visibility_grants`; `private` ⇒ creator only. Fail ⇒ `NOT_FOUND` (no existence oracle; admins are not exempt). Then **policy** — `checkPolicy(ctx, 'record', action, [record?, objectType, team])`; per touched `confidential|restricted` attribute, `checkPolicy(ctx, 'attribute', 'edit', …)`. Deny ⇒ `POLICY_DENIED` (audited with `outcome: denied`); a matching rule with `requiresApproval` for this actor ⇒ the MRTR approval path (mcp-surface §0.4).
2. **Schema** — `loadSchema(tenant)` cached by `(team_id, schema_version)` (the version is read in the same query that resolves the tenant, so the cache is self-invalidating with no TTL). Unknown slug ⇒ `UNKNOWN_ATTRIBUTE`; archived ⇒ `ATTRIBUTE_ARCHIVED`; only reserved virtual slugs (`id`, `created_at`, `updated_at`, `last_activity_at`, `display_name`, `owner`) and `timestamp_system`/future explicit virtual-read-only types ⇒ `ATTRIBUTE_READ_ONLY`. `Attribute.isSystem` alone is writable.
3. **Validate & normalise (pure input checks only)** — the write guard: declared `origin` (set-once) checked against `Team.rejectedOrigins` ⇒ `ORIGIN_REJECTED`, absent origin with `Team.requireOrigin` ⇒ `ORIGIN_REJECTED {origin: null}`, and `visibility ≠ team` (or any `visible_to`) under an app key listed in `Team.teamVisibilityOnlyApps` ⇒ `VISIBILITY_REJECTED` (R1); `visibility`/`visible_to` inputs validated (grants are UOA user ids; `visible_to` implies `users`); per-attribute `valueSchema`; `isMulti` ⇒ array de-duplicated by `normalize` — **multi values preserve submitted order, de-duplication keeps the first occurrence, and serialization returns stored order** (a ranked list is data; R2). For ordinary stored attributes, `null` unsets/removes the key (rejected on `isRequired`); `[]` is a distinct stored empty list and is valid even when required. Per-record `data` ≤ 256 KiB serialized. Values for `record_reference` attributes are *extracted as link operations* here — they are never written into `data` (§4a). Extraction semantics: an **omitted** reference key carries no intent and leaves existing links untouched; a scalar UUID makes exactly one target; a scalar **`null`** clears the reference (ends all of the attribute's active backing links); a scalar **empty array** is a validation error (`VALIDATION_FAILED`). For a multi reference, the submitted array is de-duplicated **stably** in submitted order (first occurrence wins, same rule as every multi attribute; a repeated id yields one link), and a multi **`null`** or **empty array `[]`** clears the reference. Otherwise the resulting ids replace the active set exactly (a diff ends missing links and inserts new ones). The canonical intent shape is `LinkIntent` (§4e). Checks that depend on other rows (target existence, restrict blockers) move to step 5.
4. **Lock** — `lockRecords(tx, ids)` for every record touched, sorted ids; for the create/assert branch of a unique or match key, also the key lock on `hashtext(tenant ∥ attributeId ∥ normalizedHash)`.
5. **Locked-state validation** — record exists, tenant matches, not deleted; a merged id redirects transitively (`MERGED {redirect_to}` only when the final survivor is itself deleted); `record_reference` targets exist and are live; delete discovers dependents and evaluates `restrict` **after** locks (never before).
6. **Version** — `expected_version` mismatch ⇒ `VERSION_CONFLICT {current}`. Link/unlink bump `records.version` on **both** endpoints.
7. **Unique & match keys** — diff and write `record_unique_keys` (hash-indexed) and, for `block` rules, `record_match_keys`. Unique violation ⇒ `DUPLICATE_FOUND {attribute, record_id}` (conflicting id read back in-tx; only if the caller may view it, else the generic form). For `assert`: create runs under a savepoint — on unique violation, roll back to the savepoint and re-run as an update of the conflicting record (bounded to one retry). Match-key violation ⇒ `DUPLICATE_FOUND {candidates}`.
8. **Matching rules** (create/assert) — `warn` rules evaluated by read (§6), result attached as `duplicates`; `block` rules are enforced by step 7's constraint, not by a read.
9. **Data** — merge patch into `records.data`; recompute `display_name` from the primary attribute (whose sensitivity may not exceed `internal` — enforced at schema define/update); a no-op patch (normalised diff empty) writes nothing and does not bump `version`.
10. **Links** — apply extracted link ops and explicit `link`/`unlink`: cardinality enforced by ending conflicting active links (`active_until = now`), which the result reports (`ended_links`). Cardinality caps: `many_to_one` ⇒ at most one active outgoing link per `(from, relation)`; `one_to_many` ⇒ at most one active incoming link per `(to, relation)`; `one_to_one` ⇒ both; `many_to_many` ⇒ neither. Links backing a **multi** `record_reference` get `position` = the target's index in the submitted array (contiguous, 0-based, per §2 `RecordLink.position`); when an update diff ends an interior link, the surviving links are renumbered to close the gap so positions stay contiguous. Direct links (`crm_link`) and links backing scalar references always have `position = null`. Links created for a reference **replace** projection carry empty edge data (`data = {}`) — a re-point must not silently overwrite operator-set edge attributes — and links that survive the diff **retain** their existing edge data.
11. **Change intents** — form the change rows (insert deferred to step 13, after seq allocation): one `set`/`unset` row per attribute, in deterministic ascending-slug order; on create, the `create` marker row first, then the per-attribute `set` rows for every stored attribute of the initial state (defaults included) — **every** row of the create, marker included, carries `resulting_version = 1`; **two rows per link/unlink (one per endpoint, shared `group_id`)**, each carrying its own endpoint's post-write version as `resulting_version`; delete/restore/merge rows carry `snapshot` (§7). `snapshot` is engine-internal: it is **never** serialized into any tool result, feed event or webhook.
12. **Feed sequence block** — `UPDATE teams SET feed_seq = feed_seq + n WHERE id = $1 RETURNING feed_seq` where `n` is the number of change intents; commit-ordered by the row lock (see the Team model comment). Every change row then carries the full `{ …, resultingVersion, seq }` shape and is inserted with a final, non-null seq.
13. **Changes, enqueue, idempotency result** — insert the change rows; `record.reindex {recordId}` (idempotency `reindex:<recordId>:<lastSeq>`) for every touched record, and `change.deliver {teamId}` (idempotency `deliver:<teamId>:<floor(now/30s)>`, `visibleAt = now + 30 s`) when the team has active webhooks; fill the reserved idempotency row's `result` (step 0) **in this same commit**, so "applied" and "replayable" are atomic (never stored after commit).
14. **Audit LAST** — take the audit advisory lock (namespace 5, per organization) and insert the hash-chained `audit_logs` row. `writeAudit` is the **last database operation of the transaction**: no DB operation follows it except the commit itself, and no further locks may be taken after the audit lock (auth-and-tenancy §6).

### 4a. `record_reference` projections are computed, never stored

`data[slug]` for a reference attribute exists only in serialized output, assembled from active `record_links` at read time. Consequences, all deliberate (review C6): merge re-points one edge row and no third-party record is written; there is no projection drift; filtering on a reference attribute compiles to an `EXISTS` over `record_links`; replay of `record_changes` reproduces stored `data` exactly (reference state replays from link/unlink rows).

### 4b. `assert`

Resolve `match_attribute` (must be `isUnique`, else `VALIDATION_FAILED` naming the rule). **Multi-value match attributes:** the match key is the **first element** of the submitted array; if any *other* element resolves to a different record, fail with `DUPLICATE_FOUND` listing every candidate — the agent's cue to merge. Lookup by `(attribute_id, normalizedHash)` → update if found (redirecting through `merged_into_id`), else create via the savepoint path of step 7. Returns `{record, created}`.

### 4c′. Visibility interactions (normative)

- **Every row, count, sum and derived aggregate is computed over the caller's visibility-filtered row set** — `crm_records_count`, `include_total`, `crm_pipeline_summary`, `crm_data_quality` buckets, `crm_export` rows and `crm_list_entries` included; for the semantic path the visibility predicate is part of the same SQL predicate the HNSW iterative scan filters on — pre-filter, never post-filter of a top-k (R15). Query, search, timeline, links-list, duplicates and the change feed apply the gate per row; a link whose far end is invisible is omitted from listings, and a `DUPLICATE_FOUND` against an invisible record returns the generic form (no `record_id`, no candidates).
- The search index stores no visibility copy — filtering happens at query time against `visibility`/grants.
- Changing visibility is `record.edit` on the record — except **widening a record the caller cannot see** (recovering an orphaned private record), which only a team owner may do, approval-gated; existence is disclosed to the owner, data is not until the change lands.
- Merge requires the actor to see **all** records in the merge set; the survivor keeps the most restrictive visibility and the union of grants.

### 4c. `delete` / `restore`

Soft delete sets `deleted_at`, ends active links per relation `on_delete` (`unlink` end; `cascade` soft-deletes `*_to_one` dependents, every cascaded delete change sharing a `group_id`; `restrict` ⇒ `DELETE_RESTRICTED {link_id}`), **releases unique and match keys** (recorded in the delete change's `snapshot`), and writes the `delete` change. `restore` reverses within the retention window, restoring the cascade set by `group_id` and re-claiming keys — a key taken meanwhile ⇒ `RESTORE_CONFLICT {attribute, held_by}` with an MRTR confirmation offering restore-without-the-conflicting-value.

### 4d. `erase` — the right-to-erasure operation (deepsignal policy-asks §3)

`crm_record_erase {id, reason, suppress?: boolean = true}` — owner-only by default (policy `record.erase`), audited, and the **one documented exception to change-log immutability**. `reason` is a **closed enum** (`gdpr_request | retention_policy | legal_order | other`) so nothing personal can ride into the audit trail through it; audit `metadata` for erase carries ids and counts only (R26).

1. If `suppress` (default): for every contact-shaped attribute value on the record (`email`, `phone`, `domain`, `registry_id`), write a `suppression_entries` row (`reason: erasure`, channel `all`) from the normalized hash **before** anything is scrubbed.
2. Scrub: `records.data = {}`, `display_name = '(erased)'`, `erasedAt = now`, unique/match keys deleted, search row deleted, visibility grants deleted, active links ended — **and, in the same transaction, `record_links.data` on every link (active or ended) touching the record, and `list_entries.data` on every entry pointing at it, are cleared** (R12). Enqueue `record.reindex_neighbours` so linked records' search content and embeddings stop carrying the erased `display_name` (R5b).
3. History scrub: every `record_changes` row for this record has `old_value`, `new_value` and `snapshot` **nulled in place** — rows, kinds, actors, seqs and timestamps remain, so the feed and the audit chain stay intact (the chain hashes audit rows, not change rows).
4. The record row remains as a tombstone: `ERASED` on direct reads, never restorable, never hard-deleted by retention — the tombstone is what proves erasure happened.
5. One `record.erase` audit row; the change feed emits a **typed `record.erased` event** (not a generic delete) — consumers holding copies (webhook receivers, feed pullers, export takers) are contractually obliged to erase their copies on it (events.md §1; R26).

**Bounded residuals, stated honestly (R12/R26):** already-taken copies (export files, delivered webhook bodies, pulled feed pages) are unreachable by construction — the `record.erased` event is the recall signal, not a guarantee; free-text mentions of a person inside *other* records' activity/note bodies are outside erasure's mechanical reach; replay results (24 h), completed queue jobs (purged after 7 days), approval snapshots (purged 30 days after expiry) and export files (1 h) hold data only for their stated retention bounds, enforced by the retention job.

**Suppression store** (§2 `SuppressionEntry`): `crm_suppression_add {kind, value, channel?, reason, sub_reason?, expires_at?, note?}` (value normalized + hashed in memory, never stored raw; `expires_at` refused on `objection`/`erasure`), `crm_suppression_check {entries: [{kind, value, channel?}]}` → per-entry `{suppressed, reason?, sub_reason?}` (an `all` entry suppresses every channel; expired entries answer false) — **the send-time gate any outbound product must call**, `crm_suppression_list` (hashes + metadata only), `crm_suppression_remove` (owner + approval — un-suppressing an objector is a real decision). Suppression rows survive tenant deletion and erasure by construction (no FKs).

**Normalisations are pinned byte-exactly** (clients pre-filtering against listed hashes must reproduce them; R7): `email` — trim, lower-case, strip display name; `phone` — **input must already be E.164** (must start `+`; anything else is `VALIDATION_FAILED` — no region guessing at this seam); `domain` — registrable domain via `tldts`, lower-case; `company_number` — uppercase, strip spaces/hyphens/dots, strip leading zeros (Companies House `01234567` ≡ `1234567`), the same normalizer as the `registry_id` attribute type; `postal` — **the caller pre-normalizes** to `ISO2 country + '|' + uppercase postcode + '|' + first address line`, DeepCRM only trims, uppercases and collapses whitespace before hashing (address canonicalisation is the sender's problem, stated rather than pretended). Hash = `sha256hex(kind + '\x1f' + normalized)`.

### 4e. `LinkIntent` — the typed shape of a reference write

Validation (step 3) turns every submitted `record_reference` value into one typed intent per attribute:

```ts
type LinkIntent = {
  kind: 'record_reference'
  attributeSlug: string
  relationTypeId: string                       // the resolved backing relation
  cardinality: 'many_to_one' | 'many_to_many'  // scalar / multi
  targetIds: string[]                          // submitted order; stably de-duplicated
}
```

Intent semantics per §4 step 3: an omitted key produces **no intent** (existing links are left untouched); a scalar UUID yields `targetIds = [id]` (one target); a scalar `null` yields a clear intent (`targetIds = []`, replace-with-empty); a scalar empty array never reaches this point — it is a validation error in step 3; a multi array is stably de-duplicated in submitted order into `targetIds`; a multi `null` or empty array yields a clear intent (`targetIds = []`, replace-with-empty). Stored-data exclusion per §4a: intents drive link rows only and nothing is ever written into `records.data` for a reference attribute.

### 4f. `record_reference` owns one backing relation

Every `record_reference` attribute owns exactly one backing `RelationType` (never shares one). Scalar references back a `many_to_one` relation; multi (`is_multi: true`) references back a `many_to_many` relation. `config.objectTypes` with exactly one slug sets the relation's `to_object_type_id` to that type; multiple slugs (open target) store `to_object_type_id = null`, and validation of the submitted target ids against `config.objectTypes` is config enforcement in the write path (§4 steps 3/5), not a schema constraint. When `config.relationTypeSlug` is supplied it must name an existing relation whose `cardinality`, `from_object_type_id` (this object type), `to_object_type_id` and `projection_attribute_slug` (this attribute's slug, or unset) are all compatible with the attribute — any mismatch is `SCHEMA_CONFLICT`. A compatible supplied relation with an unset `projection_attribute_slug` is atomically claimed by setting it to this attribute slug; one already claimed by another attribute is `SCHEMA_CONFLICT`. When absent, the relation is created with slug `<objectType>_<attr>` (T10).

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

Ops by type: `eq neq in not_in is_null is_not_null` (all); `contains starts_with` (text, email, url, domain, registry_id, personal_name, select-multi); `contains` additionally on **multi `actor_reference`** (matches one canonicalised `{type, id}` element — "records where I am a preferred subowner"; R4) and on multi `record_reference` (compiled as `linked_to` over the backing relation); `gt gte lt lte between` (number, currency.amount, percent, rating, date, datetime, timestamp_system). `text` = full-text on `record_search.tsv`. Sort: `[{attribute|system, direction}]`, max 3 keys. Pagination: opaque cursor = base64 of the last sort values + id, **bound to (tool, tenant, full argument set)** — a mismatched cursor is `VALIDATION_FAILED {detail: "cursor_mismatch"}`; `limit` 1–200 (default 50). Filters are capped at depth 8, 100 nodes, 16 KiB serialized. Object-valued attributes (`actor_reference`, `currency`, `location`, `personal_name`) compare with JSONB equality (`data->slug = $::jsonb`) against values canonicalised at write (fixed key order), never `->>` text comparison. A filter on a `record_reference` attribute compiles to an `EXISTS` over `record_links` (§4a). Attribute values are read as `data->>slug` with casts per type; indexed attributes use expression indexes named `idx_records_<first 8 hex of the attribute id>` (stable, unique, inside the 63-byte identifier limit) `ON records ((data->>'slug')) WHERE object_type_id = '…'`, created by the worker job `attribute.index` when `isIndexed` is set — the one exception to "no DDL": `CONCURRENTLY`, idempotent, and the job first drops any `INVALID` index of that name (a crashed build). A `record_reference` with `isIndexed` is the exception: it is link-backed metadata satisfied by the existing `record_links` indexes and `EXISTS` filtering, so it creates no `records.data` expression index and no `attribute.index` DDL job. Unsetting `isIndexed` or archiving an expression-indexed attribute runs `DROP INDEX CONCURRENTLY`. Indexed attributes are capped per tenant (`LIMIT_EXCEEDED`).

## 6. Matching rules

`{attribute_slugs, method, threshold?, action}` ordered by `position`, validated at `crm_matching_rule_set`:

- **`block` requires `method ∈ {exact, normalized}`** — a block must be enforceable by the database. Each block rule materialises a compound key (`sha256` of the rule's normalized attribute values joined with `\x1f`) into `record_match_keys`, written in the write transaction; the unique constraint is what blocks, so concurrent duplicates cannot race past it (review C4). Setting a block rule over existing data runs a backfill Task and reports pre-existing collisions rather than failing.
- **`fuzzy` may only `warn`**, `threshold ≥ 0.5`, allowed on `text`/`personal_name`/`domain` only; evaluated as `similarity(display_name, $) ≥ threshold` served by the trigram index, capped at the top 20 candidates per write.
- `warn` rules with `exact|normalized` are evaluated by lookup against the `record_unique_keys`/`record_match_keys` hashes.

Result: `candidates: [{record, rule_position, evidence}]`. Evidence values are redacted for the caller (`{kind, attribute, matched: true}` when the attribute is not viewable — review S4.4). The engine never merges on its own.

## 7. Merge — `planMerge` + `executeMerge`

Input: `survivor_id`, `merged_ids[]` (1–10), `field_choices?: {slug: record_id}`, `reason`. Approval-gated by policy default.

1. Lock all records (sorted). Same object type, same tenant, none deleted; merged inputs rejected.
2. Per attribute: chosen value = `field_choices[slug]` if given — **for multi attributes the chosen record's list wins wholesale, no union** (R3a) — else survivor's non-null, else newest non-null among losers (by last `set` change). Default for `isMulti` without a choice: **the survivor's list in its stored order, then losers' unseen values appended in their order — never interleaved** (order is data; R3b). A `field_choices` id outside the merge set ⇒ `VALIDATION_FAILED`.
3. **Keys follow data, no exceptions** (review M5): a loser's unique key moves to the survivor only when its value is present in the survivor's post-merge `data` (union for multi; explicit `field_choices` replacement for single). Keys whose values did not survive are dropped and recorded in the snapshot.
4. Links: re-point losers' `record_links` rows to the survivor (one edge write each — projections are computed, §4a, so no third-party records are touched); duplicates on `(relation_type, from, to)` collapse keeping the oldest; a `*_to_one` conflict keeps the survivor's own link and ends the loser's. Every re-point/end writes its paired change rows.
5. List entries re-pointed; duplicates dropped and recorded.
6. Losers: `merged_into_id = survivor`, `deleted_at = now`; **every existing row whose `merged_into_id` is a loser is re-pointed to the survivor**, so redirects stay one hop after chained merges (review M4). One `merge` change on the survivor carries the snapshot; one on each loser.
7. **Snapshot shape (normative — the producer writes exactly what unmerge consumes, review B38):** `{ survivorBefore: data, losers: [{ id, data, uniqueKeys }], repointedLinks: [{ linkId, originalFrom, originalTo }], endedLinks: [linkId], movedKeys: [{ attributeId, normalizedHash, fromRecordId }], droppedKeys: […], movedEntries: [{ listId, recordId }] }`. Snapshots are engine-internal, never serialized outward, and live as long as their change row (removed only by retention hard-delete of the record).
8. Reads by a loser id resolve the redirect and return the survivor with `redirected_from`; `MERGED {redirect_to}` is raised only when the survivor is itself deleted.
9. `crm_unmerge(merge_change_id)`: restore losers' `data` and keys from the snapshot; re-point `repointedLinks` back and un-end `endedLinks`; remove keys/entries the merge moved where the survivor did not hold them pre-merge; changes made to the survivor **after** the merge win, and every collision (a key or link the survivor now legitimately holds) is returned in `conflicts: [{kind, attribute?, link_id?, held_by}]` rather than silently dropped (review C5). Clear the losers' `merged_into_id` and recompute chained pointers.

## 8. Search document

`buildSearchContent(record, schema, links)`: `display_name`, then each `public|internal` attribute's `toSearchText`, then for each active link the relation `forward_name` + target `display_name` (one hop). Max 8 KiB. Content assembly order (the 8 KiB cap truncates from the end): `display_name`, attributes by `position` (rich_text stripped + 2 KiB-capped per value), then linked names — for `activity` records the newest content wins the budget (R14). A `display_name` change enqueues one `record.reindex_neighbours` job that re-renders inbound-linked records' content in batches, re-embedding only when a stored `content_hash` changed (review M9); the `crm_search` description states the eventual-consistency window. Embedded via Ledger `/v1/jina` with `dimensions = EMBEDDING_DIMENSIONS`; `embedding_model` recorded. Embedding requests are batched (≤ 64 records per call) behind a circuit breaker — on failure records stay keyword-searchable and the job dead-letters rather than blocking the queue. Semantic queries run a tenant-filtered iterative scan (`hnsw.iterative_scan`, pgvector ≥ 0.8) so small tenants keep recall in a shared index; an `embed.model_migrate` job re-embeds rows whose `embedding_model` differs from current — and **semantic queries always filter `embedding_model = current`** (cosine distance across models is meaningless; recall dips during migration, the keyword leg of hybrid is unaffected; a replacement model must produce `EMBEDDING_DIMENSIONS`-wide vectors or the change is a column migration, not a job; R13). Per-tenant index partitioning is deferred until one tenant exceeds ~1M vectors. Hybrid search = reciprocal rank fusion (k = 60) of tsvector rank and cosine distance, top 50 each, then policy redaction.

## 9. Templates (`packages/schema-engine/src/templates/*.json`)

`standard_crm` (person, company, deal + relations + matching rules as in brief §5.6), `system` (activity, note, task, their relation types — applied automatically only when a team is first provisioned), later `saas`, `agency`. Templates are statically imported JSON modules (`resolveJsonModule`); no runtime filesystem read is permitted. `TemplateAdded` is exactly `{ objectTypes: number; attributes: number; relationTypes: number; matchingRules: number }`. Template application is conservatively idempotent: independently absent object-type, attribute, and relation-type slugs are added, but existing rows are never updated or archived. Primaries and matching rules are assigned only to object types created by that application. An existing row referenced by a new definition must be compatible or the transaction fails.

Both template paths run inside the caller's single transaction under the namespace-3 provisioning advisory lock. Trusted internal `applyTemplateBatch(tx, tenant, actor, slug)` performs exactly four passes, in order — object-type shells with primaries unset; explicit relation types; attributes and compatible `record_reference` projection claims; then primaries and matching rules — and returns `{ added: TemplateAdded }` without incrementing a version or writing an audit. Its shared internal relation primitive accepts the template's typed `isSystem` flag; the public schema mutation API still cannot set projection ownership. Public `applyTemplate(tx, tenant, actor, slug)` calls the batch seam, increments `schemaVersion` exactly once iff the sum of `added` is non-zero, and writes exactly one terminal `schema.template.apply` audit; a zero-addition call changes neither version nor audit state. First-contact tenancy instead calls the batch seam directly after default-policy seeding, increments `policyVersion` once and `schemaVersion` once iff the system template added anything, and writes exactly one terminal `tenant.provisioned` audit. It never also writes `schema.template.apply`.

**Evidence-bearing facts — the blessed idiom (R18):** a fact that carries its own provenance (`observed_at`, source URL, confidence band, verdict) is modelled as its **own object type** with a `{subject}:{dimension}` unique text key and a `record_reference` to its subject — not as metadata bolted onto another record's attribute. `crm_record_assert` on the unique key gives idempotent re-observation; history gives the audit trail. A per-attribute evidence sidecar may come later; this pattern is supported today and is what integrations should build on.

System object types created on provision:
- `activity`: `kind (select: email|call|meeting|note|message|task_event|custom)`, `occurred_at (datetime, required)`, `direction (select: inbound|outbound|internal)`, `subject (text)`, `body (rich_text)`, `participants (actor_reference, multi)`, `external_ref (text, unique)`.
- `note`: `title (text)`, `body (rich_text, required)`.
- `task`: `title (text, required)`, `body (rich_text)`, `status (status: open|in_progress|done|cancelled)`, `due_at (datetime)`, `assignee (actor_reference)`, `priority (select: low|normal|high|urgent)`.
- Relation types (`fromObjectTypeId` set, `toObjectTypeId` null = any): `activity_about`, `note_about`, `task_about` — `many_to_many`, `on_delete: unlink`.

## 10. Error codes (`@deepcrm/schemas/errors.ts`)

`POLICY_DENIED`, `APPROVAL_REQUIRED`, `UNKNOWN_OBJECT_TYPE`, `UNKNOWN_ATTRIBUTE`, `ATTRIBUTE_ARCHIVED`, `ATTRIBUTE_READ_ONLY`, `VALIDATION_FAILED {issues}`, `VERSION_CONFLICT {current}`, `DUPLICATE_FOUND {attribute?, record_id?, candidates?}`, `NOT_FOUND`, `MERGED {redirect_to}`, `CARDINALITY_VIOLATION`, `DELETE_RESTRICTED`, `SCHEMA_CONFLICT {detail}`, `IDEMPOTENCY_MISMATCH`, `IDEMPOTENCY_IN_PROGRESS`, `RESTORE_CONFLICT {attribute, held_by}`, `UNKNOWN_TEMPLATE {available}`, `TENANT_MISMATCH`, `TENANT_REPARENTING` (retryable — UOA re-parented the team and reconciliation is running), `ORIGIN_REJECTED {origin}`, `VISIBILITY_REJECTED`, `ERASED`, `LIMIT_EXCEEDED {limit}`, `INTERNAL {correlation_id}`. **`ErrorCode` is append-only** — codes are never renamed or removed, so consumers may treat unknown codes as fatal-and-surface (R8). Error messages are templates and never echo submitted values; `VALIDATION_FAILED.issues[].path` is an RFC 6901 JSON Pointer, and op/type-mismatch issues name the ops valid for the attribute's type.
