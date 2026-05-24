/**
 * Lean Zod schemas for the Didit V3 wire surface used by the adapter.
 *
 * Didit V3 emits per-feature outcomes as **plural array** fields:
 *
 *   id_verifications[]   — document scan + capture entries
 *   liveness_checks[]    — liveness probe entries
 *   face_matches[]       — face-comparison entries
 *   poa_verifications[]  — proof-of-address entries
 *
 * Each array typically contains one entry per capture / comparison.
 * The adapter reads `[0]` as the primary outcome and surfaces it via
 * `KycEvidence`. The full raw response — including warnings, IP
 * analyses, address parsing, document files, etc. — passes through
 * `.passthrough()` and is preserved on `KycDecision.raw` for audit
 * consumers who need the long tail.
 *
 * @module
 */

import { z } from 'zod';

/* ---------- Session create ---------- */

/**
 * `POST /v3/session/` response.
 */
export const CreateSessionResponseSchema = z.object({
  session_id: z.string().min(1).max(256),
  url: z.string().url(),
  expires_at: z.string().datetime().optional(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

/* ---------- Per-feature block schemas ---------- */

/** ID verification entry — one per capture (front / back / NFC). */
export const KycDocumentBlockSchema = z
  .object({
    status: z.string().nullable().optional(),
  })
  .passthrough();

/** Liveness check entry — one per probe. */
export const LivenessBlockSchema = z
  .object({
    status: z.string().nullable().optional(),
  })
  .passthrough();

/** Face match entry — one per comparison. */
export const FaceMatchBlockSchema = z
  .object({
    status: z.string().nullable().optional(),
    score: z.number().nullable().optional(),
  })
  .passthrough();

/** Proof-of-address entry — one per document. */
export const AddressBlockSchema = z
  .object({
    status: z.string().nullable().optional(),
  })
  .passthrough();

/* ---------- Decision response ---------- */

/**
 * `GET /v3/session/{id}/decision/` response. V3 plural-array shape.
 * `.passthrough()` keeps every field Didit emits (warnings, IP
 * analyses, address parsing, document URLs) visible under
 * `KycDecision.raw` for audit consumers.
 *
 * `status` is intentionally `z.string()` not enum — Didit ships new
 * status values without bumping the API version. The adapter's
 * mapping layer routes unknowns to a single conservative branch.
 */
export const DecisionResponseSchema = z
  .object({
    session_id: z.string().min(1),
    status: z.string().min(1),
    vendor_data: z.string().nullable().optional(),
    expires_at: z.string().nullable().optional(),
    human_score: z.number().min(0).max(100).nullable().optional(),
    id_verifications: z.array(KycDocumentBlockSchema).nullable().optional(),
    liveness_checks: z.array(LivenessBlockSchema).nullable().optional(),
    face_matches: z.array(FaceMatchBlockSchema).nullable().optional(),
    poa_verifications: z.array(AddressBlockSchema).nullable().optional(),
  })
  .passthrough();
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

/* ---------- Webhook body ---------- */

/**
 * Inbound webhook payload. Same plural-array shape as the decision
 * response, plus envelope fields (`event_type` / `webhook_type`).
 */
export const WebhookBodySchema = z
  .object({
    event_type: z.string().optional(),
    webhook_type: z.string().optional(),
    session_id: z.string().optional(),
    workflow_id: z.string().optional(),
    status: z.string().optional(),
    vendor_data: z.string().nullable().optional(),
    human_score: z.number().nullable().optional(),
    id_verifications: z.array(KycDocumentBlockSchema).nullable().optional(),
    liveness_checks: z.array(LivenessBlockSchema).nullable().optional(),
    face_matches: z.array(FaceMatchBlockSchema).nullable().optional(),
    poa_verifications: z.array(AddressBlockSchema).nullable().optional(),
  })
  .passthrough();
export type WebhookBody = z.infer<typeof WebhookBodySchema>;
