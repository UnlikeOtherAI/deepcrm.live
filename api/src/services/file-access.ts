import { z } from 'zod'

import type { TenantRef } from '@deepcrm/db'
import type { SecretBox } from '@deepcrm/schemas'

const FILE_ACCESS_PURPOSE = 'deepcrm.file-access.v1'
const FILE_ACCESS_TTL_MS = 5 * 60 * 1_000

const GrantPayload = z.object({
  file_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  team_id: z.string().uuid(),
  exp: z.number().int().positive(),
}).strict()

export type FileAccessFile = Readonly<{
  id: string
  provider: string
  providerKey: string
}>

export type FileAccessGrant = Readonly<{
  fileId: string
  tenant: TenantRef
  expiresAt: Date
}>

export type FileAccessMintInput = Readonly<{
  tenant: TenantRef
  file: FileAccessFile
  now: Date
}>

export type FileAccessService = Readonly<{
  mint: (input: FileAccessMintInput) => { url: string; expires_at: string }
  open: (fileId: string, token: string, now: Date) => FileAccessGrant | null
}>

function additionalData(fileId: string): Buffer {
  return Buffer.from(fileId, 'utf8')
}

function payloadJson(value: z.infer<typeof GrantPayload>): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

export function createFileAccessService(publicUrl: string, secretBox: SecretBox): FileAccessService {
  return {
    mint(input) {
      const expiresAt = new Date(input.now.getTime() + FILE_ACCESS_TTL_MS)
      const exp = Math.floor(expiresAt.getTime() / 1_000)
      const token = secretBox.seal(payloadJson({
        file_id: input.file.id,
        organization_id: input.tenant.organizationId,
        team_id: input.tenant.teamId,
        exp,
      }), FILE_ACCESS_PURPOSE, additionalData(input.file.id))
      const url = new URL(`/files/access/${input.file.id}`, publicUrl)
      url.searchParams.set('token', token)
      return { url: url.toString(), expires_at: expiresAt.toISOString() }
    },
    open(fileId, token, now) {
      try {
        const raw = secretBox.open(token, FILE_ACCESS_PURPOSE, additionalData(fileId))
        const parsed = GrantPayload.parse(JSON.parse(Buffer.from(raw).toString('utf8')))
        if (parsed.file_id !== fileId) return null
        if (parsed.exp <= Math.floor(now.getTime() / 1_000)) return null
        return {
          fileId: parsed.file_id,
          tenant: { organizationId: parsed.organization_id, teamId: parsed.team_id },
          expiresAt: new Date(parsed.exp * 1_000),
        }
      } catch {
        return null
      }
    },
  }
}
