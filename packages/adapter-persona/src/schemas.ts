/**
 * Zod schemas for Persona's JSON:API response shapes.
 *
 * Persona's REST API returns documents in JSON:API form:
 *
 *   { data: { type, id, attributes, relationships }, included: [...] }
 *
 * The schemas below mirror just the field set this adapter cares
 * about and use `.passthrough()` so Persona-added fields don't break
 * the parse. Verification types are checked by `type` constant prefix
 * (`verification/government-id`, `verification/selfie`,
 * `verification/database*`).
 *
 * @module
 */

import { z } from 'zod';

/* ---------- Identifier / relationship helpers ---------- */

const JsonApiResourceIdentifierSchema = z
  .object({
    type: z.string().min(1),
    id: z.string().min(1),
  })
  .passthrough();

const JsonApiHasManySchema = z
  .object({
    data: z.array(JsonApiResourceIdentifierSchema),
  })
  .passthrough();

/* ---------- Inquiry ---------- */

/**
 * Inquiry status values published by Persona. Adapter maps these
 * onto the canton-vc {@link KycDecision.status} union. Persona
 * reserves the right to add new statuses without bumping the
 * `Persona-Version` header, so the schema is permissive — unknown
 * statuses pass through as `string` and the mapper falls back to
 * `'pending'`.
 */
export const PERSONA_INQUIRY_STATUS = {
  CREATED: 'created',
  PENDING: 'pending',
  STARTED: 'started',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
  FAILED: 'failed',
  NEEDS_REVIEW: 'needs_review',
  APPROVED: 'approved',
  DECLINED: 'declined',
} as const;
export type PersonaInquiryStatus =
  (typeof PERSONA_INQUIRY_STATUS)[keyof typeof PERSONA_INQUIRY_STATUS];

const InquiryAttributesSchema = z
  .object({
    status: z.string().min(1),
    'reference-id': z.string().nullable().optional(),
    'name-first': z.string().nullable().optional(),
    'name-middle': z.string().nullable().optional(),
    'name-last': z.string().nullable().optional(),
    birthdate: z.string().nullable().optional(),
    'address-street-1': z.string().nullable().optional(),
    'address-street-2': z.string().nullable().optional(),
    'address-city': z.string().nullable().optional(),
    'address-subdivision': z.string().nullable().optional(),
    'address-subdivision-abbr': z.string().nullable().optional(),
    'address-postal-code': z.string().nullable().optional(),
    'address-country-code': z.string().nullable().optional(),
    'email-address': z.string().nullable().optional(),
    'phone-number': z.string().nullable().optional(),
    'created-at': z.string().nullable().optional(),
    'started-at': z.string().nullable().optional(),
    'completed-at': z.string().nullable().optional(),
    'failed-at': z.string().nullable().optional(),
    'decisioned-at': z.string().nullable().optional(),
    'expires-at': z.string().nullable().optional(),
    'expired-at': z.string().nullable().optional(),
  })
  .passthrough();

const InquiryRelationshipsSchema = z
  .object({
    verifications: JsonApiHasManySchema.optional(),
    account: z
      .object({
        data: JsonApiResourceIdentifierSchema.nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const InquiryResourceSchema = z
  .object({
    type: z.literal('inquiry'),
    id: z.string().min(1),
    attributes: InquiryAttributesSchema,
    relationships: InquiryRelationshipsSchema.optional(),
  })
  .passthrough();

export type InquiryResource = z.infer<typeof InquiryResourceSchema>;

/* ---------- Inquiry session (hosted-flow URL) ---------- */

const InquirySessionResourceSchema = z
  .object({
    type: z.literal('inquiry-session'),
    id: z.string().min(1),
    attributes: z
      .object({
        url: z.string().min(1).optional(),
        token: z.string().optional(),
        status: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type InquirySessionResource = z.infer<typeof InquirySessionResourceSchema>;

/* ---------- Verifications ---------- */

const VerificationAttributesSchema = z
  .object({
    status: z.string().min(1),
    'created-at': z.string().nullable().optional(),
    'submitted-at': z.string().nullable().optional(),
    'completed-at': z.string().nullable().optional(),
    'country-code': z.string().nullable().optional(),
    'name-first': z.string().nullable().optional(),
    'name-last': z.string().nullable().optional(),
    'birthdate': z.string().nullable().optional(),
    'document-kind': z.string().nullable().optional(),
    'capture-method': z.string().nullable().optional(),
  })
  .passthrough();

export const VerificationResourceSchema = z
  .object({
    type: z.string().min(1),
    id: z.string().min(1),
    attributes: VerificationAttributesSchema,
  })
  .passthrough();

export type VerificationResource = z.infer<typeof VerificationResourceSchema>;

/**
 * Family classification of a verification by its `type` prefix.
 * Persona uses dot- and dash-segmented types per provider
 * (`verification/government-id-nfc`, `verification/database-standard`,
 * etc.). We bucket them so the mapper can flip the right
 * `evidence.*` flag.
 */
export function classifyVerification(
  type: string,
): 'government-id' | 'selfie' | 'database' | 'document' | 'phone-carrier' | 'other' {
  if (type.startsWith('verification/government-id')) return 'government-id';
  if (type.startsWith('verification/selfie')) return 'selfie';
  if (type.startsWith('verification/database-phone-carrier')) return 'phone-carrier';
  if (type.startsWith('verification/database')) return 'database';
  if (type.startsWith('verification/aamva')) return 'database';
  if (type.startsWith('verification/document')) return 'document';
  return 'other';
}

/* ---------- Envelope (response wrapper) ---------- */

/**
 * `GET /api/v1/inquiries/{id}?include=verifications` envelope. The
 * `included` array carries every related resource (verifications,
 * accounts, inquiry-session) inline.
 */
export const InquiryResponseSchema = z
  .object({
    data: InquiryResourceSchema,
    included: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type InquiryResponse = z.infer<typeof InquiryResponseSchema>;

/* ---------- Webhook event ---------- */

/**
 * Webhook event envelope:
 *
 *   { data: { type: 'event', id, attributes: { name, payload: { data, included } } } }
 *
 * `attributes.name` is the event name (`inquiry.created`,
 * `inquiry.approved`, `inquiry.declined`, `inquiry.expired`, etc.).
 * `attributes.payload` holds a nested JSON:API document with the
 * inquiry resource and its related resources in `included`.
 */
const EventPayloadInnerSchema = z
  .object({
    data: InquiryResourceSchema,
    included: z.array(z.unknown()).optional(),
  })
  .passthrough();

const EventAttributesSchema = z
  .object({
    name: z.string().min(1),
    payload: EventPayloadInnerSchema,
  })
  .passthrough();

const EventResourceSchema = z
  .object({
    type: z.literal('event'),
    id: z.string().min(1),
    attributes: EventAttributesSchema,
  })
  .passthrough();

export const WebhookBodySchema = z
  .object({
    data: EventResourceSchema,
  })
  .passthrough();

export type WebhookBody = z.infer<typeof WebhookBodySchema>;
