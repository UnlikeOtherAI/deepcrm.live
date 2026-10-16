import {
  CONSENT_ATTRIBUTE_SLUGS,
  ensureConsentAttributes,
  getAttributeType,
  hasConsentAttributes,
  keyHash,
  loadSchema,
  normalizedAttributeValue,
  type LoadedAttribute,
  type LoadedObjectType,
  type LoadedSchema,
} from '@deepcrm/schema-engine'
import { ErrorCode, onBehalfOfUserId, ServiceError, type ActorContext } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'

/** The person-kind object type consent is read and written on, with its four attributes. */
export type ConsentTarget = {
  schema: LoadedSchema
  objectType: LoadedObjectType
  email: LoadedAttribute
  state: LoadedAttribute
  at: LoadedAttribute
  source: LoadedAttribute
}

// The consent attributes are system metadata, defined by the system on the
// first consent call a tenant makes rather than by the caller.
const CONSENT_SCHEMA_ACTOR_ID = 'consent'

function uniqueEmailAttributes(objectType: LoadedObjectType): LoadedAttribute[] {
  return objectType.attributes.filter((attribute) => (
    attribute.archivedAt === null && attribute.type === 'email' && attribute.isUnique
  ))
}

function isPersonKind(objectType: LoadedObjectType): boolean {
  const primary = objectType.attributes.find((attribute) => attribute.id === objectType.primaryAttributeId)
  return primary?.type === 'personal_name' && uniqueEmailAttributes(objectType).length === 1
}

function invalidObjectType(message: string): ServiceError {
  return new ServiceError(ErrorCode.VALIDATION_FAILED, 'Consent object type is invalid', {
    issues: [{ path: '/object_type', message }],
  })
}

function selectObjectType(schema: LoadedSchema, slug: string | undefined): LoadedObjectType {
  if (slug !== undefined) {
    const named = schema.objectTypesBySlug.get(slug)
    if (named === undefined) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type', { slug })
    if (uniqueEmailAttributes(named).length !== 1) {
      throw invalidObjectType('the object type needs exactly one unique email attribute')
    }
    return named
  }
  const candidates = schema.objectTypes.filter(isPersonKind)
  const [only, second] = candidates
  if (only === undefined) {
    throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'No person-kind object type exists in this workspace')
  }
  if (second !== undefined) {
    const slugs = candidates.map((candidate) => candidate.slug).sort().join(', ')
    throw invalidObjectType(`more than one person-kind object type (${slugs}); name one in object_type`)
  }
  return only
}

function attribute(objectType: LoadedObjectType, slug: string): LoadedAttribute {
  const found = objectType.attributes.find((candidate) => candidate.slug === slug && candidate.archivedAt === null)
  if (found === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Consent attributes are missing')
  return found
}

function target(schema: LoadedSchema, objectType: LoadedObjectType): ConsentTarget {
  const [email] = uniqueEmailAttributes(objectType)
  if (email === undefined) throw invalidObjectType('the object type needs exactly one unique email attribute')
  return {
    schema,
    objectType,
    email,
    state: attribute(objectType, CONSENT_ATTRIBUTE_SLUGS.state),
    at: attribute(objectType, CONSENT_ATTRIBUTE_SLUGS.at),
    source: attribute(objectType, CONSENT_ATTRIBUTE_SLUGS.source),
  }
}

/**
 * Resolves the person-kind object type (named, or the tenant's one type whose
 * primary is a `personal_name` with a unique email) and makes sure it holds
 * the three consent attributes, defining them for an older tenant first.
 */
export async function resolveConsentTarget(
  deps: AppDeps,
  ctx: ActorContext,
  objectTypeSlug: string | undefined,
): Promise<ConsentTarget> {
  const schema = await loadSchema(deps.db, ctx.tenant)
  const objectType = selectObjectType(schema, objectTypeSlug)
  if (hasConsentAttributes(new Set(objectType.attributes.map((item) => item.slug)))) {
    return target(schema, objectType)
  }
  await deps.db.$transaction((tx) => ensureConsentAttributes(tx, ctx.tenant, {
    type: 'system', id: CONSENT_SCHEMA_ACTOR_ID, onBehalfOf: onBehalfOfUserId(ctx), requestId: ctx.requestId,
  }, objectType.slug))
  const upgraded = await loadSchema(deps.db, ctx.tenant, { useCache: false })
  const reloaded = upgraded.objectTypesBySlug.get(objectType.slug)
  if (reloaded === undefined) throw new ServiceError(ErrorCode.SCHEMA_CONFLICT, 'Consent object type changed')
  return target(upgraded, reloaded)
}

/** The email as the attribute's normaliser stores it, and its unique-key hash. */
export function normalizedEmail(consent: ConsentTarget, email: string): { value: string; hash: string } {
  try {
    const value = normalizedAttributeValue(consent.email, email)
    return { value, hash: keyHash(value) }
  } catch {
    throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Email is invalid', {
      issues: [{
        path: '/email', message: 'must be an RFC 5322 email address', type: 'email',
        expected: getAttributeType('email').example(consent.email.config),
      }],
    })
  }
}
