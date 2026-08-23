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
  normalizedValue String    @map("normalized_value")
  attribute       Attribute @relation(fields: [attributeId], references: [id], onDelete: Cascade)
  record          Record    @relation(fields: [recordId], references: [id], onDelete: Cascade)

  @@unique([attributeId, normalizedValue])
  @@index([recordId])
  @@map("record_unique_keys")
}

model RecordChange {
  id             String     @id @default(uuid()) @db.Uuid
  organizationId String     @map("organization_id") @db.Uuid
  teamId         String     @map("team_id") @db.Uuid
  recordId       String     @map("record_id") @db.Uuid
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
  seq            BigInt     @default(autoincrement())     // change-feed cursor
  occurredAt     DateTime   @default(now()) @map("occurred_at")
  record         Record     @relation(fields: [recordId], references: [id], onDelete: Cascade)

  @@index([recordId, occurredAt(sort: Desc)])
  @@index([organizationId, teamId, seq])
  @@index([organizationId, teamId, attributeSlug, occurredAt])
  @@map("record_changes")
}

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
  action            String                      // tool name
  resourceType      String         @map("resource_type")
  resourceId        String?        @map("resource_id")
  argumentsHash     String         @map("arguments_hash")
  argumentsSnapshot Json           @map("arguments_snapshot")
  requesterType     ActorType      @map("requester_type")
  requesterId       String         @map("requester_id")
  onBehalfOf        String         @map("on_behalf_of")
  reason            String
  status            ApprovalStatus @default(pending)
  continuationToken String         @unique @map("continuation_token")
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
  organizationId String?   @map("organization_id") @db.Uuid
  teamId         String?   @map("team_id") @db.Uuid
  type           String
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
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String   @map("organization_id") @db.Uuid
  teamId         String   @map("team_id") @db.Uuid
  key            String
  tool           String
  argumentsHash  String   @map("arguments_hash")
  result         Json
  createdAt      DateTime @default(now()) @map("created_at")

  @@unique([organizationId, teamId, key])
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

Ops: `create`, `update`, `assert`, `delete`, `restore`, `link`, `unlink`, `merge`, `unmerge`. All inside `prisma.$transaction` with `isolationLevel: 'ReadCommitted'` and explicit advisory locks.

1. **Policy** — `checkPolicy(ctx, 'record', action, [record?, objectType, team, org])`; for each attribute touched with `sensitivity ∈ confidential|restricted`, `checkPolicy(ctx, 'attribute', 'edit', [attribute…])`. Denied ⇒ `POLICY_DENIED` (or MRTR approval when the rule has `requiresApproval`).
2. **Schema** — `loadSchema(tenant)` cached by `teams.schema_version`; unknown attribute slug ⇒ `UNKNOWN_ATTRIBUTE`; archived ⇒ `ATTRIBUTE_ARCHIVED`; system read-only ⇒ `ATTRIBUTE_READ_ONLY`.
3. **Validate & normalise** — per attribute `valueSchema`; `isMulti` ⇒ array, de-duplicated by `normalize`; `isRequired` on create ⇒ present and non-null; `record_reference` ⇒ target exists, same tenant, not deleted/merged, `objectTypes` allowed.
4. **Lock** — `SELECT pg_advisory_xact_lock(hashtext(recordId))` for every record touched (sorted ids to avoid deadlocks).
5. **Version** — `expected_version` given and ≠ `records.version` ⇒ `VERSION_CONFLICT {current}`.
6. **Unique keys** — delete old keys for changed unique attributes, insert new `(attribute_id, normalized)`; unique violation ⇒ `DUPLICATE_FOUND {attribute, record_id}` (the conflicting record id is read back in the same tx).
7. **Matching rules** (create/assert only) — evaluate §6; `block` ⇒ `DUPLICATE_FOUND {candidates}`; `warn` ⇒ continue and attach `duplicates` to the result.
8. **Data** — compute new `data` (merge patch: keys with `null` unset), `display_name` from the primary attribute (`toSearchText`), `version + 1`.
9. **Links** — for `record_reference` attributes, diff current active links vs new ids and write `record_links` (+ projection into `data[slug]`); for explicit `link/unlink` ops enforce cardinality (`one_to_*`/`*_to_one`: end the existing active link with `active_until = now` before inserting).
10. **Changes** — one `record_changes` row per attribute set/unset and per link/unlink, with `old_value`/`new_value`, actor, provenance, reason.
11. **Audit** — `writeAudit(tx, …)`.
12. **Enqueue** — `record.reindex {recordId}` (idempotency `reindex:<recordId>:<version>`) and, if webhooks exist, `change.deliver {teamId}` (idempotency `deliver:<teamId>:<minute>`).
13. **Idempotency** — if `idempotency_key` given: before step 1 look up `idempotency_replays`; hit with same `arguments_hash` ⇒ return stored result; hit with different hash ⇒ `IDEMPOTENCY_MISMATCH`. Store result after commit.

`assert`: resolve `match_attribute` (must be `isUnique`) → normalise the incoming value → look up `record_unique_keys` → `update` if found else `create`. Returns `{record, created: boolean}`.

`delete` (soft): sets `deleted_at`, ends active links per `on_delete` (`unlink`: end; `cascade`: soft-delete the other side when it is a `*_to_one` dependent; `restrict`: `DELETE_RESTRICTED`), writes a `delete` change with `snapshot`. `restore` reverses within retention.

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

