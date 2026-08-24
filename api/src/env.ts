import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

// Repo-root .env loader (dotenv-free per docs/plans/01-scaffold.md T04): the
// worktree lives at <repo>/.worktrees/<task>, two levels below the real repo
// root, and git worktrees never carry the ignored .env. Tries the package
// root first (normal checkout), then the enclosing repo root (worktree).
// Sets only unset keys — the real environment always wins.
function loadRepoRootEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(process.cwd(), '../../../.env'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const content = readFileSync(candidate, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      if (process.env[key] !== undefined) continue
      let value = trimmed.slice(eq + 1).trim()
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1)
      }
      process.env[key] = value
    }
    return
  }
}

loadRepoRootEnv()

const boolish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value === '' ? undefined : value))

// docs/architecture.md §6 — every row of the environment table.
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DEEPCRM_API_PORT: z.coerce.number().int().positive().default(5656),
  DEEPCRM_API_PUBLIC_URL: z.string().url().default('http://localhost:5656'),
  DATABASE_URL: z.string().min(1),
  DEEPCRM_PROCESS_MODE: z.enum(['api', 'worker', 'all']).default('all'),
  REQUIRE_AUTH: boolish.optional(),
  DEEPCRM_APPS: optionalString,
  UOA_BASE_URL: z.string().url().default('https://authentication.unlikeotherai.com'),
  DEEPCRM_DIRECT_CLIENTS: boolish.default('false'),
  DEEPCRM_UOA_CONFIG_PRIVATE_KEY_B64: optionalString,
  DEEPCRM_UOA_CLIENT_SECRET: optionalString,
  DEEPCRM_SECRET_KEYRING_B64: z.string().min(1),
  LEDGER_PUBLIC_URL: optionalString,
  LEDGER_PROXY_TOKEN: optionalString,
  DEEPCRM_EMBEDDING_MODEL: z.string().min(1).default('jina-embeddings-v3'),
  DEEPCRM_MAX_BULK_ROWS: z.coerce.number().int().positive().max(10_000).default(10_000),
  DEEPCRM_MAX_BODY_BYTES: z.coerce.number().int().positive().default(10485760),
  DEEPCRM_MAX_EXPORT_ROWS: z.coerce.number().int().positive().default(100000),
  DEEPCRM_EXPORT_DIR: z.string().min(1).default('./.exports'),
  DEEPCRM_ORG_ALLOWLIST: optionalString,
  DEEPCRM_AUDIT_RETENTION_YEARS: z.coerce.number().int().positive().default(7),
  DEEPCRM_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  DEEPCRM_WEBHOOK_PRINCIPAL_STALE_DAYS: z.coerce.number().int().positive().default(30),
  DEEPCRM_ACTOR_STALE_DAYS: z.coerce.number().int().positive().default(60),
  DEEPCRM_TRUSTED_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
})

type ParsedEnv = z.infer<typeof EnvSchema>

export type Env = Omit<ParsedEnv, 'REQUIRE_AUTH'> & { REQUIRE_AUTH: boolean }

// REQUIRE_AUTH defaults per auth-and-tenancy §1: false outside production,
// true when NODE_ENV=production.
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.parse(source)
  return { ...parsed, REQUIRE_AUTH: parsed.REQUIRE_AUTH ?? parsed.NODE_ENV === 'production' }
}
