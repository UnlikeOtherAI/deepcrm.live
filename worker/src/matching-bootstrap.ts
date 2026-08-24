import { pathToFileURL } from 'node:url'

import {
  Prisma,
  createDb,
  tenantWhere,
  writeAudit,
  type Db,
} from '@deepcrm/db'
import { enqueue } from '@deepcrm/queue'
import type { ActorContext } from '@deepcrm/schemas'
import { z } from 'zod'

import { startWorker, type WorkerDeps } from './index.js'
import {
  activeBootstrapKey,
  matchKeyBackfillHandler,
  type ActiveBootstrapPayload,
  type MatchingBootstrapContextSeed,
  MATCH_KEY_BACKFILL_JOB,
} from './jobs/match-key-backfill.js'

const MatchingBootstrapEnvSchema = z.object({
  DATABASE_URL: z.string().trim().min(1),
  DEEPCRM_BOOTSTRAP_UOA_USER_ID: z.string().trim().min(1),
}).passthrough()

export type MatchingBootstrapEnv = z.infer<typeof MatchingBootstrapEnvSchema>

export function parseMatchingBootstrapEnv(source: NodeJS.ProcessEnv): MatchingBootstrapEnv {
  return MatchingBootstrapEnvSchema.parse(source)
}

export type MatchingBootstrapOptions = { retryBootstrap: boolean }

export function parseMatchingBootstrapArgs(args: readonly string[]): MatchingBootstrapOptions {
  if (args.length === 0) return { retryBootstrap: false }
  if (args.length === 1 && args[0] === '--retry-terminal') {
    return { retryBootstrap: true }
  }
  throw new Error('Usage: matching-bootstrap.ts [--retry-terminal]')
}

export type MatchingBootstrapContextInput = {
  tenant: ActorContext['tenant']
  uoaUserId: string
  runId: string
  toolCallId: string
  requestId: string
}

export function createMatchingBootstrapContext(
  input: MatchingBootstrapContextInput,
): MatchingBootstrapContextSeed {
  if (input.uoaUserId.trim() === '') {
    throw new Error('DEEPCRM_BOOTSTRAP_UOA_USER_ID is required for matching bootstrap')
  }
  return {
    tenant: input.tenant,
    app: 'deepcrm:migration',
    actChain: [],
    actor: { type: 'system', id: 'deepcrm:migration:t16' },
    onBehalfOf: { uoaUserId: input.uoaUserId, role: null },
    provenance: {
      runId: input.runId,
      toolCallId: input.toolCallId,
      requestId: input.requestId,
    },
    requestId: input.requestId,
  }
}

export type BootstrapCandidate = {
  id: string
  organizationId: string
  teamId: string
  objectTypeId: string
}

export type MatchingBootstrapJob = {
  generationId: string
  jobId: string
  attempt: number
  created: boolean
}

type MatchingBootstrapDeps = Pick<WorkerDeps, 'db' | 'ids' | 'writeAudit'>

async function candidates(db: Db): Promise<readonly BootstrapCandidate[]> {
  return db.$queryRaw<BootstrapCandidate[]>`
    SELECT DISTINCT
      g.id,
      g.organization_id AS "organizationId",
      g.team_id AS "teamId",
      g.object_type_id AS "objectTypeId"
    FROM matching_rule_generations g
    JOIN matching_rules r ON r.generation_id = g.id
    WHERE g.state = 'active'
      AND g.keys_ready_at IS NULL
      AND r.method IN ('exact', 'normalized')
    ORDER BY g.team_id, g.object_type_id, g.id
  `
}

function bootstrapAuditMetadata(
  context: MatchingBootstrapContextSeed,
  attempt: number,
  retry: boolean,
): Prisma.InputJsonObject {
  return {
    attempt,
    retry,
    app: context.app,
    actChain: context.actChain,
    provenance: context.provenance,
  }
}

