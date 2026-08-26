import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('..', import.meta.url))
const requireFromApi = createRequire(new URL('../api/package.json', import.meta.url))
const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
  import(requireFromApi.resolve('@modelcontextprotocol/sdk/client/index.js')),
  import(requireFromApi.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')),
])
const keyring = 'eyJhY3RpdmUiOiJsb2NhbC12MSIsImtleXMiOnsibG9jYWwtdjEiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBPSIsImV4cG9ydCI6IkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUVCQVFFQkFRRUJBUUU9In19'
const runKey = crypto.randomUUID().replaceAll('-', '_')
const hostKey = runKey.replaceAll('_', '')
const dbName = `deepcrm_t67_loop_${new Date().toISOString().replaceAll(/[-:.TZ]/gu, '').slice(0, 14)}`
const exportDir = `/tmp/deepcrm-t67-exports-${dbName}`
const apiLog = `/tmp/deepcrm-t67-api-${dbName}.log`
const authApiLog = `/tmp/deepcrm-t67-auth-api-${dbName}.log`
const workerLog = `/tmp/deepcrm-t67-worker-${dbName}.log`
const reportPath = resolve(root, 'docs/done/phase-8-regression.md')
let api
let authApi
let worker
let mcpClient
let loadSchema
let createAppDeps
let parseEnv

async function loadBuiltModules() {
  const [engineModule, depsModule, envModule] = await Promise.all([
    import('../packages/schema-engine/dist/index.js'),
    import('../api/dist/deps.js'),
    import('../api/dist/env.js'),
  ])
  loadSchema = engineModule.loadSchema
  createAppDeps = depsModule.createAppDeps
  parseEnv = envModule.parseEnv
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options })
}

function curl(args, options = {}) {
  return execFileSync('curl', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

async function port() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('no tcp port allocated')))
        return
      }
      const value = address.port
      server.close(() => resolvePort(value))
    })
  })
}

function start(name, env, log) {
  const child = spawn('pnpm', ['--filter', '@deepcrm/api', 'exec', 'tsx', 'src/index.ts'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks = []
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  child.stderr.on('data', (chunk) => chunks.push(chunk))
  child.once('exit', (code) => {
    if (code !== null && code !== 0) process.stderr.write(`${name} exited ${code}\n`)
  })
  child.on('close', () => writeFileSync(log, Buffer.concat(chunks)))
  return child
}

async function stop(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolveStop) => child.once('close', resolveStop))
}

function dropDatabase() {
  try {
    run('docker', [
      'exec', 'deepcrm-pg', 'psql', '-U', 'deepcrm', '-d', 'postgres', '-c',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid <> pg_backend_pid();`,
    ])
  } catch {
    // The final drop below is the authoritative cleanup check.
  }
  run('docker', ['exec', 'deepcrm-pg', 'dropdb', '-U', 'deepcrm', '--if-exists', dbName])
}

async function waitHealth(baseUrl, child = api) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return await response.json()
    } catch {
      // retry below
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`api exited before health; see ${apiLog}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error('health check did not pass')
}

function shape(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0])]
  if (typeof value !== 'object') return typeof value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child)]))
}

function text(value) {
  return JSON.stringify(value, null, 2)
}

function toolResult(value) {
  if (typeof value !== 'object' || value === null) throw new Error('tool result is not an object')
  return value
}

function structured(value) {
  const result = toolResult(value)
  if (!('structuredContent' in result) || typeof result.structuredContent !== 'object' || result.structuredContent === null) {
    throw new Error(`missing structured content: ${JSON.stringify(result)}`)
  }
  return result.structuredContent
}

