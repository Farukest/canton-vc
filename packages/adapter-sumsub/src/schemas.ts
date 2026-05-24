/**
 * Lean Zod schemas for the Sumsub REST + webhook wire surface used by
 * the adapter.
 *
 * Sumsub's response shape is rich and evolves frequently. The adapter
 * keeps schemas conservative: each schema validates the minimum fields
 * the adapter consumes, and `.passthrough()` preserves everything else
 * on `KycDecision.raw` for audit consumers.
 *
 * The Sumsub `reviewAnswer` discipline:
 *
 *   - `GREEN`  — applicant approved
 *   - `RED`    — applicant rejected. `reviewRejectType === 'FINAL'`
 *                means a hard decline; `'RETRY'` means the applicant
 *                can resubmit (we surface as `in_review`).
 *   - `YELLOW` — needs human review, rarely emitted
 *
 * `reviewStatus` lifecycle: `init` → `pending` → `prechecked` →
 * `queued` → `completed`. Plus `onHold` from compliance teams.
 *
 * @module
 */

import { z } from 'zod';

/* ---------- Create applicant ---------- */

/**
 * `POST /resources/applicants?levelName={level}` response.
 *
 * Sumsub returns the full applicant document; we only need the id.
 * `.passthrough()` keeps the rest available for audit.
 */
export const CreateApplicantResponseSchema = z
  .object({
    id: z.string().min(1),
    externalUserId: z.string().min(1).optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();
export type CreateApplicantResponse = z.infer<typeof CreateApplicantResponseSchema>;

/* ---------- WebSDK link ---------- */

/**
 * `POST /resources/sdkIntegrations/levels/{level}/websdkLink` response.
 */
export const WebsdkLinkResponseSchema = z
  .object({
    url: z.string().url(),
  })
  .passthrough();
export type WebsdkLinkResponse = z.infer<typeof WebsdkLinkResponseSchema>;

/* ---------- Review result ---------- */

/**
 * `reviewResult` sub-object. Only present when `reviewStatus === 'completed'`.
 * `reviewAnswer` is intentionally `z.string()` not enum — Sumsub has
 * shipped new values without bumping the API version. The adapter's
 * mapper routes unknowns to a conservative branch.
 */
export const ReviewResultSchema = z
  .object({
    reviewAnswer: z.string().optional(),
    rejectLabels: z.array(z.string()).optional(),
    reviewRejectType: z.string().optional(),
    moderationComment: z.string().optional(),
    clientComment: z.string().optional(),
  })
  .passthrough();
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/* ---------- Status response ---------- */

/**
 * `GET /resources/applicants/{id}/status` response. The terminal
 * status surface — what the adapter polls in `fetchDecision`.
 */
export const ApplicantStatusResponseSchema = z
  .object({
    reviewStatus: z.string().min(1),
    reviewResult: ReviewResultSchema.nullable().optional(),
    createDate: z.string().optional(),
  })
  .passthrough();
export type ApplicantStatusResponse = z.infer<typeof ApplicantStatusResponseSchema>;

/* ---------- Applicant lookup response ---------- */

/**
 * `GET /resources/applicants/-;externalUserId={ref}/one` and
 * `GET /resources/applicants/{id}/one` response. Used by the adapter
 * to resolve `externalUserId` ↔ `applicantId` and read the level the
 * applicant was created at.
 */
export const ApplicantLookupResponseSchema = z
  .object({
    id: z.string().min(1),
    externalUserId: z.string().min(1).optional(),
    review: z
      .object({
        levelName: z.string().optional(),
        levelAutoCheckMode: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    inspectionId: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();
export type ApplicantLookupResponse = z.infer<typeof ApplicantLookupResponseSchema>;

/* ---------- Webhook body ---------- */

/**
 * Inbound webhook body. Sumsub emits one event per applicant state
 * change. `type` is `z.string()` because Sumsub adds new events over
 * time — the adapter's `mapWebhookBody` routes unknown events to a
 * `null` (refuse) branch rather than throwing.
 */
export const WebhookBodySchema = z
  .object({
    applicantId: z.string().optional(),
    inspectionId: z.string().optional(),
    correlationId: z.string().optional(),
    externalUserId: z.string().optional(),
    levelName: z.string().optional(),
    type: z.string().optional(),
    reviewStatus: z.string().optional(),
    reviewResult: ReviewResultSchema.nullable().optional(),
    createdAtMs: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
export type WebhookBody = z.infer<typeof WebhookBodySchema>;