async function enqueueCandidate(
  deps: MatchingBootstrapDeps,
  candidate: BootstrapCandidate,
  uoaUserId: string,
  runId: string,
  retryBootstrap: boolean,
): Promise<MatchingBootstrapJob | null> {
  return deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        7::integer,
        hashtext(${`${candidate.teamId}:topology`})
      )
    `
    const generation = await tx.matchingRuleGeneration.findFirst({
      where: {
        ...tenantWhere(candidate),
        id: candidate.id,
        objectTypeId: candidate.objectTypeId,
        state: 'active',
        keysReadyAt: null,
        rules: { some: { method: { in: ['exact', 'normalized'] } } },
      },
      select: {
        id: true,
        bootstrapAttempt: true,
        bootstrapJobId: true,
      },
    })
    if (generation === null) return null

    const existing = generation.bootstrapJobId === null
      ? null
      : await tx.queueJob.findFirst({
        where: {
          id: generation.bootstrapJobId,
          ...tenantWhere(candidate),
          type: MATCH_KEY_BACKFILL_JOB,
        },
        select: { id: true, status: true },
      })
    if (generation.bootstrapJobId !== null && existing === null) {
      throw new Error('Matching bootstrap job identity is invalid')
    }
    if (existing?.status === 'queued' || existing?.status === 'running') {
      return {
        generationId: generation.id,
        jobId: existing.id,
        attempt: generation.bootstrapAttempt,
        created: false,
      }
    }
    if (existing?.status === 'completed') {
      throw new Error('Completed matching bootstrap has no readiness marker')
    }
    const terminal = existing?.status === 'failed' || existing?.status === 'cancelled'
    if (terminal && !retryBootstrap) {
      throw new Error('Terminal matching bootstrap requires --retry-terminal')
    }
    if (generation.bootstrapJobId === null && generation.bootstrapAttempt !== 0) {
      throw new Error('Matching bootstrap attempt identity is invalid')
    }

    const attempt = terminal ? generation.bootstrapAttempt + 1 : generation.bootstrapAttempt
    const requestId = deps.ids()
    const context = createMatchingBootstrapContext({
      tenant: {
        organizationId: candidate.organizationId,
        teamId: candidate.teamId,
      },
      uoaUserId,
      runId,
      toolCallId: 'matching-bootstrap',
      requestId,
    })
    const payload: ActiveBootstrapPayload = {
      mode: 'active_bootstrap',
      organizationId: candidate.organizationId,
      teamId: candidate.teamId,
      objectTypeId: candidate.objectTypeId,
      generationId: generation.id,
      context,
      attempt,
    }
    const queued = await enqueue(tx, {
      ...tenantWhere(candidate),
      type: MATCH_KEY_BACKFILL_JOB,
      payload,
      idempotencyKey: activeBootstrapKey(payload),
    })
    const stored = await tx.matchingRuleGeneration.updateMany({
      where: {
        ...tenantWhere(candidate),
        id: generation.id,
        state: 'active',
        keysReadyAt: null,
        bootstrapAttempt: generation.bootstrapAttempt,
        bootstrapJobId: generation.bootstrapJobId,
      },
      data: {
        bootstrapAttempt: attempt,
        bootstrapJobId: queued.id,
        requestId,
        provenance: context.provenance,
      },
    })
    if (stored.count !== 1) throw new Error('Matching bootstrap attempt changed')
    await deps.writeAudit(tx, {
      organizationId: candidate.organizationId,
      teamId: candidate.teamId,
      actorType: context.actor.type,
      actorId: context.actor.id,
      onBehalfOf: context.onBehalfOf.uoaUserId,
      action: 'schema.matching_rules.bootstrap_queued',
      resourceType: 'object_type',
      resourceId: candidate.objectTypeId,
      outcome: 'success',
      reason: null,
      metadata: bootstrapAuditMetadata(context, attempt, terminal),
      requestId,
      ipAddress: null,
      userAgent: null,
    })
    return {
      generationId: generation.id,
      jobId: queued.id,
      attempt,
      created: true,
    }
  })
}

export function enqueueMatchingBootstrapCandidate(
  deps: MatchingBootstrapDeps,
  candidate: BootstrapCandidate,
  env: MatchingBootstrapEnv,
  options: MatchingBootstrapOptions,
): Promise<MatchingBootstrapJob | null> {
  return enqueueCandidate(
    deps,
    candidate,
    env.DEEPCRM_BOOTSTRAP_UOA_USER_ID,
    deps.ids(),
    options.retryBootstrap,
  )
}

export async function enqueueMatchingBootstrapJobs(
  deps: MatchingBootstrapDeps,
  env: MatchingBootstrapEnv,
  options: MatchingBootstrapOptions,
): Promise<readonly MatchingBootstrapJob[]> {
  const runId = deps.ids()
  const jobs: MatchingBootstrapJob[] = []
  for (const candidate of await candidates(deps.db)) {
    const job = await enqueueCandidate(
      deps,
      candidate,
      env.DEEPCRM_BOOTSTRAP_UOA_USER_ID,
      runId,
      options.retryBootstrap,
    )
    if (job !== null) jobs.push(job)
  }
  return jobs
}

function activeResult(value: Prisma.JsonValue | null): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && value['state'] === 'active'
}

export async function drainMatchingBootstrapJobs(
  deps: WorkerDeps,
  jobs: readonly MatchingBootstrapJob[],
): Promise<void> {
  if (jobs.length === 0) return
  const ids = jobs.map((job) => job.jobId)
  const controller = new AbortController()
  let workerError: Error | null = null
  const worker = startWorker(
    deps,
    { [MATCH_KEY_BACKFILL_JOB]: matchKeyBackfillHandler },
    controller.signal,
  ).catch((error: unknown) => {
    workerError = error instanceof Error ? error : new Error('Matching bootstrap worker failed')
  })
  const deadline = Date.now() + 30_000
  try {
    for (;;) {
      if (workerError !== null) throw workerError
      const stored = await deps.db.queueJob.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, result: true, lastError: true },
      })
      if (stored.length !== ids.length) throw new Error('Matching bootstrap queue identity is missing')
      const terminalFailure = stored.find((job) => (
        job.status === 'failed'
        || job.status === 'cancelled'
        || (job.status === 'queued' && job.lastError !== null)
      ))
      if (terminalFailure !== undefined) throw new Error('Matching bootstrap did not complete')
      if (stored.every((job) => job.status === 'completed')) {
        if (!stored.every((job) => activeResult(job.result))) {
          throw new Error('Matching bootstrap found collisions')
        }
        return
      }
      if (Date.now() >= deadline) throw new Error('Matching bootstrap timed out')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  } finally {
    controller.abort()
    await worker
  }
}

export function createMatchingBootstrapDeps(databaseUrl: string): WorkerDeps {
  return {
    db: createDb(databaseUrl),
    clock: () => new Date(),
    ids: () => crypto.randomUUID(),
    writeAudit,
  }
}

export async function runMatchingBootstrap(
  env: MatchingBootstrapEnv,
  options: MatchingBootstrapOptions,
): Promise<readonly MatchingBootstrapJob[]> {
  const deps = createMatchingBootstrapDeps(env.DATABASE_URL)
  try {
    const jobs = await enqueueMatchingBootstrapJobs(deps, env, options)
    await drainMatchingBootstrapJobs(deps, jobs)
    return jobs
  } finally {
    await deps.db.$disconnect()
  }
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntrypoint) {
  const options = parseMatchingBootstrapArgs(process.argv.slice(2))
  const env = parseMatchingBootstrapEnv(process.env)
  const jobs = await runMatchingBootstrap(env, options)
  process.stdout.write(`${JSON.stringify({ enqueued: jobs })}\n`)
}
