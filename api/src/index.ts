import { buildApp } from './app.js'
import { createAppDeps, type AppDeps } from './deps.js'
import { parseEnv } from './env.js'
import type { JobHandler, WorkerDeps } from '@deepcrm/worker'
import { createHandlers } from '@deepcrm/worker/dist/jobs/registry.js'
import { assertRecordWithIntegration } from './services/records.js'
import { standardRecordWrite } from './services/record-write-integration.js'
import { FakeEmbedder, LedgerEmbedder, type Embedder } from '@deepcrm/schema-engine'

const env = parseEnv(process.env)

// Fail-closed boot check (docs/auth-and-tenancy.md §1, review S2.3): with
// auth off, only localhost origins are ever safe, and never in production.
function assertAuthOffIsSafe(publicUrl: string): void {
  if (env.NODE_ENV === 'production') {
    throw new Error('REQUIRE_AUTH=false is not allowed when NODE_ENV=production')
  }
  const url = new URL(publicUrl)
  const local =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]'
  if (!local) {
    throw new Error(`REQUIRE_AUTH=false requires a localhost DEEPCRM_API_PUBLIC_URL, got ${url.hostname}`)
  }
}

// Worker-mode seam (docs/plans/01-scaffold.md T04). T07 fills the handler
// registry and replaces the no-op implementation with the queue-processing loop.
const WORKER_MODULE = '@deepcrm/worker'

type WorkerModule = {
  startWorker: (deps: WorkerDeps, handlers: Record<string, JobHandler>, signal?: AbortSignal) => Promise<void>
}

function isWorkerModule(loaded: unknown): loaded is WorkerModule {
  if (typeof loaded !== 'object' || loaded === null) return false
  return 'startWorker' in loaded && typeof loaded.startWorker === 'function'
}

async function startWorkerIfNeeded(deps: AppDeps, signal: AbortSignal): Promise<void> {
  if (env.DEEPCRM_PROCESS_MODE === 'api') return
  const loaded: unknown = await import(WORKER_MODULE)
  if (!isWorkerModule(loaded)) {
    throw new Error(
      `DEEPCRM_PROCESS_MODE=${env.DEEPCRM_PROCESS_MODE} requires ${WORKER_MODULE} to export startWorker`,
    )
  }
  // T07 fills the handler registry at this call site (T04 passes {}).
  const recordAssert = async (
    ctx: Parameters<typeof assertRecordWithIntegration>[1],
    input: Parameters<typeof assertRecordWithIntegration>[2],
  ) => {
    const result = await assertRecordWithIntegration(
      deps, ctx, input, standardRecordWrite('crm_records_bulk_assert'),
    )
    return { created: result.created }
  }
  await loaded.startWorker(deps, createHandlers(recordAssert, createEmbedder()), signal)
}

function createEmbedder(): Embedder {
  if (env.LEDGER_PROXY_TOKEN === undefined) return new FakeEmbedder(env.DEEPCRM_EMBEDDING_MODEL)
  if (env.LEDGER_PUBLIC_URL === undefined) {
    throw new Error('LEDGER_PUBLIC_URL is required when LEDGER_PROXY_TOKEN is set')
  }
  return new LedgerEmbedder({
    publicUrl: env.LEDGER_PUBLIC_URL,
    token: env.LEDGER_PROXY_TOKEN,
    model: env.DEEPCRM_EMBEDDING_MODEL,
  })
}

async function main(): Promise<void> {
  if (!env.REQUIRE_AUTH) {
    assertAuthOffIsSafe(env.DEEPCRM_API_PUBLIC_URL)
  }

  const deps = createAppDeps(env)
  const workerAbort = new AbortController()

  if (env.DEEPCRM_PROCESS_MODE === 'worker') {
    await startWorkerIfNeeded(deps, workerAbort.signal)
    return
  }

  // Start the worker first: an unbootable worker mode must never leave a
  // listening-but-half-started API behind.
  const worker = startWorkerIfNeeded(deps, workerAbort.signal)

  const app = buildApp(deps, env)
  await app.listen({ port: env.DEEPCRM_API_PORT, host: '0.0.0.0' })

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    workerAbort.abort()
    app.log.info({ signal: 'SIGTERM' }, 'shutting down')
    void Promise.all([worker, app.close()]).then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`boot failed: ${message}\n`)
  process.exit(1)
})
