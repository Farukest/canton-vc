/**
 * `@canton-vc/adapter-didit` — Didit KYC provider adapter for canton-vc.
 *
 * ```ts
 * import { DiditAdapter } from '@canton-vc/adapter-didit';
 *
 * const kyc = new DiditAdapter({
 *   apiKey: process.env.DIDIT_API_KEY!,
 *   webhookSecret: process.env.DIDIT_WEBHOOK_SECRET!,
 *   kycWorkflowId: process.env.DIDIT_KYC_WORKFLOW_ID!,
 * });
 * ```
 *
 * @module
 */

export type { DiditAdapterConfig } from './adapter';
export { DiditAdapter } from './adapter';
export type { DiditAdapterErrorCode } from './errors';
export { DiditAdapterError, isDiditAdapterError } from './errors';
export type {
  CreateSessionResponse,
  DecisionResponse,
  WebhookBody,
} from './schemas';
export {
  CreateSessionResponseSchema,
  DecisionResponseSchema,
  WebhookBodySchema,
} from './schemas';
