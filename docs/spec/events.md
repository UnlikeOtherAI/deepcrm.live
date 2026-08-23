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
| `link` | `link.created` |
| `unlink` | `link.ended` |
| schema mutation (no record) | `schema.changed` — emitted from a synthetic change row with `record = null`, `attribute` = affected slug, `new_value = { object_type, schema_version }` |

`seq` (bigint autoincrement) is the cursor and ordering key across all consumers. Redaction: events about `restricted` attributes carry no `old_value`/`new_value` unless the consumer's principal may view them; webhooks are evaluated as `role:admin`.

## 2. Pull — `crm_changes_since`

- `cursor` = decimal string of the last `seq` seen; omit ⇒ from the oldest retained row.
- Returns up to `limit` events with `seq > cursor`, ascending, filtered by `object_types`/`kinds`; `next_cursor` = last `seq` returned (or the input cursor when empty); `has_more`.
- Retention: `record_changes` are never deleted, so a cursor never expires. Consumers store the cursor (Nessie: on the trigger's state).

## 3. Push — webhooks

### Registration
`crm_webhook_set { url, events[], active }` — `url` must be `https://`, public host (SSRF guard). Secret: 32 random bytes, hex; returned once; stored sealed (AES-256-GCM keyring).

### Delivery
Worker job `change.deliver` per team, triggered by the write path (debounced: `visibleAt = now + 30 s`, idempotency `deliver:<teamId>:<floor(now/30s)>`).

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
  "events": [ { "event": "record.updated", "seq": "1041", ...Change } , ... ]   // ≤ 500, ascending
}
```

Receiver verification: reject if `|now − timestamp| > 300 s`; recompute HMAC over `timestamp + "." + body`; constant-time compare.

### Acknowledgement and retry
- Any `2xx` ⇒ `webhooks.last_delivered_seq = until_seq`.
- Otherwise retry the **same batch** with backoff 1 m, 5 m, 30 m, 2 h, 12 h (five attempts); then `active = false`, `last_error` set, and a `schema.changed`-style marker is **not** emitted (no event about events). `crm_webhook_list` shows `active:false` + `last_error`; re-enable with `crm_webhook_set { active: true }` which resumes from `last_delivered_seq`.
- Ordering guarantee: per webhook, batches are delivered in `seq` order and never overlap (the job takes `pg_advisory_xact_lock(hashtext('webhook:'||id))`).

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