Ops by type: `eq neq in not_in is_null is_not_null` (all); `contains starts_with` (text, email, url, domain, personal_name, select-multi); `gt gte lt lte between` (number, currency.amount, percent, rating, date, datetime, timestamp_system). `text` = full-text on `record_search.tsv`. Sort: `[{attribute|system, direction}]`, max 3 keys. Pagination: opaque cursor = base64 of the last sort values + id; `limit` 1–200 (default 50). Attribute values are read as `data->>slug` with casts per type; indexed attributes use expression indexes `CREATE INDEX CONCURRENTLY records_<objtype>_<slug> ON records ((data->>'slug')) WHERE object_type_id = '…'` created by the worker job `attribute.index` when `isIndexed` is set (this is DML-free schema metadata + an index; it is the one exception to "no DDL", runs `CONCURRENTLY`, and is idempotent).

## 6. Matching rules

`{attribute_slugs, method, threshold?, action}` ordered by `position`. Evaluate on create/assert against non-deleted, non-merged records of the same type:

- `exact` — every listed attribute's raw value equal.
- `normalized` — every listed attribute's `normalize(value)` equal (uses `record_unique_keys` when the attribute is unique, else a `data->>slug` comparison on normalised values stored in a per-attribute normalised shadow key `_n.<slug>` inside `data`).
- `fuzzy` — `similarity(display_name, candidate) >= threshold` via `pg_trgm`, only allowed on `text`/`personal_name`/`domain`.

Result: `candidates: [{record_id, rule_position, evidence: [{attribute, value}]}]`. The engine never merges on its own.

## 7. Merge — `planMerge` + `executeMerge`

Input: `survivor_id`, `merged_ids[]` (1–10), `field_choices?: {slug: record_id}`, `reason`.
1. Lock all records (sorted). All same object type, same tenant, none deleted/merged.
2. For each attribute: chosen value = `field_choices[slug]`'s value if given; else survivor's non-null; else newest non-null among merged (by that attribute's last `set` change). `isMulti` ⇒ union de-duplicated by `normalize`.
3. Unique keys: move losers' keys to survivor where survivor lacks them; drop the rest.
4. Links: re-point `from_record_id`/`to_record_id` from losers to survivor; collapse duplicates on `(relation_type, from, to)` keeping the oldest; enforce cardinality (a `*_to_one` conflict keeps survivor's own link and ends the loser's).
5. List entries re-pointed (duplicate ⇒ drop the loser's).
6. Losers: `merged_into_id = survivor`, `deleted_at = now`; one `merge` change on the survivor with `snapshot = {survivorBefore, losers: [...full pre-images including links]}`, one `merge` change on each loser.
7. Reads by a loser id return the survivor with `redirected_from: loserId` (service-level redirect, one hop).
8. `unmerge(merge_change_id)` restores from the snapshot within `DEEPCRM_RETENTION_DAYS`; changes made to the survivor after the merge are kept; re-linking is best-effort and reported.

## 8. Search document

`buildSearchContent(record, schema, links)`: `display_name`, then each `public|internal` attribute's `toSearchText`, then for each active link the relation `forward_name` + target `display_name` (one hop). Max 8 KiB. Embedded via Ledger `/v1/jina` with `dimensions = EMBEDDING_DIMENSIONS`; `embedding_model` recorded. Hybrid search = reciprocal rank fusion (k = 60) of tsvector rank and cosine distance, top 50 each, then policy redaction.

## 9. Templates (`packages/schema-engine/src/templates/*.json`)

`standard_crm` (person, company, deal + relations + matching rules as in brief §5.6), `system` (activity, note, task, their relation types — applied automatically on tenant provision), later `saas`, `agency`. Template application is idempotent: existing slugs are left untouched; new ones added; never archives.

System object types created on provision:
- `activity`: `kind (select: email|call|meeting|note|message|task_event|custom)`, `occurred_at (datetime, required)`, `direction (select: inbound|outbound|internal)`, `subject (text)`, `body (rich_text)`, `participants (actor_reference, multi)`, `external_ref (text, unique)`.
- `note`: `title (text)`, `body (rich_text, required)`.
- `task`: `title (text, required)`, `body (rich_text)`, `status (status: open|in_progress|done|cancelled)`, `due_at (datetime)`, `assignee (actor_reference)`, `priority (select: low|normal|high|urgent)`.
- Relation types (`fromObjectTypeId` set, `toObjectTypeId` null = any): `activity_about`, `note_about`, `task_about` — `many_to_many`, `on_delete: unlink`.

## 10. Error codes (`@deepcrm/schemas/errors.ts`)

`POLICY_DENIED`, `APPROVAL_REQUIRED`, `UNKNOWN_OBJECT_TYPE`, `UNKNOWN_ATTRIBUTE`, `ATTRIBUTE_ARCHIVED`, `ATTRIBUTE_READ_ONLY`, `VALIDATION_FAILED {issues}`, `VERSION_CONFLICT {current}`, `DUPLICATE_FOUND {attribute?, record_id?, candidates?}`, `NOT_FOUND`, `MERGED {redirect_to}`, `CARDINALITY_VIOLATION`, `DELETE_RESTRICTED`, `SCHEMA_CONFLICT {detail}`, `IDEMPOTENCY_MISMATCH`, `LIMIT_EXCEEDED`, `INTERNAL`.
