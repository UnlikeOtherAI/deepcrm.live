export {
  matchingTupleHash, matchingTuples, materializeMatchingKeys, materializeMatchingRecordBatch,
  refreshMatchingRecords, removeMatchingKeys, stageMatchingBootstrapBatch, validateMatchingRule,
} from './keys.js'
export { findMatches } from './evaluate.js'
export type { FindMatchesInput, MatchCandidateFact, MatchEvidenceFact, MatchTuple } from './types.js'
