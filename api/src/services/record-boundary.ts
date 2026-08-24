import type { Db } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'

import { redactInvisibleDuplicate } from './record-visibility.js'

export async function recordBoundary<T>(
  db: Db,
  correlationId: () => string,
  ctx: ActorContext,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    try {
      return await redactInvisibleDuplicate(db, ctx, error)
    } catch (boundaryError) {
      if (boundaryError instanceof ServiceError) throw boundaryError
      throw new ServiceError(ErrorCode.INTERNAL, 'Record operation failed', {
        correlation_id: correlationId(),
      })
    }
  }
}
