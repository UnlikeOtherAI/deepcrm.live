# Events protocol — change feed, webhooks, delivery targets

One event model, three consumers: the `crm_changes_since` tool (pull), HMAC webhooks (push), and future delivery adapters (Matrix room, Nessie integration endpoint). The source of truth is `record_changes`; nothing is emitted that is not a row there.

## 1. Event

An **event** is a `Change` (see `contracts.md` → `records.ts`) plus a derived `event` name:

| `kind` | `event` |
|---|---|
| `create` | `record.created` |
| `set`, `unset` | `record.updated` |
| `delete` | `record.deleted` |
| `restore` | `record.updated` |
| `merge` (on survivor) | `record.merged` — payload adds `merged_ids` |
| `merge` (on loser) | `record.deleted` with `merged_into` |
| `unmerge` | `record.updated` |
| `erase` (from `crm_record_erase`) | **`record.erased`** — typed, value-free. **Consumer obligation:** any holder of copies (webhook receivers, feed pullers, export takers) MUST erase its copies of this record on receipt; this event is the recall signal for data already outside DeepCRM (R26). |
| `link` | `link.created` |
| `unlink` | `link.ended` |
| schema mutation (no record) | `schema.changed` — emitted from a synthetic change row with `record = null`, `attribute` = affected slug, `new_value = { object_type, schema_version }` |

`seq` is **per-team and commit-ordered** — allocated from `teams.feed_seq` as a block (§4 step 12) before the change rows are inserted with their final non-null seq, and only the audit insert follows in the transaction (step 14, audit-last), so a consumer's cursor can never pass an in-flight transaction's lower seq (review C1). Link/unlink events appear once per endpoint (paired rows share `group_id`); consumers dedupe on `group_id` when they only care about the edge.

Redaction: every event passes the same `redactForActor` pass as a record read, by the **current** sensitivity, retroactively; `snapshot` payloads never appear in any event (reviews S5.3/S5.4).

**Webhooks pause for departed subscribers:** deliveries suspend when the subscribing principal has not been seen (`principal_last_seen`) within `DEEPCRM_WEBHOOK_PRINCIPAL_STALE_DAYS` (default 30) and resume on their next authenticated call — the residual (a leaver keeps receiving team events for up to N days) is stated and owned, since DeepCRM has no UOA membership-change signal (R11). **Webhooks carry a subscribing principal and are value-free for sensitive data** (deepsignal policy-asks §2): each webhook stores the human who registered it (`subscribing_uoa_user_id`); events are visibility-filtered as that principal (a `users`/`private` record's events are omitted unless the subscriber is granted), and `confidential`/`restricted` attribute values are **always omitted from push payloads** — the event names the attribute slug, never the value. A webhook is a nudge; consumers that need values pull them through `crm_changes_since`/`crm_record_get` under a real principal with real redaction. There is no admin shortcut of any kind.

**Envelope authority:** this document's §3 envelope is the wire truth; any envelope sketch elsewhere (mcp-surface §8) is illustrative and defers here (R10).

## 2. Pull — `crm_changes_since`

- `cursor` = decimal string of the last `seq` seen. **Omitting it returns an empty page with a fresh cursor at now** — replaying full retained history is the explicit opt-in `from: "beginning"` (review M13).
- Returns up to `limit` events with `seq > cursor`, ascending, filtered by `object_types`/`kinds`; `next_cursor` = last `seq` returned (or the input cursor when empty); `has_more`.
- Retention: change rows are immutable **except** they cascade when retention hard-deletes a record `DEEPCRM_RETENTION_DAYS` after its soft delete. A cursor therefore never expires, but a consumer lagging more than the retention window can miss the tail of hard-deleted records' histories — documented, accepted (review B41). Consumers store the cursor (Nessie: on the trigger's state).

## 2a. Behavioural events — `crm_event_*`

Behavioural events are not change-feed rows and are not webhook delivery units.
They are tenant-scoped CRM facts ingested through `crm_event_type_define`,
`crm_event_ingest` and `crm_events_query`: for example a product integration can
define `product_feature_used`, ingest source/idempotency-scoped occurrences, and
later query them for a visible subject record.

An event type has a stable slug, optional subject object type, and a closed JSON
object property schema. Ingest validates the subject's tenant, visibility and
object type before storing properties; `(event_type, source, external_id)` is
idempotent and returns the existing event on replay. Events are append-only:
correction is represented by a new event whose `correction_of_event_id` points
to the earlier event. DeepCRM never interprets the property text or classifies
the behaviour; callers decide what the typed fact means.

