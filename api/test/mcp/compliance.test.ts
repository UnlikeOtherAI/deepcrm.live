import { createDb } from '@deepcrm/db'
import { CrmWriteGuardSet } from '@deepcrm/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { startTestServer } from './harness.js'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for MCP compliance tests')

const ToolResult = z.object({ structuredContent: z.unknown().optional() }).passthrough()
const db = createDb(databaseUrl)
let client: Awaited<ReturnType<typeof startTestServer>>['client']
let closeServer: () => Promise<void>

beforeAll(async () => {
  const started = await startTestServer()
  client = started.client
  closeServer = started.close
})

afterAll(async () => {
  await db.team.updateMany({
    where: { externalTeamId: 'team_dev' },
    data: { rejectedOrigins: [], requireOrigin: false, teamVisibilityOnlyApps: [] },
  })
  await closeServer()
  await db.$disconnect()
})

function structured(result: unknown): Record<string, unknown> {
  const value = ToolResult.parse(result).structuredContent
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected structured object')
  }
  return z.record(z.unknown()).parse(value)
}

describe('compliance MCP tools', () => {
  it('sets the write guard and audits the change', async () => {
    const team = await db.team.findUniqueOrThrow({
      where: { externalTeamId: 'team_dev' },
      select: { id: true, organizationId: true },
    })
    await db.auditLog.deleteMany({
      where: { organizationId: team.organizationId, teamId: team.id, action: 'crm_write_guard_set' },
    })

    const result = CrmWriteGuardSet.out.parse(structured(await client.callTool({
      name: 'crm_write_guard_set',
      arguments: {
        rejected_origins: ['blocked', 'blocked', 'manual'],
        require_origin: true,
        team_visibility_only_apps: ['dev'],
      },
    })))

    expect(result).toEqual({
      rejected_origins: ['blocked', 'manual'],
      require_origin: true,
      team_visibility_only_apps: ['dev'],
    })
    await expect(db.team.findUniqueOrThrow({
      where: { id: team.id },
      select: { rejectedOrigins: true, requireOrigin: true, teamVisibilityOnlyApps: true },
    })).resolves.toEqual({
      rejectedOrigins: ['blocked', 'manual'],
      requireOrigin: true,
      teamVisibilityOnlyApps: ['dev'],
    })
    await expect(db.auditLog.findFirstOrThrow({
      where: { organizationId: team.organizationId, teamId: team.id, action: 'crm_write_guard_set' },
      orderBy: { createdAt: 'desc' },
    })).resolves.toMatchObject({
      action: 'crm_write_guard_set',
      resourceType: 'team',
      resourceId: team.id,
      outcome: 'success',
    })
  })
})
