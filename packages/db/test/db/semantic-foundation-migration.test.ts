import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
const dbDir = resolve(repoRoot, 'packages/db')
const migrationsDir = resolve(dbDir, 'prisma/migrations')
const schemaPath = resolve(dbDir, 'prisma/schema.prisma')
const migrationTestTimeout = 90_000
const t57Name = '20260824235600_semantic_metadata_foundation'
const t57Migration = resolve(migrationsDir, t57Name, 'migration.sql')

function databaseUrl(base: string, name: string): string {
  const parsed = new URL(base)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

function safeDatabaseName(): string {
  return `deepcrm_t57_${randomUUID().replaceAll('-', '')}`
}

function quotedDatabase(name: string): string {
  if (!/^deepcrm_t57_[0-9a-f]{32}$/u.test(name)) throw new Error('Unsafe database name')
  return `"${name}"`
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

function commandOutput(error: unknown, database: string): string {
  if (typeof error !== 'object' || error === null) return ''
  const candidate = error as { stdout?: unknown; stderr?: unknown }
  return [candidate.stdout, candidate.stderr]
    .filter((value): value is string | Buffer => typeof value === 'string' || Buffer.isBuffer(value))
    .map((value) => value.toString().replaceAll(database, '[DATABASE_URL]').trim())
    .filter((value) => value.length > 0)
    .join('\n')
}

async function runPrisma(database: string, args: readonly string[]): Promise<void> {
  const command = ['-C', dbDir, 'exec', 'prisma', ...args]
  try {
    await execFile('pnpm', command, {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: database },
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    throw new Error(`Prisma command failed: pnpm ${command.join(' ')}\n${commandOutput(error, database)}`, {
      cause: error,
    })
  }
}

async function deployBeforeT57(database: string): Promise<void> {
  const names = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name < t57Name)
    .sort()
  for (const name of names) {
    await runPrisma(database, ['db', 'execute', '--schema', schemaPath, '--file', resolve(migrationsDir, name, 'migration.sql')])
  }
}

async function executeT57(database: string): Promise<void> {
  await runPrisma(database, ['db', 'execute', '--schema', schemaPath, '--file', t57Migration])
}

async function executeSql(database: string, label: string, sql: string): Promise<void> {
  const directory = await mkdtemp(resolve(tmpdir(), 'deepcrm-t57-migration-'))
  const path = resolve(directory, `${label}.sql`)
  try {
    await writeFile(path, sql, 'utf8')
    await runPrisma(database, ['db', 'execute', '--schema', schemaPath, '--file', path])
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

function seedLegacyTenantSql(statusConfig: string): string {
  const organizationId = randomUUID()
  const teamId = randomUUID()
  const objectTypeId = randomUUID()
  const statusId = randomUUID()
  const relationTypeId = randomUUID()
  const listId = randomUUID()
  return `
    INSERT INTO organizations (id, external_org_id, name, updated_at)
    VALUES ('${organizationId}', 'org_t57', 'T57', CURRENT_TIMESTAMP);
    INSERT INTO teams (id, organization_id, external_team_id, name, updated_at)
    VALUES ('${teamId}', '${organizationId}', 'tm_t57', 'T57', CURRENT_TIMESTAMP);
    INSERT INTO object_types (
      id, organization_id, team_id, slug, singular_name, plural_name, description,
      kind, created_by_type, created_by_id, updated_at
    ) VALUES (
      '${objectTypeId}', '${organizationId}', '${teamId}', 'deal', 'Deal', 'Deals', 'T57',
      'standard'::"ObjectTypeKind", 'system'::"ActorType", 't57', CURRENT_TIMESTAMP
    );
    INSERT INTO attributes (
      id, organization_id, team_id, object_type_id, slug, name, description,
      type, config, created_at, updated_at
    ) VALUES (
      '${statusId}', '${organizationId}', '${teamId}', '${objectTypeId}', 'stage', 'Stage', 'Stage',
      'status'::"AttributeType", '${statusConfig}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO relation_types (
      id, organization_id, team_id, slug, from_object_type_id, to_object_type_id,
      forward_name, inverse_name, cardinality, created_at, updated_at
    ) VALUES (
      '${relationTypeId}', '${organizationId}', '${teamId}', 'deal_parent', '${objectTypeId}', '${objectTypeId}',
      'parent', 'child', 'many_to_many'::"Cardinality", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO lists (
      id, organization_id, team_id, slug, name, object_type_id, created_by_type, created_by_id, updated_at
    ) VALUES (
      '${listId}', '${organizationId}', '${teamId}', 'open_deals', 'Open deals', '${objectTypeId}',
      'system'::"ActorType", 't57', CURRENT_TIMESTAMP
    );
  `
}

describeDb('T57 semantic foundation migration', () => {
  it('fresh deploy creates the generic semantic catalog without template tables', async () => {
    await withDatabase(url ?? '', async (database) => {
      await runPrisma(database, ['migrate', 'deploy', '--schema', schemaPath])
      const db = createDb(database)
      try {
        const [tables, enums, indexes, columns] = await Promise.all([
          db.$queryRaw<Array<{ tablename: string }>>`
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND tablename IN (
              'attribute_groups', 'pipelines', 'pipeline_stages', 'record_stage_history',
              'attribute_derivations', 'attribute_derivation_dependencies', 'file_objects',
              'file_links', 'event_types', 'events', 'migration_reports'
            )
          `,
          db.$queryRaw<Array<{ typname: string; labels: string[] }>>`
            SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
            FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
            WHERE t.typname IN ('AttributeValueSource', 'ListKind', 'FileLinkTargetType')
            GROUP BY t.typname
          `,
          db.$queryRaw<Array<{ indexname: string }>>`
            SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname IN ('pipelines_one_default', 'record_stage_history_one_open')
          `,
          db.$queryRaw<Array<{ table_name: string; column_name: string }>>`
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('attribute_groups', 'pipelines', 'events', 'file_objects')
              AND column_name IN ('organization_id', 'team_id')
          `,
        ])
        expect(tables.map((row) => row.tablename).sort()).toEqual([
          'attribute_derivation_dependencies', 'attribute_derivations', 'attribute_groups',
          'event_types', 'events', 'file_links', 'file_objects', 'migration_reports',
          'pipeline_stages', 'pipelines', 'record_stage_history',
        ])
        expect(enums.find((row) => row.typname === 'AttributeValueSource')?.labels)
          .toEqual(['stored', 'formula', 'rollup', 'relation_sync', 'score', 'system'])
        expect(enums.find((row) => row.typname === 'ListKind')?.labels).toEqual(['static', 'dynamic'])
        expect(enums.find((row) => row.typname === 'FileLinkTargetType')?.labels)
          .toEqual(['record', 'activity', 'event'])
        expect(indexes.map((row) => row.indexname).sort()).toEqual([
          'pipelines_one_default', 'record_stage_history_one_open',
        ])
        const tenantColumns = columns.map((row) => `${row.table_name}.${row.column_name}`).sort()
        expect(tenantColumns).toEqual([
          'attribute_groups.organization_id', 'attribute_groups.team_id',
          'events.organization_id', 'events.team_id',
          'file_objects.organization_id', 'file_objects.team_id',
          'pipelines.organization_id', 'pipelines.team_id',
        ])
      } finally {
        await db.$disconnect()
      }
    })
  }, migrationTestTimeout)

  it('upgrades an existing tenant, keeps values stored, and can re-run', async () => {
    await withDatabase(url ?? '', async (database) => {
      await deployBeforeT57(database)
      const db = createDb(database)
      try {
        await executeSql(database, 'legacy-seed', seedLegacyTenantSql('{}'))
        await executeT57(database)
        await executeT57(database)
        const [attributes, lists, reports, relations] = await Promise.all([
          db.$queryRaw<Array<{ slug: string; value_source: string }>>`
            SELECT slug, value_source::text FROM attributes WHERE slug = 'stage'
          `,
          db.$queryRaw<Array<{ slug: string; kind: string; refresh_state: string }>>`
            SELECT slug, kind::text, refresh_state::text FROM lists WHERE slug = 'open_deals'
          `,
          db.$queryRaw<Array<{ count: bigint }>>`
            SELECT count(*)::bigint AS count FROM migration_reports
          `,
          db.$queryRaw<Array<{ max_active_edges_from: number | null; edge_limit_config: unknown }>>`
            SELECT max_active_edges_from, edge_limit_config FROM relation_types WHERE slug = 'deal_parent'
          `,
        ])
        expect(attributes).toEqual([{ slug: 'stage', value_source: 'stored' }])
        expect(lists).toEqual([{ slug: 'open_deals', kind: 'static', refresh_state: 'ready' }])
        expect(reports[0]?.count).toBe(0n)
        expect(relations).toEqual([{ max_active_edges_from: null, edge_limit_config: {} }])
      } finally {
        await db.$disconnect()
      }
    })
  }, migrationTestTimeout)

  it('fails rather than guessing an undecidable status-to-pipeline mapping', async () => {
    await withDatabase(url ?? '', async (database) => {
      await deployBeforeT57(database)
      const db = createDb(database)
      try {
        await executeSql(database, 'legacy-seed', seedLegacyTenantSql('{"pipeline_id":"legacy"}'))
      } finally {
        await db.$disconnect()
      }
      await expect(executeT57(database)).rejects.toThrow(/undecidable pipeline mapping/u)
    })
  }, migrationTestTimeout)

  it('enforces generic limit, dynamic-list, file and event constraints', async () => {
    await withDatabase(url ?? '', async (database) => {
      await runPrisma(database, ['migrate', 'deploy', '--schema', schemaPath])
      const db = createDb(database)
      try {
        await expect(db.$executeRaw`
          INSERT INTO relation_types (
            id, organization_id, team_id, slug, forward_name, inverse_name,
            cardinality, max_active_edges_from, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'bad_limit', 'bad', 'bad',
            'many_to_many'::"Cardinality", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `).rejects.toThrow(/relation_types_edge_limits_positive/u)
        await expect(db.$executeRaw`
          INSERT INTO lists (
            id, organization_id, team_id, kind, slug, name, definition,
            created_by_type, created_by_id, updated_at
          ) VALUES (
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'dynamic'::"ListKind",
            'bad_dynamic', 'Bad dynamic', '{}'::jsonb, 'system'::"ActorType", 't57', CURRENT_TIMESTAMP
          )
        `).rejects.toThrow(/lists_dynamic_definition_shape/u)
        await expect(db.$executeRaw`
          INSERT INTO file_links (
            id, organization_id, team_id, file_id, target_type, purpose,
            created_by_type, created_by_id
          ) VALUES (
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
            'record'::"FileLinkTargetType", 'proof', 'system'::"ActorType", 't57'
          )
        `).rejects.toThrow(/file_links_target_shape/u)
      } finally {
        await db.$disconnect()
      }
    })
  }, migrationTestTimeout)
})