async function main() {
  const keepAlive = setInterval(() => {}, 1_000)
  run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@deepcrm/api...'], { stdio: 'inherit' })
  await loadBuiltModules()
  const allocatedPort = await port()
  const databaseUrl = `postgresql://deepcrm:deepcrm@localhost:5657/${dbName}`
  console.log(`t67-loop: creating ${dbName} on port ${allocatedPort}`)
  run('docker', ['exec', 'deepcrm-pg', 'createdb', '-U', 'deepcrm', dbName])
  try {
    run('pnpm', ['--filter', '@deepcrm/db', 'exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    })
    const common = {
      NODE_ENV: 'development',
      DATABASE_URL: databaseUrl,
      REQUIRE_AUTH: 'false',
      DEEPCRM_API_PUBLIC_URL: `http://127.0.0.1:${allocatedPort}`,
      DEEPCRM_SECRET_KEYRING_B64: keyring,
      DEEPCRM_EXPORT_DIR: exportDir,
    }
    api = start('api', { ...common, DEEPCRM_PROCESS_MODE: 'api', DEEPCRM_API_PORT: String(allocatedPort) }, apiLog)
    worker = start('worker', { ...common, DEEPCRM_PROCESS_MODE: 'worker' }, workerLog)
    const baseUrl = `http://127.0.0.1:${allocatedPort}`
    const health = await waitHealth(baseUrl)
    console.log('t67-loop: health ok')
    const authPort = await port()
    const authBaseUrl = `http://127.0.0.1:${authPort}`
    authApi = start('auth-api', {
      ...common,
      REQUIRE_AUTH: 'true',
      DEEPCRM_PROCESS_MODE: 'api',
      DEEPCRM_API_PORT: String(authPort),
      DEEPCRM_API_PUBLIC_URL: authBaseUrl,
    }, authApiLog)
    await waitHealth(authBaseUrl, authApi)
    const unauthorized = curl([
      '-sS', '-i', '-X', 'POST', `${authBaseUrl}/mcp`,
      '-H', 'content-type: application/json',
      '--data', '{"jsonrpc":"2.0","id":"auth-probe","method":"tools/list","params":{}}',
    ])
    await stop(authApi)
    authApi = undefined
    const unauthorizedHeader = unauthorized.toLowerCase()
    if (!unauthorized.includes('401 Unauthorized') || !unauthorizedHeader.includes('www-authenticate:')) {
      throw new Error('HTTP unauthorized contract failed')
    }
    const mcpEnv = parseEnv({
      ...common,
      DEEPCRM_PROCESS_MODE: 'api',
      DEEPCRM_API_PORT: String(allocatedPort),
    })
    const deps = createAppDeps(mcpEnv)
    const db = deps.db
    const org = await db.organization.create({ data: { externalOrgId: 'org_dev', name: 'Dev Organisation' }, select: { id: true } })
    const team = await db.team.create({ data: { organizationId: org.id, externalTeamId: 'team_dev', name: 'Dev Team' }, select: { id: true, organizationId: true } })
    const tenant = { organizationId: team.organizationId, teamId: team.id }
    const ctx = {
      tenant,
      app: 'dev',
      actChain: [],
      actor: { type: 'agent', id: 'agent_dev' },
      onBehalfOf: { uoaUserId: 'usr_dev', role: 'owner' },
      provenance: { runId: 't67', toolCallId: crypto.randomUUID(), requestId: crypto.randomUUID() },
      requestId: crypto.randomUUID(),
      now: new Date(),
    }
    const createdBy = `t67-${runKey}`
    for (const [resourceType, action] of [
      ['schema', 'view'], ['schema', 'define'], ['record', 'view'], ['record', 'create'], ['record', 'edit'],
      ['record', 'delete'], ['record', 'restore'], ['record', 'link'], ['record', 'erase'], ['link', 'link'],
      ['link', 'view'], ['list', 'create'], ['list', 'edit'], ['list', 'view'], ['view', 'create'],
      ['view', 'view'], ['view', 'edit'], ['attribute', 'view'], ['attribute', 'edit'], ['merge', 'merge'], ['export', 'export'],
      ['webhook', 'admin'], ['suppression', 'create'], ['suppression', 'view'], ['suppression', 'admin'],
    ]) {
      await db.policyRule.create({ data: {
        ...tenant, scope: 'team', scopeId: team.id, resourceType, action, effect: 'allow',
        priority: 100, requiresApproval: false, createdById: createdBy,
        bindings: { create: [{ actorType: 'agent', actorId: 'agent:dev:agent_dev' }, { actorType: 'role', actorId: 'owner' }] },
      } })
    }
    mcpClient = new Client({ name: 'deepcrm-t67-loop', version: '0.0.0' }, { capabilities: {} })
    const clientTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`))
    await mcpClient.connect(clientTransport)
    const passthrough = {
      parse: (value) => value,
      safeParse: (value) => ({ success: true, data: value }),
    }
    async function request(method, params = {}) {
      return mcpClient.request({ method, params }, passthrough)
    }
    console.log('t67-loop: mcp client ready')
    const executed = new Map()
    const failures = []
    const evidence = []
    const resourceReads = []
    async function call(name, args, ok = true) {
      const result = await mcpClient.callTool({ name, arguments: args })
      const parsed = toolResult(result)
      const isError = parsed.isError === true
      if (ok && isError) throw new Error(`${name} failed: ${JSON.stringify(parsed.structuredContent)}`)
      if (!ok && !isError) throw new Error(`${name} unexpectedly succeeded`)
      executed.set(name, { status: isError ? 'expected_error' : 'ok', shape: shape(parsed.structuredContent ?? parsed) })
      return parsed.structuredContent ?? parsed
    }
    async function readResource(uri) {
      const result = await mcpClient.readResource({ uri })
      resourceReads.push(uri)
      return result
    }
    console.log('t67-loop: calling tools/list')
    const tools = await mcpClient.listTools()
    console.log('t67-loop: tools/list ok')
    const resources = await mcpClient.listResources()
    const resourceTemplates = await mcpClient.listResourceTemplates()
    const prompts = await mcpClient.listPrompts()
    const toolNames = tools.tools.map((tool) => tool.name).sort()
    if (toolNames.length !== 75 || JSON.stringify(tools).includes('NOT_YET')) throw new Error('tool discovery failed')
    for (const resource of resources.resources) await readResource(resource.uri)
    await readResource('crm://help/limits')
    await readResource('crm://help/filtering')
    const templates = ['system', 'standard_crm', 'standard_sales', 'standard_service', 'standard_commerce']
    for (const template of templates) await call('crm_template_apply', { template })
    if (!JSON.stringify(await readResource('crm://templates')).includes('standard_commerce')) {
      throw new Error('template resource incomplete')
    }
    await call('crm_schema_get', {})
    const company = (await call('crm_record_create', { object_type: 'company', data: { name: `Company ${runKey}`, domains: [`company-${hostKey}.example`] } })).record
    const person = (await call('crm_record_create', { object_type: 'person', data: { name: { full: `Person ${runKey}` }, emails: [`person-${runKey}@example.test`], company: company.id } })).record
    const deal = (await call('crm_record_create', { object_type: 'deal', data: { name: `Deal ${runKey}`, stage: 'qualified', amount: { amount: '5000', currency: 'GBP' }, company: company.id, contacts: [person.id] } })).record
    const lead = (await call('crm_record_create', { object_type: 'lead', data: { name: `Lead ${runKey}`, lifecycle_stage: 'new', source: 'inbound', person: person.id, company: company.id, deal: deal.id } })).record
    const ticket = (await call('crm_record_create', { object_type: 'ticket', data: { subject: `Ticket ${runKey}`, status: 'new', priority: 'normal', person: person.id, company: company.id, deal: deal.id } })).record
    const product = (await call('crm_record_create', { object_type: 'product', data: { name: `Product ${runKey}`, sku: `SKU-${runKey}`, status: 'active', current_unit_price: { amount: '100', currency: 'GBP' } } })).record
    const quote = (await call('crm_record_create', { object_type: 'quote', data: { name: `Quote ${runKey}`, quote_number: `Q-${runKey}`, status: 'sent', total_amount: { amount: '100', currency: 'GBP' }, company: company.id, person: person.id, deal: deal.id } })).record
    const subscription = (await call('crm_record_create', { object_type: 'subscription', data: { name: `Subscription ${runKey}`, subscription_ref: `SUB-${runKey}`, status: 'active', start_date: '2026-08-24', billing_frequency: 'monthly', recurring_amount: { amount: '100', currency: 'GBP' }, support_entitlement_active: true, company: company.id, person: person.id, deal: deal.id } })).record
    const order = (await call('crm_record_create', { object_type: 'order', data: { name: `Order ${runKey}`, order_number: `O-${runKey}`, status: 'placed', total_amount: { amount: '100', currency: 'GBP' }, quote: quote.id, company: company.id, person: person.id, deal: deal.id } })).record
    const invoice = (await call('crm_record_assert', { object_type: 'invoice', match_attribute: 'invoice_number', data: { name: `Invoice ${runKey}`, invoice_number: `I-${runKey}`, status: 'open', issue_date: '2026-08-24', due_date: '2026-09-24', total_amount: { amount: '100', currency: 'GBP' }, balance_due: { amount: '0', currency: 'GBP' }, order: order.id, subscription: subscription.id, company: company.id, person: person.id, deal: deal.id } })).record
    const payment = (await call('crm_record_create', { object_type: 'payment', data: { name: `Payment ${runKey}`, payment_ref: `P-${runKey}`, provider: 'manual', provider_payment_ref: `PP-${runKey}`, status: 'succeeded', amount: { amount: '100', currency: 'GBP' }, invoice: invoice.id, order: order.id, subscription: subscription.id, company: company.id, person: person.id, deal: deal.id } })).record
    const lineItem = (await call('crm_record_create', { object_type: 'line_item', data: { name: `Line ${runKey}`, sku: `SKU-${runKey}`, quantity: 1, unit_price: { amount: '100', currency: 'GBP' }, total_amount: { amount: '100', currency: 'GBP' }, billing_frequency: 'one_time', snapshot_at: '2026-08-24T12:00:00.000Z', product: product.id, quote: quote.id, order: order.id, invoice: invoice.id, subscription: subscription.id } })).record
    await call('crm_record_get', { id: company.id, include_links: true, include_timeline: 5 })
    await call('crm_records_query', { object_type: 'line_item', filter: { attribute: 'sku', op: 'eq', value: `SKU-${runKey}` } })
    await call('crm_records_count', { object_type: 'line_item', filter: { attribute: 'sku', op: 'eq', value: `SKU-${runKey}` } })
    await call('crm_records_get_many', { ids: [company.id, person.id, deal.id] })
    const deleted = (await call('crm_record_create', { object_type: 'company', data: { name: `Delete ${runKey}`, domains: [`delete-${hostKey}.example`] } })).record
    await call('crm_record_delete', { id: deleted.id, expected_version: deleted.version, reason: 'regression loop' })
    await call('crm_record_restore', { id: deleted.id })
    const bulk = await call('crm_records_bulk_assert', { object_type: 'company', match_attribute: 'domains', rows: [{ data: { name: `Bulk ${runKey}`, domains: [`bulk-${hostKey}.example`] } }], idempotency_key: `bulk-${runKey}` })
    const link = (await call('crm_link', { relation_type: 'person_works_at', from_record_id: person.id, to_record_id: company.id, idempotency_key: `link-${runKey}` })).link
    await call('crm_links_list', { record_id: person.id, include_history: true })
    await call('crm_unlink', { link_id: link.id, reason: 'regression loop' })
    const list = await call('crm_list_create', { slug: `loop_static_${runKey}`, name: 'Loop static', kind: 'static', object_type: 'company' })
    await readResource(`crm://lists/${list.slug}`)
    await call('crm_list_add', { list: list.slug, entries: [{ record_id: company.id }] })
    await call('crm_list_entries', { list: list.slug })
    await call('crm_list_remove', { list: list.slug, record_ids: [company.id] })
    const dynamic = await call('crm_list_create', { slug: `loop_dynamic_${runKey}`, name: 'Loop dynamic', kind: 'dynamic', object_type: 'line_item', filter: { attribute: 'sku', op: 'eq', value: `SKU-${runKey}` } })
    await readResource(`crm://lists/${dynamic.slug}`)
    await call('crm_list_update', { list: dynamic.slug, name: 'Loop dynamic updated', filter: { attribute: 'sku', op: 'eq', value: `SKU-${runKey}` } })
    await call('crm_list_status', { list: dynamic.slug })
    const view = await call('crm_view_save', { slug: `loop_view_${runKey}`, name: 'Loop view', object_type: 'line_item', filter: { attribute: 'sku', op: 'eq', value: `SKU-${runKey}` }, attributes: ['name', 'sku'] })
    await readResource('crm://schema/line_item')
    await readResource(`crm://views/${view.slug}`)
    await call('crm_view_run', { view: view.slug })
    await call('crm_activity_log', { kind: 'email', occurred_at: '2026-08-24T12:10:00.000Z', direction: 'outbound', subject: 'Loop email', about: [company.id, deal.id] })
    const note = (await call('crm_note_add', { title: 'Loop note', body: 'Loop note body', about: [company.id], idempotency_key: `note-${runKey}` })).record
    await call('crm_record_timeline', { id: company.id, hops: 1, kinds: ['activity', 'note'], limit: 10 })
    const task = (await call('crm_task_create', { title: 'Loop task', priority: 'normal', about: [deal.id], assignee: { type: 'agent', id: 'agent_dev' }, idempotency_key: `task-${runKey}` })).record
    await call('crm_task_update', { id: task.id, status: 'in_progress', expected_version: task.version, idempotency_key: `task-update-${runKey}` })
    await call('crm_tasks_list', { status: 'in_progress', about: deal.id })
    await call('crm_pipeline_define', { object_type: 'deal', slug: `loop_pipeline_${runKey}`, name: 'Loop pipeline', stages: [{ slug: 'new', name: 'New', position: 0, category: 'open' }, { slug: 'won', name: 'Won', position: 1, category: 'won' }] })
    await call('crm_pipeline_update', { object_type: 'deal', pipeline: `loop_pipeline_${runKey}`, name: 'Loop pipeline updated' })
    await call('crm_pipeline_stages_list', { object_type: 'deal', pipeline: `loop_pipeline_${runKey}` })
    await call('crm_pipeline_stage_set', { record_id: deal.id, pipeline: `loop_pipeline_${runKey}`, stage: 'new', reason: 'regression loop', idempotency_key: `stage-${runKey}` })
    await call('crm_pipeline_summary', { object_type: 'deal', pipeline: `loop_pipeline_${runKey}` })
    const eventType = (await call('crm_event_type_define', { slug: `event_${runKey}`, name: 'Loop event', property_schema: { type: 'object', additionalProperties: false, properties: { feature: { type: 'string' } } } })).event_type
    const event = (await call('crm_event_ingest', { event_type: eventType.slug, source: 'loop', external_id: `event-${runKey}`, occurred_at: '2026-08-24T12:20:00.000Z', subject_record_id: company.id, properties: { feature: 'loop' } })).event
    await call('crm_events_query', { event_type: eventType.slug, subject_record_id: company.id })
    const file = (await call('crm_file_register', { provider: 's3', provider_key: `loop/${runKey}/file.txt`, filename: 'file.txt', mime_type: 'text/plain', size_bytes: '10', checksum_sha256: 'a'.repeat(64) })).file
    await call('crm_file_link', { file_id: file.id, target_type: 'record', record_id: company.id, purpose: 'regression' })
    await call('crm_file_list', { target_type: 'record', record_id: company.id })
    const exportTask = await call('crm_export', { object_type: 'company', format: 'csv', attributes: ['name'], idempotency_key: `export-${runKey}` })
    await call('crm_changes_since', { from: 'beginning', limit: 20 })
    await call('crm_search', { query: `Company ${runKey}`, object_types: ['company'], mode: 'keyword', limit: 5 })
    const duplicateTask = await call('crm_find_duplicates', { object_type: 'company', include_semantic: false })
    await call('crm_data_quality', { object_type: 'company', stale_days: 30 })
    const duplicate = (await call('crm_record_create', { object_type: 'company', data: { name: `Company duplicate ${runKey}`, domains: [`dupe-${hostKey}.example`] } })).record
    const merge = await call('crm_merge_records', { survivor_id: company.id, merged_ids: [duplicate.id], field_choices: {}, reason: 'regression loop' })
    await call('crm_unmerge', { merge_change_id: merge.merge_change_id, reason: 'regression loop' })
    await call('crm_suppression_add', { kind: 'email', value: `suppress-${runKey}@example.test`, channel: 'email', reason: 'manual' })
    await call('crm_suppression_check', { entries: [{ kind: 'email', value: `suppress-${runKey}@example.test`, channel: 'email' }] })
    await call('crm_suppression_list', { kind: 'email', channel: 'email' })
    await call('crm_suppression_remove', { kind: 'email', value: `suppress-${runKey}@example.test`, channel: 'email', reason: 'regression loop' })
    const eraseTarget = (await call('crm_record_create', { object_type: 'person', data: { name: { full: `Erase ${runKey}` }, emails: [`erase-${runKey}@example.test`] } })).record
    await call('crm_record_erase', { id: eraseTarget.id, reason: 'gdpr_request', suppress: true })
    await call('crm_write_guard_set', { rejected_origins: ['blocked'], require_origin: false, team_visibility_only_apps: [] })
    const custom = await call('crm_object_type_define', { slug: `loop_object_${runKey}`, singular_name: 'Loop Object', plural_name: 'Loop Objects', description: 'Regression loop object.' })
    await call('crm_object_type_update', { object_type: custom.slug, singular_name: 'Loop Object Updated' })
    await call('crm_attribute_define', { object_type: custom.slug, slug: 'loop_text', name: 'Loop text', description: 'Regression text.', type: 'text', config: { type: 'text', maxLength: 120 } })
    await call('crm_attribute_update', { object_type: custom.slug, attribute: 'loop_text', name: 'Loop text updated' })
    await call('crm_derived_attribute_define', { object_type: custom.slug, slug: 'loop_derived', name: 'Loop derived', description: 'Regression derived.', type: 'text', value_source: 'formula', derivation_config: { expression: { kind: 'literal', value: 'derived' } } })
    await call('crm_derived_attribute_update', { object_type: custom.slug, attribute: 'loop_derived', name: 'Loop derived updated' })
    await call('crm_derived_refresh_status', { object_type: custom.slug })
    await call('crm_attribute_group_define', { object_type: custom.slug, slug: 'loop_group', name: 'Loop group', attributes: ['loop_text'] })
    await call('crm_attribute_group_reorder', { object_type: custom.slug, groups: ['loop_group'] })
    await call('crm_attribute_group_archive', { object_type: custom.slug, group: 'loop_group', reason: 'regression loop' })
    await call('crm_relation_type_define', { slug: `loop_relation_${runKey}`, from_object_type: custom.slug, to_object_type: 'company', forward_name: 'relates to company', inverse_name: 'has loop object', cardinality: 'many_to_one', on_delete: 'unlink' })
    await call('crm_relation_type_update', { relation_type: `loop_relation_${runKey}`, forward_name: 'relates to company updated' })
    await call('crm_relation_type_archive', { relation_type: `loop_relation_${runKey}`, reason: 'regression loop' })
    await call('crm_attribute_archive', { object_type: custom.slug, attribute: 'loop_text', reason: 'regression loop' })
    await call('crm_object_type_archive', { object_type: custom.slug, reason: 'regression loop' })
    await call('crm_matching_rule_set', { object_type: 'company', rules: [{ attributes: ['domains'], method: 'normalized', action: 'block' }] })
    const currentQuote = (await call('crm_record_get', { id: quote.id })).record
    await call('crm_record_update', { id: quote.id, expected_version: currentQuote.version, data: { total_amount: { amount: '101', currency: 'GBP' } } })
    await call('crm_list_status', { list: dynamic.slug })
    await call('crm_record_history', { id: payment.id })
    await call('crm_record_at', { id: company.id, at: new Date().toISOString() })
    await call('crm_view_delete', { view: view.slug })
    await call('crm_record_create', { object_type: 'payment', data: { name: `Bad ${runKey}`, payment_ref: `BAD-${runKey}`, provider: 'manual', provider_payment_ref: `BAD-PP-${runKey}`, status: 'pending', amount: { amount: '1', currency: 'GBP' }, card_number: '4242424242424242' } }, false)
    await call('crm_record_get', { id: '00000000-0000-4000-8000-000000000001' }, false)
    await call('crm_events_query', { event_type: eventType.slug, subject_record_id: '00000000-0000-4000-8000-000000000001' }, false)
    const webhook = (await call('crm_webhook_set', { url: `https://1.1.1.1/events/${runKey}`, events: ['record.created'], active: true })).webhook
    await call('crm_webhook_list', {})
    await call('crm_webhook_delete', { id: webhook.id })
    const tasks = [bulk.task?.taskId, exportTask.task?.taskId, duplicateTask.task?.taskId].filter((id) => typeof id === 'string')
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const pending = await db.queueJob.count({ where: { ...tenant, status: { in: ['queued', 'running'] } } })
      if (pending === 0) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      if (attempt === 79) {
        const pendingJobs = await db.queueJob.findMany({
          where: { ...tenant, status: { in: ['queued', 'running'] } },
          select: { type: true, status: true, attempts: true, maxAttempts: true, visibleAt: true, lastError: true },
          orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
        })
        throw new Error(`tenant queue did not drain: ${text(pendingJobs)}`)
      }
    }
    for (const id of tasks) {
      const task = await request('tasks/get', { taskId: id })
      const status = task.status ?? task.task?.status
      if (status !== 'completed') failures.push(`task ${id} status ${status}`)
      await request('tasks/result', { taskId: id })
    }
    const currentSchema = await loadSchema(db, tenant)
    if (!currentSchema.objectTypesBySlug.has('line_item')) throw new Error('schema engine readback failed')
    const missing = toolNames.filter((name) => !executed.has(name))
    if (missing.length > 0) throw new Error(`registered tools not exercised: ${missing.join(', ')}`)
    if (failures.length > 0) throw new Error(failures.join('; '))
    const queueSummary = await db.queueJob.groupBy({ by: ['type', 'status'], where: tenant, _count: { _all: true } })
    const auditOutput = run('node', ['scripts/verify-audit-chain.mjs'], { env: { ...process.env, DATABASE_URL: databaseUrl } })
    evidence.push({ command: 'curl /health', status: 'ok', shape: shape(health) })
    evidence.push({ command: 'curl POST /mcp invalid body', status: 'ok', http: 401 })
    evidence.push({ command: 'tools/list', status: 'ok', count: toolNames.length })
    evidence.push({ command: 'resources/list+read', status: 'ok', count: resources.resources.length })
    evidence.push({ command: 'resources/templates/list+read', status: 'ok', count: resourceTemplates.resourceTemplates.length })
    evidence.push({ command: 'prompts/list', status: 'ok', count: prompts.prompts.length })
    evidence.push({ command: 'tools/call all registered', status: 'ok', count: executed.size })
    evidence.push({ command: 'queue drain', status: 'ok', shape: queueSummary })
    evidence.push({ command: 'node scripts/verify-audit-chain.mjs', status: 'ok', output: auditOutput.trim() })
    const commit = run('git', ['rev-parse', 'HEAD']).trim()
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `# Phase 8 regression loop\n\n- Commit SHA: ${commit}\n- Disposable database: ${dbName} (dropped by script cleanup)\n- API port: ${allocatedPort}\n- MCP transport: streamable HTTP at /mcp\n- Tools exercised: ${executed.size}/${toolNames.length}\n- Resources read: ${[...new Set(resourceReads)].sort().join(', ')}\n- Resource templates discovered: ${resourceTemplates.resourceTemplates.map((template) => template.uriTemplate).sort().join(', ')}\n- Prompts discovered: ${prompts.prompts.map((prompt) => prompt.name).sort().join(', ')}\n- Worker jobs: ${text(queueSummary)}\n- Audit verification: passed\n- Cleanup: API/worker stopped; database dropped; port checked by script\n\n## Redacted Result Shapes\n\n${text(Object.fromEntries([...executed.entries()].sort(([a], [b]) => a.localeCompare(b))))}\n\n## Commands\n\n${text(evidence)}\n`, 'utf8')
    console.log(`t67-loop: wrote ${reportPath}`)
    console.log(text({ database: dbName, port: allocatedPort, tools: executed.size, resources: resources.resources.length, prompts: prompts.prompts.length, queueSummary }))
    await db.$disconnect()
  } finally {
    if (mcpClient !== undefined) await mcpClient.close()
    await stop(authApi)
    await stop(api)
    await stop(worker)
    rmSync(exportDir, { recursive: true, force: true })
    dropDatabase()
    let stillResponds = true
    try { curl(['-sf', `http://127.0.0.1:${allocatedPort}/health`], { stdio: 'ignore' }) } catch { stillResponds = false }
    if (stillResponds) throw new Error('api still responds after cleanup')
    clearInterval(keepAlive)
  }
}

main().catch(async (error) => {
  await stop(authApi)
  await stop(api)
  await stop(worker)
  try { dropDatabase() } catch {}
  console.error(error)
  process.exit(1)
})
