import {
  ensureConsentAttributes,
  ensureSourceAttributes,
  hasConsentAttributes,
  holdsSourceAttributes,
  loadSchema,
  type LoadedAttribute,
  type LoadedObjectType,
  type LoadedSchema,
} from '@deepcrm/schema-engine'
import { ErrorCode, onBehalfOfUserId, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import {
  CONSENT_SCHEMA_ACTOR_ID, consentTarget, selectConsentObjectType, type ConsentTarget,
} from './consent-target.js'

/**
 * What a submission is written to (schema-engine §4d″): the person-kind type
 * with its unique email and its one phone attribute, the consent attributes
 * when the submission carries consent, and the `activity` type.
 */
export type IntakeTarget = {
  schema: LoadedSchema
  objectType: LoadedObjectType
  email: LoadedAttribute
  /** The type's one phone attribute when the submission gives a phone; null when it gives none. */
  phone: LoadedAttribute | null
  consent: ConsentTarget | null
  activity: LoadedObjectType
}

// The source attributes are system metadata, defined by the system on the
// first call that names a source rather than by the caller.
export const SOURCE_SCHEMA_ACTOR_ID = 'source'

function activityType(schema: LoadedSchema): LoadedObjectType {
  const found = schema.objectTypesBySlug.get('activity')
  if (found === undefined) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type', { slug: 'activity' })
  return found
}

function phoneAttribute(objectType: LoadedObjectType): LoadedAttribute {
  const phones = objectType.attributes.filter((attribute) => (
    attribute.type === 'phone' && attribute.valueSource === 'stored'
  ))
  const [only, second] = phones
  if (only === undefined || second !== undefined) {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Phone attribute is ambiguous', {
      issues: [{ path: '/phone', message: 'the object type needs exactly one phone attribute to take a phone' }],
    })
  }
  return only
}

function needsEnsure(objectType: LoadedObjectType, activity: LoadedObjectType, consent: boolean): boolean {
  const consentMissing = consent && !hasConsentAttributes(new Set(objectType.attributes.map((item) => item.slug)))
  const firstSourceMissing = !holdsSourceAttributes(objectType, 'first_source')
  const activitySourceMissing = !holdsSourceAttributes(activity, 'activity_source')
  return consentMissing || firstSourceMissing || activitySourceMissing
}

export type IntakeNeeds = { objectType: string | undefined; consent: boolean; phone: boolean }

function build(schema: LoadedSchema, objectType: LoadedObjectType, needs: IntakeNeeds): IntakeTarget {
  const email = objectType.attributes.find((attribute) => attribute.type === 'email' && attribute.isUnique)
  if (email === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Intake object type changed')
  return {
    schema,
    objectType,
    email,
    phone: needs.phone ? phoneAttribute(objectType) : null,
    consent: needs.consent ? consentTarget(schema, objectType) : null,
    activity: activityType(schema),
  }
}

/**
 * Resolves the person-kind type a subject's submission lands on and makes
 * sure it and `activity` hold the source attributes (and the consent ones
 * when consent is given), defining them for an older tenant in one
 * transaction first. A same-slug attribute that cannot hold them is
 * `SCHEMA_CONFLICT`; only calls that name a source depend on them.
 */
export async function resolveIntakeTarget(
  deps: AppDeps, ctx: ActorContext, needs: IntakeNeeds,
): Promise<IntakeTarget> {
  const schema = await loadSchema(deps.db, ctx.tenant)
  const objectType = selectConsentObjectType(schema, needs.objectType, true)
  if (!needsEnsure(objectType, activityType(schema), needs.consent)) return build(schema, objectType, needs)
  const actor = (id: string) => ({ type: 'system' as const, id, onBehalfOf: onBehalfOfUserId(ctx), requestId: ctx.requestId })
  await deps.db.$transaction(async (tx) => {
    if (needs.consent) await ensureConsentAttributes(tx, ctx.tenant, actor(CONSENT_SCHEMA_ACTOR_ID), objectType.slug)
    await ensureSourceAttributes(tx, ctx.tenant, actor(SOURCE_SCHEMA_ACTOR_ID), objectType.slug, 'first_source')
    await ensureSourceAttributes(tx, ctx.tenant, actor(SOURCE_SCHEMA_ACTOR_ID), 'activity', 'activity_source')
  })
  const upgraded = await loadSchema(deps.db, ctx.tenant, { useCache: false })
  const reloaded = upgraded.objectTypesBySlug.get(objectType.slug)
  if (reloaded === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Intake object type changed')
  return build(upgraded, reloaded, needs)
}
