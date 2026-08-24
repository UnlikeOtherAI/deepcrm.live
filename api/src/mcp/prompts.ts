import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

const APPROVAL_NOTICE = [
  'DeepCRM enforces approval gates server-side for merge, delete, and export operations.',
  'If a tool returns an input_required approval request, present it to an authorised human and only retry with the server-issued approval response and request state.',
].join(' ')

function userMessage(text: string) {
  return {
    messages: [{
      role: 'user' as const,
      content: { type: 'text' as const, text },
    }],
  }
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt('crm/qualify-lead', {
    description: 'Review one lead, its timeline, and its company; identify qualification gaps and propose the next CRM action.',
    argsSchema: {
      record_id: z.string().min(1).describe('Record id of the lead or person to qualify.'),
    },
  }, ({ record_id }) => userMessage([
    `Qualify CRM record ${record_id}.`,
    'Use crm_record_get for the record and its links, then crm_record_timeline for its history and recent activities.',
    'Fetch the linked company when present. Check the object schema for required attributes and report missing qualification facts without guessing them.',
    'Propose an appropriate pipeline stage change; make the change only when the available evidence supports it, then use crm_activity_log to record the outcome.',
    APPROVAL_NOTICE,
  ].join('\n')))

  server.registerPrompt('crm/prepare-account-review', {
    description: 'Prepare an evidence-based review of a company, its people, open deals, recent activity, and data-quality issues.',
    argsSchema: {
      company_record_id: z.string().min(1).describe('Company record id to review.'),
    },
  }, ({ company_record_id }) => userMessage([
    `Prepare an account review for company record ${company_record_id}.`,
    'Use crm_record_get to fetch the company and its links. Gather linked people and open deals with crm_records_query, and inspect the last 90 days with crm_record_timeline.',
    'Use crm_data_quality to identify relevant data-quality issues. Summarise evidence, risks, opportunities, unresolved gaps, and concrete next actions; do not invent missing facts.',
    APPROVAL_NOTICE,
  ].join('\n')))

  server.registerPrompt('crm/clean-duplicates', {
    description: 'Review deterministic duplicate candidates for one object type and merge only evidence-backed groups after human approval.',
    argsSchema: {
      object_type: z.string().min(1).describe('Object type slug to inspect for duplicate records.'),
    },
  }, ({ object_type }) => userMessage([
    `Review duplicate candidates for object type ${object_type}.`,
    'Run crm_find_duplicates, inspect every candidate group and its structural evidence, and fetch records when more context is needed.',
    'Do not infer identity from names or prose. Recommend merges only when the returned evidence supports them, explain conflicts, and request human confirmation before calling crm_merge_records.',
    APPROVAL_NOTICE,
  ].join('\n')))
}
