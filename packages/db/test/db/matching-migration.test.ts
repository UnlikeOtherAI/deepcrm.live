import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { createDb } from '../../src/index.js'

const execFile = promisify(execFileCallback)
const url = process.env.DATABASE_URL
const describeDb = url === undefined ? describe.skip : describe
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const schemaPath = resolve(repoRoot, 'packages/db/prisma/schema.prisma')
const initMigration = resolve(
  repoRoot, 'packages/db/prisma/migrations/20260823223837_init/migration.sql',
)
const t16Migration = resolve(
  repoRoot, 'packages/db/prisma/migrations/20260824090000_matching_rule_generations/migration.sql',
)

function safeDatabaseName(): string {
  return `deepcrm_t16_${randomUUID().replaceAll('-', '')}`
}

function quotedDatabase(name: string): string {
  if (!/^deepcrm_t16_[0-9a-f]{32}$/u.test(name)) throw new Error('Unsafe temporary database name')
  return `"${name}"`
}

function databaseUrl(base: string, name: string): string {
  const parsed = new URL(base)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

async function withDatabase(base: string, callback: (database: string) => Promise<void>): Promise<void> {
  const name = safeDatabaseName()
  const admin = createDb(databaseUrl(base, 'postgres'))
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE ${quotedDatabase(name)}`)
    await callback(databaseUrl(base, name))
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quotedDatabase(name)} WITH (FORCE)`)
    await admin.$disconnect()
  }
}

