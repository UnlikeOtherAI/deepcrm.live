import { lstat, readdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Prisma } from '@deepcrm/db'
import { enqueue } from '@deepcrm/queue'
import { IsoDateTime } from '@deepcrm/schemas'
import { z } from 'zod'

import type { JobHandler } from '../index.js'

export const RETENTION_JOB = 'system.retention'
const DAY_MS = 24 * 60 * 60 * 1_000
const HOUR_MS = 60 * 60 * 1_000
const Payload = z.object({ scheduledFor: IsoDateTime }).strict()

export type RetentionConfig = {
  exportDir: string
  retentionDays: number
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export async function scheduleRetention(
  db: Parameters<typeof enqueue>[0],
  scheduledFor: Date,
): Promise<void> {
  const payload = Payload.parse({ scheduledFor: scheduledFor.toISOString() })
  await enqueue(db, {
    type: RETENTION_JOB,
    payload: payload as Prisma.InputJsonObject,
    visibleAt: scheduledFor,
    idempotencyKey: `retention:${dateKey(scheduledFor)}`,
    maxAttempts: 5,
    matchesExistingPayload: (stored) => {
      const existing = Payload.safeParse(stored)
      return existing.success
        && dateKey(new Date(existing.data.scheduledFor)) === dateKey(scheduledFor)
    },
  })
}

async function pruneExportFiles(directory: string, cutoff: Date): Promise<void> {
  const root = resolve(directory)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}\.(?:csv|jsonl)$/iu.test(entry)) continue
    const path = resolve(root, entry)
    try {
      const metadata = await lstat(path)
      if (metadata.isFile() && metadata.mtime < cutoff) await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export function createRetentionHandler(config: RetentionConfig): JobHandler {
  return async (input) => {
    Payload.parse(input.job.payload)
    if (input.job.type !== RETENTION_JOB
      || input.job.organizationId !== null
      || input.job.teamId !== null) {
      throw new Error('Retention must run as a system-scoped job')
    }
    const now = input.clock()
    await pruneExportFiles(config.exportDir, new Date(now.getTime() - HOUR_MS))
    const recordCutoff = new Date(now.getTime() - config.retentionDays * DAY_MS)
    const replayCutoff = new Date(now.getTime() - DAY_MS)
    const completedJobCutoff = new Date(now.getTime() - 7 * DAY_MS)
    const approvalCutoff = new Date(now.getTime() - 30 * DAY_MS)
    await input.db.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM records WHERE deleted_at < ${recordCutoff} AND erased_at IS NULL`
      await tx.$executeRaw`DELETE FROM idempotency_replays WHERE created_at < ${replayCutoff}`
      await tx.$executeRaw`DELETE FROM queue_jobs WHERE status = 'completed' AND updated_at < ${completedJobCutoff}`
      await tx.$executeRaw`DELETE FROM approval_requests WHERE expires_at < ${approvalCutoff}`
      await scheduleRetention(tx, new Date(now.getTime() + DAY_MS))
    })
  }
}
