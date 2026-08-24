import { z } from 'zod'

const REQUEST_TTL_MS = 300_000
const RequestIdSchema = z.string().min(1)

export class SeenSet {
  private readonly expiresAtByRequestId = new Map<string, number>()

  consume(requestId: string, now = new Date()): boolean {
    const id = RequestIdSchema.parse(requestId)
    const timestamp = now.getTime()
    this.prune(timestamp)
    if (this.expiresAtByRequestId.has(id)) return false
    this.expiresAtByRequestId.set(id, timestamp + REQUEST_TTL_MS)
    return true
  }

  private prune(now: number): void {
    for (const [requestId, expiresAt] of this.expiresAtByRequestId) {
      if (expiresAt <= now) this.expiresAtByRequestId.delete(requestId)
    }
  }
}