`crm_events_query` returns events ordered by occurrence time using an opaque
cursor. If a specific subject id is supplied and it is hidden or belongs to
another tenant, the standard no-oracle `NOT_FOUND` contract applies. Broad
queries omit events whose subject is no longer visible to the caller.

## 3. Push — webhooks

### Registration
`crm_webhook_set { url, events[], active, rotate_secret? }` — owner-only **and approval-gated** (a webhook is an outward data replay channel; review S6.2). Identity is the URL (upsert; the secret rotates only with `rotate_secret: true`). `url` must be `https://`, public host, port 443, no userinfo. Secret: 32 random bytes hex, returned once (secret material — the integration code storing it must keep it out of model context), sealed with the keyring (`kid`-versioned ciphertexts). **A new webhook starts at the current max seq** — it never replays history; historical export is `crm_export`, which carries its own approval.

### Delivery
Worker job `change.deliver` per team, triggered by the write path (debounced: `visibleAt = now + 30 s`, idempotency `deliver:<teamId>:<floor(now/30s)>` — the single debounce constant). Delivery always goes through `safeFetch`: fresh DNS resolution, connection pinned to the vetted IPs, private/loopback/link-local refused at connect time, redirects not followed — on **every** attempt, not just registration (review S6.1).

```
POST <url>
Content-Type: application/json
X-DeepCRM-Delivery: <uuid>                 unique per attempt batch
X-DeepCRM-Webhook: <webhook id>
X-DeepCRM-Timestamp: <unix seconds>
X-DeepCRM-Signature: sha256=<hex hmac>     HMAC-SHA256(secret, "<timestamp>.<raw body>")

{
  "schema": "deepcrm.webhook.v1",
  "team": "<UOA team id>",
  "organization": "<UOA org id>",
  "since_seq": "1040",
  "until_seq": "1077",
  "backlog_remaining": 0,
  "events": [ { "event": "record.updated", "seq": "1041", ...Change } , ... ]   // ≤ 500, ascending
}
```

Receiver verification: reject if `|now − timestamp| > 300 s`; recompute HMAC over `timestamp + "." + body`; constant-time compare.

### Acknowledgement and retry
- Any `2xx` ⇒ `webhooks.last_delivered_seq = until_seq`.
- Otherwise retry the **same batch** with backoff 1 m, 5 m, 30 m, 2 h, 12 h (five attempts); then `active = false`, `last_error` set, and a `schema.changed`-style marker is **not** emitted (no event about events). `crm_webhook_list` shows `active:false` + `last_error`; re-enable with `crm_webhook_set { active: true }` which resumes from `last_delivered_seq`.
- Ordering guarantee: per webhook, batches are delivered in `seq` order and never overlap (the job takes the webhook advisory lock, namespace 4).
- Catch-up throttle: at most 10 batches (5,000 events) per job run; a long backlog resumes on the next scheduled run, and the envelope's `backlog_remaining` tells the receiver how far behind it is (review m13).
- Receivers MUST dedupe on `(webhook id, until_seq)` and reject `until_seq ≤` the last one seen (review S7.3).

## 4. Delivery adapters (design seam)

`worker/src/deliver/targets/*.ts` implement:

```ts
interface DeliveryTarget {
  kind: 'webhook' | 'matrix_room' | 'nessie_integration'
  deliver(batch: EventBatch, target: TargetConfig): Promise<{ ok: true } | { ok: false; retryable: boolean; error: string }>
}
```

- `webhook` — §3. Ships in v1.
- `nessie_integration` — same envelope posted to Nessie's `POST /api/integrations/deepcrm/events` with Nessie's per-org HMAC secret (see `nessie-integration.md`). v1 uses the generic webhook target with that URL; a dedicated kind exists only if Nessie needs a different envelope.
- `matrix_room` — **not built in v1** (brief §3.5 / §9 Q11). Contract when built: target `{ homeserver, room_id, access_token_ref }`; one `m.room.message` per batch with `msgtype: "m.notice"`, `body` = human summary ("3 deals moved, 2 people added"), and `content["live.deepcrm.events"] = envelope` so agents in the room read the structured payload; `seq` carried in the event for idempotent replay. Uses the same retry table.

## 5. Nessie consumption pattern (reference)

Nessie treats the webhook as *delivery-shaped* (its DeepSignal precedent): coalesce a team's batches into one rolling "N CRM changes" digest message per channel bound to DeepCRM, updated in place within a window; per-event ids retained for idempotency. Agents that need to *act* on changes use the pull tool on a schedule with the cursor stored in trigger state — push is for humans' awareness, pull is for agent work.
