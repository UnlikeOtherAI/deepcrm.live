import { onBehalfOfUserId, type ActorContext } from '@deepcrm/schemas'

import { writeChangeRows } from '../change-log.js'

import type { RecordTx } from '../schema/tx.js'
import { canonicalJson, type JsonValue } from './json.js'

export type ChangeIntent = {
  recordId: string
  kind: 'create' | 'set' | 'unset' | 'link' | 'unlink' | 'delete' | 'restore' | 'merge' | 'unmerge' | 'erase'
  attributeSlug: string | null
  relationTypeId: string | null
  linkId: string | null
  groupId: string | null
  oldValue: JsonValue | null
  newValue: JsonValue | null
  snapshot: JsonValue | null
  resultingVersion: number
  reason: string | null
}

type DiffInput = Record<string, JsonValue>

export function diffChanges(
  before: DiffInput, after: DiffInput, recordId: string, resultingVersion: number,
): ChangeIntent[] {
  const slugs = new Set([...Object.keys(before), ...Object.keys(after)])
  const changes: ChangeIntent[] = []
  for (const slug of [...slugs].sort()) {
    const oldValue = before[slug]
    const newValue = after[slug]
    if (oldValue === undefined && newValue === undefined) continue
    if (oldValue !== undefined && newValue !== undefined && canonicalJson(oldValue) === canonicalJson(newValue)) {
      continue
    }
    if (newValue === undefined) {
      changes.push({ recordId, kind: 'unset', attributeSlug: slug, relationTypeId: null, linkId: null, groupId: null, oldValue: oldValue ?? null, newValue: null, snapshot: null, resultingVersion, reason: null })
    } else {
      changes.push({ recordId, kind: 'set', attributeSlug: slug, relationTypeId: null, linkId: null, groupId: null, oldValue: oldValue ?? null, newValue, snapshot: null, resultingVersion, reason: null })
    }
  }
  return changes
}

export function createChanges(after: DiffInput, recordId: string): ChangeIntent[] {
  const changes: ChangeIntent[] = [{
    recordId, kind: 'create', attributeSlug: null, relationTypeId: null, linkId: null, groupId: null, oldValue: null, newValue: null, snapshot: null, resultingVersion: 1, reason: null,
  }]
  for (const slug of Object.keys(after).sort()) {
    const value = after[slug]
    if (value === undefined) continue
    changes.push({ recordId, kind: 'set', attributeSlug: slug, relationTypeId: null, linkId: null, groupId: null, oldValue: null, newValue: value, snapshot: null, resultingVersion: 1, reason: null })
  }
  return changes
}

export async function writeChanges(
  tx: RecordTx,
  ctx: ActorContext,
  changes: readonly ChangeIntent[],
): Promise<number[]> {
  return writeChangeRows(tx, {
    tenant: ctx.tenant, actor: ctx.actor, onBehalfOf: onBehalfOfUserId(ctx),
    requestId: ctx.requestId, provenance: ctx.provenance,
  }, changes)
}
