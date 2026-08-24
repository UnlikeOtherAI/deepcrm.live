import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { PolicyResourceType } from '@deepcrm/db'
import { ErrorCode, ServiceError, type ActorContext } from '@deepcrm/schemas'
import { z } from 'zod'

import type { AppDeps } from '../../deps.js'
import {
  prepareApproval,
  requireApproval,
  type ApprovalConsumption,
  type ApprovalRequestInput,
} from '../../services/approvals.js'
import { inputRequired, readRequestState, type MrtrInput } from './input-required.js'

export type ApprovalDescriptor<Args extends Record<string, unknown>> = {
  resourceType: PolicyResourceType
  resourceId?: (args: Args) => string | null | undefined
  reason?: (args: Args) => string | undefined
  message?: (args: Args) => string
}

function approvalError(error: unknown): error is ServiceError {
  return error instanceof ServiceError && error.code === ErrorCode.APPROVAL_REQUIRED
}

function approvalInput<Args extends Record<string, unknown>>(
  tool: string, args: Args, descriptor: ApprovalDescriptor<Args>,
): ApprovalRequestInput {
  return {
    tool,
    resourceType: descriptor.resourceType,
    resourceId: descriptor.resourceId?.(args) ?? null,
    args,
    reason: descriptor.reason?.(args),
    message: descriptor.message?.(args),
  }
}

export function withApproval<Shape extends z.ZodRawShape>(
  deps: AppDeps,
  ctx: ActorContext,
  tool: string,
  shape: Shape,
  descriptor: ApprovalDescriptor<z.output<z.ZodObject<Shape>>>,
  run: (
    args: z.output<z.ZodObject<Shape>>,
    mrtr: MrtrInput,
    approval?: ApprovalConsumption,
  ) => Promise<CallToolResult>,
): (args: z.output<z.ZodObject<Shape>>, mrtr: MrtrInput) => Promise<CallToolResult> {
  const parser = z.object(shape).strict()
  return async (args, mrtr) => {
    if (mrtr.requestState !== undefined && mrtr.inputResponses !== undefined) {
      if (mrtr.inputResponses.approval === undefined) return run(args, mrtr)
      const state = readRequestState(mrtr.requestState, deps.secretBox)
      if (state.approvalId === undefined) {
        throw new ServiceError(ErrorCode.APPROVAL_REQUIRED, 'Approval is required', {
          next: 'retry_with_approval',
          detail: 'approval_state_invalid',
        })
      }
      const approved = await prepareApproval(deps, ctx, {
        tool,
        args,
        inputResponses: mrtr.inputResponses,
        requestStatePayload: state,
      })
      return run(parser.parse(approved.args), {}, approved)
    }
    try {
      return await run(args, mrtr)
    } catch (error) {
      if (!approvalError(error)) throw error
      const challenge = await requireApproval(deps, ctx, approvalInput(tool, args, descriptor))
      return inputRequired(challenge.inputRequests, challenge.requestStatePayload, deps.secretBox)
    }
  }
}
