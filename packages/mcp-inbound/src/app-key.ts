import { createHash, timingSafeEqual } from 'node:crypto'
import type { JWTVerifyGetKey } from 'jose'
import { z } from 'zod'

const Sha256HexSchema = z.string().regex(/^[a-fA-F0-9]{64}$/).transform((value) => value.toLowerCase())

const AppRegistrationInputSchema = z.object({
  keyHashes: z.array(Sha256HexSchema).min(1),
  contextJwksUrl: z.string().url(),
  contextIssuer: z.string().min(1),
  sourceDomain: z.string().min(1),
  product: z.string().min(1),
}).strict()

const AppRegistryInputSchema = z.record(z.string().min(1), AppRegistrationInputSchema)

export type AppRegistration = z.infer<typeof AppRegistrationInputSchema> & {
  contextJwks?: JWTVerifyGetKey
}

export type AppRegistry = ReadonlyMap<string, AppRegistration>

export function parseAppRegistry(env: string): Map<string, AppRegistration> {
  const parsed: unknown = JSON.parse(env)
  const input = AppRegistryInputSchema.parse(parsed)
  const registry = new Map<string, AppRegistration>()
  const owners = new Map<string, string>()

  for (const [name, registration] of Object.entries(input)) {
    for (const hash of registration.keyHashes) {
      const owner = owners.get(hash)
      if (owner !== undefined) throw new Error(`App key hash is assigned to both ${owner} and ${name}`)
      owners.set(hash, name)
    }
    registry.set(name, registration)
  }
  return registry
}

export function parseAppKeys(env: string): Map<string, string> {
  const keys = new Map<string, string>()
  for (const [name, registration] of parseAppRegistry(env)) {
    for (const hash of registration.keyHashes) keys.set(hash, name)
  }
  return keys
}

export function appKeys(registry: AppRegistry): Map<string, string> {
  const keys = new Map<string, string>()
  for (const [name, registration] of registry) {
    for (const hash of registration.keyHashes) keys.set(Sha256HexSchema.parse(hash), name)
  }
  return keys
}

export function verifyAppKey(keys: ReadonlyMap<string, string>, bearer: string): string | null {
  const candidate = createHash('sha256').update(bearer, 'utf8').digest()
  let matched: string | null = null

  for (const [hash, name] of keys) {
    const known = Buffer.from(Sha256HexSchema.parse(hash), 'hex')
    if (known.length === candidate.length && timingSafeEqual(known, candidate)) matched = name
  }
  return matched
}
