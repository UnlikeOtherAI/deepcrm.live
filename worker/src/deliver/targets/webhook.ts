import { createHmac } from 'node:crypto'

import type { SafeFetch } from '@deepcrm/schemas'

import type { DeliveryTarget } from '../target.js'

export function createWebhookTarget(safeFetch: SafeFetch): DeliveryTarget {
  return {
    kind: 'webhook',
    async deliver(batch, target) {
      const signature = createHmac('sha256', target.secret)
        .update(`${batch.timestamp}.${batch.body}`, 'utf8')
        .digest('hex')
      try {
        const response = await safeFetch(target.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-deepcrm-delivery': batch.deliveryId,
            'x-deepcrm-webhook': batch.webhookId,
            'x-deepcrm-timestamp': batch.timestamp,
            'x-deepcrm-signature': `sha256=${signature}`,
          },
          body: batch.body,
        })
        return response.ok
          ? { ok: true }
          : { ok: false, retryable: true, error: `HTTP ${response.status}` }
      } catch (error) {
        return {
          ok: false,
          retryable: true,
          error: error instanceof Error ? error.message : 'delivery failed',
        }
      }
    },
  }
}
