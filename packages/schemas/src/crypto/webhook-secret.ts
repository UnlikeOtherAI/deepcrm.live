export const WEBHOOK_SECRET_PURPOSE = 'deepcrm.webhook.v1'

export function webhookSecretAdditionalData(input: {
  organizationId: string
  teamId: string
  webhookId: string
  url: string
}): Uint8Array {
  return new TextEncoder().encode([
    input.organizationId,
    input.teamId,
    input.webhookId,
    input.url,
  ].join('\n'))
}
