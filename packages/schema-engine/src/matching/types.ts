import type { ActorContext } from '@deepcrm/schemas'

import type { JsonValue } from '../records/json.js'

export type MatchTuple = readonly JsonValue[]

export type MatchEvidenceFact = Readonly<{
  attribute: string
  kind: 'exact' | 'normalized' | 'fuzzy'
  value: JsonValue | null
  score: number | null
}>

export type MatchCandidateFact = Readonly<{
  recordId: string
  objectTypeId: string
  ruleId: string
  rulePosition: number
  evidence: readonly MatchEvidenceFact[]
}>

export type FindMatchesInput = Readonly<{ objectTypeId: string; recordId: string }>
export type MatchingContext = Pick<ActorContext, 'tenant' | 'now'>
