export {
  loadSchema,
  type LoadedAttribute,
  type LoadedList,
  type LoadedMatchingRule,
  loadSchemaForMatchingBootstrap,
  type LoadedObjectType,
  type LoadedRelationType,
  type LoadedSchema,
  type LoadedView,
} from './load.js'
export type { RecordTx, SchemaTx } from './tx.js'
export {
  archiveAttribute, archiveObjectType, archiveRelationType, cancelMatchingRules, defineAttribute,
  defineObjectType, defineObjectTypeWithAttributes, defineRelationType, finalizeMatchingBackfill,
  finalizeMatchingBootstrap,
  retryMatchingRules,
  setMatchingRules, updateAttribute, updateObjectType, updateRelationType,
} from './mutate.js'
export { archiveAttributeGroup, defineAttributeGroup, reorderAttributeGroups } from './attribute-groups.js'
export { defineDerivedAttribute, updateDerivedAttribute } from './derived-attributes.js'
export type {
  MatchingAuditMetadata, MatchingBackfillFinalResult, MatchingBackfillIdentity,
  MatchingBackfillRequest, MatchingProvenance,
  MatchingRuleActivation, MatchingRulesSetInput,
  MatchingRuleInput, SetMatchingRulesResult,
} from './matching-rules.js'
export { applyTemplate, applyTemplateBatch, listTemplates, TemplateSchema, type TemplateAdded } from '../templates/index.js'