async function runPrisma(database: string, args: readonly string[]): Promise<void> {
  const command = ['-C', 'packages/db', 'exec', 'prisma', ...args]
  try {
    await execFile('pnpm', command, {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: database },
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    const output = commandOutput(error, database)
    throw new Error(
      `Prisma command failed: pnpm ${command.join(' ')} (cwd: ${repoRoot})${output}`,
      { cause: error },
    )
  }
}

function commandOutput(error: unknown, database: string): string {
  if (typeof error !== 'object' || error === null) return ''
  const candidate = error as { stdout?: unknown; stderr?: unknown }
  const values = [candidate.stdout, candidate.stderr]
    .filter((value): value is string | Buffer => typeof value === 'string' || Buffer.isBuffer(value))
    .map((value) => value.toString().replaceAll(database, '[DATABASE_URL]').trim())
    .filter((value) => value.length > 0)
  if (values.length === 0) return ''
  return `\n${values.join('\n').slice(0, 12_000)}`
}

async function executeSql(database: string, label: string, sql: string): Promise<void> {
  const directory = await mkdtemp(resolve(tmpdir(), 'deepcrm-t16-migration-'))
  const path = resolve(directory, `${label}.sql`)
  try {
    await writeFile(path, sql, 'utf8')
    await runPrisma(database, ['db', 'execute', '--schema', schemaPath, '--file', path])
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

type LegacySeed = {
  organizationId: string
  teamId: string
  objectTypeId: string
  recordId: string
  ruleId: string
  keyId: string
}

function createLegacySeed(): LegacySeed {
  return {
    organizationId: randomUUID(), teamId: randomUUID(), objectTypeId: randomUUID(),
    recordId: randomUUID(), ruleId: randomUUID(), keyId: randomUUID(),
  }
}

function legacySeedSql(
  seed: LegacySeed,
  action: 'block' | 'allow' = 'block',
  duplicatePosition = false,
  orphanKey = false,
): string {
  const secondRule = randomUUID()
  const keyObjectType = orphanKey ? randomUUID() : seed.objectTypeId
  return `
    INSERT INTO organizations (id, external_org_id, name, updated_at)
    VALUES ('${seed.organizationId}', 'org_t16', 'T16', CURRENT_TIMESTAMP);
    INSERT INTO teams (id, organization_id, external_team_id, name, updated_at)
    VALUES ('${seed.teamId}', '${seed.organizationId}', 'tm_t16', 'T16', CURRENT_TIMESTAMP);
    INSERT INTO object_types (
      id, organization_id, team_id, slug, singular_name, plural_name, description,
      kind, created_by_type, created_by_id, updated_at
    ) VALUES (
      '${seed.objectTypeId}', '${seed.organizationId}', '${seed.teamId}', 'person', 'Person', 'People', 'T16',
      'custom'::"ObjectTypeKind", 'system'::"ActorType", 't16', CURRENT_TIMESTAMP
    );
    INSERT INTO records (
      id, organization_id, team_id, object_type_id, data, display_name, created_by_type, created_by_id, updated_at
    ) VALUES (
      '${seed.recordId}', '${seed.organizationId}', '${seed.teamId}', '${seed.objectTypeId}',
      '{"email":"ada@example.test"}', 'Ada', 'system'::"ActorType", 't16', CURRENT_TIMESTAMP
    );
    INSERT INTO matching_rules (
      id, organization_id, team_id, object_type_id, position, attribute_slugs, method, action
    ) VALUES (
      '${seed.ruleId}', '${seed.organizationId}', '${seed.teamId}', '${seed.objectTypeId}', 0,
      ARRAY['email'], 'normalized'::"MatchMethod", '${action}'::"MatchAction"
    );
    ${duplicatePosition ? `
      INSERT INTO matching_rules (
        id, organization_id, team_id, object_type_id, position, attribute_slugs, method, action
      ) VALUES (
        '${secondRule}', '${seed.organizationId}', '${seed.teamId}', '${seed.objectTypeId}', 0,
        ARRAY['email'], 'normalized'::"MatchMethod", 'block'::"MatchAction"
      );
    ` : ''}
    INSERT INTO record_match_keys (
      id, organization_id, team_id, object_type_id, rule_position, normalized_hash, record_id
    ) VALUES (
      '${seed.keyId}', '${seed.organizationId}', '${seed.teamId}', '${keyObjectType}', 0, 'legacy-hash', '${seed.recordId}'
    );
  `
}

async function installLegacy(
  database: string,
  seed: LegacySeed,
  action?: 'block' | 'allow',
  duplicate = false,
  orphan = false,
): Promise<void> {
  await runPrisma(database, ['db', 'execute', '--schema', schemaPath, '--file', initMigration])
  await executeSql(database, 'legacy-seed', legacySeedSql(seed, action, duplicate, orphan))
}

async function expectMigrationFailure(database: string, pattern: RegExp): Promise<void> {
  await expect(runPrisma(database, [
    'db', 'execute', '--schema', schemaPath, '--file', t16Migration,
  ])).rejects.toThrow(pattern)
}

describeDb('T16 matching migration', () => {
  it('fresh deploy creates the exact generation and key authority catalog', async () => {
    await withDatabase(url ?? '', async (database) => {
      await runPrisma(database, ['migrate', 'deploy', '--schema', schemaPath])
      const db = createDb(database)
      try {
        const [indexes, labels, constraints] = await Promise.all([
          db.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
          SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename IN ('matching_rule_generations', 'record_match_keys', 'record_match_lookup_keys')
          `,
          db.$queryRaw<Array<{ label: string }>>`
          SELECT unnest(enum_range(NULL::"MatchAction"))::text AS label
          `,
          db.$queryRaw<Array<{ conname: string }>>`
          SELECT conname FROM pg_constraint
          WHERE conname IN (
            'matching_rules_generation_id_fkey',
            'record_match_keys_matching_rule_id_fkey',
            'record_match_lookup_keys_matching_rule_id_fkey',
            'record_match_lookup_keys_record_id_fkey'
          )
          `,
        ])
        const names = new Set(indexes.map((index) => index.indexname))
        for (const name of [
          'matching_rule_generations_one_active',
          'matching_rule_generations_one_replacement',
          'record_match_keys_matching_rule_id_normalized_hash_key',
        ]) expect(names.has(name)).toBe(true)
        expect(indexes.some((index) => (
          index.indexdef.includes('UNIQUE INDEX')
          && index.indexdef.includes('(matching_rule_id, normalized_hash, record_id)')
        ))).toBe(true)
        expect(indexes.find((index) => index.indexname === 'matching_rule_generations_one_active')?.indexdef)
          .toContain("WHERE (state = 'active'::\"MatchingRuleGenerationState\")")
        expect(indexes.find((index) => index.indexname === 'matching_rule_generations_one_replacement')?.indexdef)
          .toContain('WHERE (state = ANY')
        expect(labels.map((row) => row.label)).toEqual(['block', 'warn'])
        expect(constraints.map((row) => row.conname).sort()).toEqual([
          'matching_rules_generation_id_fkey',
          'record_match_keys_matching_rule_id_fkey',
          'record_match_lookup_keys_matching_rule_id_fkey',
          'record_match_lookup_keys_record_id_fkey',
        ])
      } finally {
        await db.$disconnect()
      }
    })
  }, 30_000)

  it('upgrades legacy rows, preserves keys, and cascades the authority graph', async () => {
    await withDatabase(url ?? '', async (database) => {
      const seed = createLegacySeed()
      await installLegacy(database, seed)
      await runPrisma(database, ['db', 'execute', '--schema', schemaPath, '--file', t16Migration])
      const db = createDb(database)
      try {
        const [rows, orphans] = await Promise.all([
        db.$queryRaw<Array<{ generation_id: string; matching_rule_id: string; lookup_count: bigint }>>`
          SELECT r.generation_id, k.matching_rule_id,
            (SELECT count(*)::bigint FROM record_match_lookup_keys l WHERE l.matching_rule_id = r.id) AS lookup_count
          FROM matching_rules r
          JOIN record_match_keys k ON k.matching_rule_id = r.id
          WHERE r.id = ${seed.ruleId}::uuid AND k.id = ${seed.keyId}::uuid
        `,
        db.$queryRaw<Array<{ count: bigint }>>`
          SELECT (
            (SELECT count(*) FROM matching_rules r LEFT JOIN matching_rule_generations g ON g.id = r.generation_id WHERE g.id IS NULL)
            + (SELECT count(*) FROM record_match_keys k LEFT JOIN matching_rules r ON r.id = k.matching_rule_id WHERE r.id IS NULL)
            + (SELECT count(*) FROM record_match_lookup_keys l LEFT JOIN matching_rules r ON r.id = l.matching_rule_id WHERE r.id IS NULL)
          )::bigint AS count
        `,
        ])
        expect(rows).toEqual([{ generation_id: expect.any(String), matching_rule_id: seed.ruleId, lookup_count: 1n }])
        expect(orphans[0]?.count).toBe(0n)
        const generationId = rows[0]?.generation_id
        if (generationId === undefined) throw new Error('Missing migrated generation')
        await db.$executeRaw`DELETE FROM matching_rule_generations WHERE id = ${generationId}::uuid`
        const descendants = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT (
          (SELECT count(*) FROM matching_rules WHERE id = ${seed.ruleId}::uuid)
          + (SELECT count(*) FROM record_match_keys WHERE id = ${seed.keyId}::uuid)
          + (SELECT count(*) FROM record_match_lookup_keys WHERE record_id = ${seed.recordId}::uuid)
        )::bigint AS count
      `
        expect(descendants[0]?.count).toBe(0n)
      } finally {
        await db.$disconnect()
      }
    })
  }, 30_000)

  it('refuses legacy allow actions, duplicate positions, and orphan positional keys', async () => {
    const cases: Array<{ action?: 'allow'; duplicate?: boolean; orphan?: boolean; pattern: RegExp }> = [
      { action: 'allow', pattern: /action=allow/u },
      { duplicate: true, pattern: /duplicate matching rule positions/u },
      { orphan: true, pattern: /without their positional matching rule/u },
    ]
    for (const scenario of cases) {
      await withDatabase(url ?? '', async (database) => {
        await installLegacy(database, createLegacySeed(), scenario.action, scenario.duplicate, scenario.orphan)
        await expectMigrationFailure(database, scenario.pattern)
      })
    }
  }, 30_000)
})
