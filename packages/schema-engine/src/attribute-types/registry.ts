import type { AttributeType } from '@deepcrm/db'

import { actorReference } from './actor-reference.js'
import { boolean } from './boolean.js'
import { currency } from './currency.js'
import { date } from './date.js'
import { datetime } from './datetime.js'
import { domain } from './domain.js'
import { email } from './email.js'
import { json } from './json.js'
import { location } from './location.js'
import { number } from './number.js'
import { percent } from './percent.js'
import { personalName } from './personal-name.js'
import { phone } from './phone.js'
import { rating } from './rating.js'
import { recordReference } from './record-reference.js'
import { registryId } from './registry-id.js'
import { richText } from './rich-text.js'
import { select } from './select.js'
import { status } from './status.js'
import { text } from './text.js'
import { timestampSystem } from './timestamp-system.js'
import { type AttributeTypeDef, type ExampleValue } from './types.js'
import { url } from './url.js'

export const attributeTypes: Record<AttributeType, AttributeTypeDef> = {
  text,
  rich_text: richText,
  number,
  currency,
  percent,
  boolean,
  date,
  datetime,
  select,
  status,
  rating,
  email,
  phone,
  url,
  domain,
  registry_id: registryId,
  location,
  personal_name: personalName,
  actor_reference: actorReference,
  record_reference: recordReference,
  timestamp_system: timestampSystem,
  json,
}

export function getAttributeType(type: AttributeType): AttributeTypeDef {
  const definition = attributeTypes[type]
  if (definition === undefined) throw new Error(`Unknown attribute type: ${type}`)
  return definition
}

export type ExampleTarget = { type: AttributeType; config: unknown; isMulti: boolean }

/**
 * One value an agent can write to this attribute — wrapped in an array for a multi attribute —
 * proven against the type's own `valueSchema` first. Undefined only when the stored config admits
 * no value (every option archived, an unsatisfiable range or JSON Schema) or does not parse.
 */
export function attributeExample(attribute: ExampleTarget): ExampleValue | undefined {
  const definition = getAttributeType(attribute.type)
  try {
    const example = definition.example(attribute.config)
    if (!definition.valueSchema(attribute.config).safeParse(example).success) return undefined
    return attribute.isMulti ? [example] : example
  } catch {
    return undefined
  }
}
