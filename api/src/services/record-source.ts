import {
  ensureSourceAttributes, FIRST_SOURCE_ATTRIBUTE_SLUGS, holdsSourceAttributes, loadSchema,
} from '@deepcrm/schema-engine'
import { ErrorCode, onBehalfOfUserId, ServiceError, type ActorContext, type SourceRef } from '@deepcrm/schemas'

import type { AppDeps } from '../deps.js'
import { SOURCE_SCHEMA_ACTOR_ID } from './intake-target.js'

/**
 * The data of a record a person creates with a named source (schema-engine
 * §4d″): the caller's data plus the three first-source values, after making
 * sure the type holds those system attributes (defined by the system actor
 * `source` for an older tenant). `data` may not set them itself.
 */
export async function withFirstSource(
  deps: AppDeps, ctx: ActorContext, objectTypeSlug: string, data: Record<string, unknown>, source: SourceRef,
): Promise<Record<string, unknown>> {
  for (const slug of Object.values(FIRST_SOURCE_ATTRIBUTE_SLUGS)) {
    if (Object.hasOwn(data, slug)) {
      throw new ServiceError(ErrorCode.VALIDATION_FAILED, 'Record data is invalid', {
        issues: [{ path: `/data/${slug}`, message: 'the first source is set by source' }],
      })
    }
  }
  const schema = await loadSchema(deps.db, ctx.tenant)
  const objectType = schema.objectTypesBySlug.get(objectTypeSlug)
  if (objectType === undefined) throw new ServiceError(ErrorCode.UNKNOWN_OBJECT_TYPE, 'Unknown object type')
  if (!holdsSourceAttributes(objectType, 'first_source')) {
    await deps.db.$transaction((tx) => ensureSourceAttributes(tx, ctx.tenant, {
      type: 'system', id: SOURCE_SCHEMA_ACTOR_ID, onBehalfOf: onBehalfOfUserId(ctx), requestId: ctx.requestId,
    }, objectTypeSlug, 'first_source'))
  }
  return {
    ...data,
    [FIRST_SOURCE_ATTRIBUTE_SLUGS.kind]: source.kind,
    [FIRST_SOURCE_ATTRIBUTE_SLUGS.id]: source.id,
    [FIRST_SOURCE_ATTRIBUTE_SLUGS.name]: source.name,
  }
}
