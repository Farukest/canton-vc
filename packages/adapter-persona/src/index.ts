/**
 * `@canton-vc/adapter-persona` — Persona KYC provider adapter for canton-vc.
 *
 * ```ts
 * import { PersonaAdapter } from '@canton-vc/adapter-persona';
 *
 * const kyc = new PersonaAdapter({
 *   apiKey: process.env.PERSONA_API_KEY!,
 *   webhookSecret: process.env.PERSONA_WEBHOOK_SECRET!,
 *   identityTemplateId: 'itmpl_xxxxxxxxxxxxxxxxxxxxxxxx',
 *   redirectUri: 'https://your.app/kyc/callback',
 * });
 * ```
 *
 * @module
 */

export type { PersonaAdapterConfig } from './adapter';
export { PersonaAdapter } from './adapter';
export type { PersonaAdapterErrorCode } from './errors';
export { isPersonaAdapterError, PersonaAdapterError } from './errors';
export type { PersonaSignaturePair } from './hmac';
export {
  parsePersonaSignatureHeader,
  verifyPersonaSignatureHeader,
  verifyPersonaSignaturePair,
} from './hmac';
export type {
  InquiryResource,
  InquiryResponse,
  InquirySessionResource,
  PersonaInquiryStatus,
  VerificationResource,
  WebhookBody,
} from './schemas';
export {
  classifyVerification,
  InquiryResourceSchema,
  InquiryResponseSchema,
  PERSONA_INQUIRY_STATUS,
  VerificationResourceSchema,
  WebhookBodySchema,
} from './schemas';
