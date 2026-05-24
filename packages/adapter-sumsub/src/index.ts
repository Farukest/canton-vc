/**
 * `@canton-vc/adapter-sumsub` — Sumsub KYC provider adapter for canton-vc.
 *
 * ```ts
 * import { SumsubAdapter } from '@canton-vc/adapter-sumsub';
 *
 * const kyc = new SumsubAdapter({
 *   appToken: process.env.SUMSUB_APP_TOKEN!,
 *   secretKey: process.env.SUMSUB_SECRET_KEY!,
 *   webhookSecret: process.env.SUMSUB_WEBHOOK_SECRET!,
 *   identityLevelName: 'basic-kyc-level',
 * });
 * ```
 *
 * @module
 */

export type { SumsubAdapterConfig } from './adapter';
export { SumsubAdapter } from './adapter';
export type { SumsubAdapterErrorCode } from './errors';
export { isSumsubAdapterError, SumsubAdapterError } from './errors';
export type { SumsubWebhookAlg } from './hmac';
export {
  isSupportedWebhookAlg,
  SUMSUB_WEBHOOK_ALGS,
  signSumsubRequest,
  verifySumsubWebhookDigest,
} from './hmac';
export type {
  ApplicantLookupResponse,
  ApplicantStatusResponse,
  CreateApplicantResponse,
  ReviewResult,
  WebhookBody,
  WebsdkLinkResponse,
} from './schemas';
export {
  ApplicantLookupResponseSchema,
  ApplicantStatusResponseSchema,
  CreateApplicantResponseSchema,
  ReviewResultSchema,
  WebhookBodySchema,
  WebsdkLinkResponseSchema,
} from './schemas';
