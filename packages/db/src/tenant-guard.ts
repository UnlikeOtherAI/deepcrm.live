import type { PrismaClient } from '@prisma/client'

// Runtime backstop for the tenancy rule (docs/auth-and-tenancy.md §3, review
// S1.5): reads and bulk mutations against a tenant-scoped CRM model must
// carry both tenant columns in their where. The static half is
// scripts/lint-tenant-where.mjs; this extension mirrors the same model list
// and the same operation list (findMany/findFirst/findUnique/count/aggregate/
// updateMany/deleteMany). Single-row writes and reads by unique key are
// keyed through caller-validated ids and stay outside this guard. Seed
// helpers run under NODE_ENV=test and bypass via DEEPCRM_TENANT_GUARD=off.
// Raw SQL is outside this boundary by construction — it is composed by
// searchQuery() with tenantWhere baked in.
const CRM_MODELS = new Set([
  'Record',
  'RecordLink',
  'RecordChange',
  'RecordUniqueKey',
  'RecordMatchKey',
  'RecordMatchLookupKey',
  'RecordSearch',
  'ObjectType',
  'Attribute',
  'RelationType',
  'MatchingRule',
  'MatchingRuleGeneration',
  'List',
  'ListEntry',
  'View',
  'PolicyRule',
  'PolicyBinding',
  'ApprovalRequest',
  'Webhook',
  'IdempotencyReplay',
])

const GUARDED_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findUnique',
  'count',
  'aggregate',
  'updateMany',
  'deleteMany',
])

function tenantGuardOff(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.DEEPCRM_TENANT_GUARD === 'off'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function whereHasTenant(where: unknown): boolean {
  if (!isPlainObject(where)) return false
  return (
    Object.prototype.hasOwnProperty.call(where, 'organizationId') &&
    Object.prototype.hasOwnProperty.call(where, 'teamId') &&
    typeof where.organizationId !== 'undefined' &&
    typeof where.teamId !== 'undefined'
  )
}

export function withTenantGuard(db: PrismaClient) {
  return db.$extends({
    name: 'tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (
            CRM_MODELS.has(model) &&
            GUARDED_OPERATIONS.has(operation) &&
            !tenantGuardOff()
          ) {
            const loose: unknown = args
            const candidate: unknown = isPlainObject(loose) ? loose['where'] : undefined
            if (!whereHasTenant(candidate)) {
              throw new Error(
                `TENANT_GUARD: ${model}.${operation} requires organizationId and teamId in where`,
              )
            }
          }
          return query(args)
        },
      },
    },
  })
}
