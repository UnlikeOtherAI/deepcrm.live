export type EventBatch = {
  body: string
  webhookId: string
  timestamp: string
  deliveryId: string
}

export type TargetConfig = { url: string; secret: string }

export type DeliveryResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: string }

export interface DeliveryTarget {
  kind: 'webhook'
  deliver(batch: EventBatch, target: TargetConfig): Promise<DeliveryResult>
}
