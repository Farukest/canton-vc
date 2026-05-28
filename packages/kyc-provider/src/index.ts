/**
 * `@canton-vc/kyc-provider` — generic interface decoupling the
 * canton-vc credential pipeline from any specific KYC vendor.
 *
 * An issuer pipeline that wants to mint Canton credentials needs three
 * things from a KYC vendor:
 *
 *   1. **startSession** — get a redirect URL to send the user to the
 *      vendor's hosted KYC widget; receive a session id for later lookup.
 *   2. **fetchDecision** — pull the vendor's decision for that session
 *      (passport scan, liveness check, address proof, etc.) and
 *      normalize it into a canton-vc {@link KycDecision}.
 *   3. **verifyWebhookSignature** — when the vendor pings the issuer's
 *      webhook with an updated decision, verify the request is genuine
 *      before acting on it.
 *
 * Each KYC vendor (Didit, Onfido, Persona, Sumsub, Veriff, Au10tix,
 * Jumio, …) has a different API, response shape, status enum, and
 * webhook signature scheme. Adapters live in separate packages
 * (`@canton-vc/adapter-<vendor>`) and translate the vendor's quirks
 * into this single uniform interface. The issuer pipeline depends
 * only on the interface — it can swap vendors without touching the
 * Canton wire layer or the credential schema.
 *
 * @module
 */

/**
 * Strength tier the vendor verified the user at. `enhanced` covers
 * both identity + address; `basic` covers identity only.
 */
export type KycLevel = 'basic' | 'enhanced';

/**
 * Workflow the issuer asked the vendor to run for this session.
 *
 * - `identity` — document scan + face match + liveness check
 * - `address` — proof-of-address upload + match against identity name
 * - `combined` — vendor runs both back-to-back in one user-facing session
 */
export type KycWorkflow = 'identity' | 'address' | 'combined';

/**
 * Vendor-provided session record after {@link KycProvider.startSession}.
 */
export interface KycSession {
  /** Vendor's unique session id (opaque to canton-vc). */
  readonly sessionId: string;
  /** URL the user is redirected to in order to complete KYC. */
  readonly redirectUrl: string;
  /** ISO 8601 timestamp at which the session link expires. */
  readonly expiresAt: string;
}

/**
 * Optional kickoff hints the issuer can hand to the vendor when the
 * session is created. Most fields are vendor-honored on a best-effort
 * basis — verify against the vendor's docs.
 */
export interface StartSessionOptions {
  /**
   * Stable user reference the issuer tracks. Returned verbatim on the
   * decision payload so the issuer can rejoin the result to its own
   * records. MUST NOT contain PII — use an opaque id (e.g. UUID).
   */
  readonly userRef: string;
  /**
   * Which workflow to run. Defaults to `identity` for most adapters.
   */
  readonly workflow?: KycWorkflow;
  /**
   * Expected name fields used by some vendors for address-phase
   * fuzzy matching (e.g. Didit's PoA "expected_details" anchor).
   */
  readonly expectedFullName?: { readonly first: string; readonly last: string };
  /**
   * Locale hint for the vendor's hosted widget (BCP 47).
   */
  readonly locale?: string;
}

/**
 * Per-attribute outcomes the vendor surfaces after KYC completes.
 * All optional — a vendor may verify only a subset.
 */
export interface KycEvidence {
  readonly identityVerified?: boolean;
  readonly livenessVerified?: boolean;
  readonly addressVerified?: boolean;
  /** 0..100 score representing the vendor's confidence the user is human. */
  readonly humanScore?: number;
}

/**
 * Reasons a session terminates without an approval — surfaced for
 * UI / audit / fraud-decline-counter integration on the issuer side.
 */
export type KycDeclineReason =
  | 'document_rejected'
  | 'liveness_failed'
  | 'face_match_failed'
  | 'address_mismatch'
  | 'expired'
  | 'declined_by_user'
  | 'fraud_signals'
  | 'unsupported_document'
  | 'name_mismatch'
  | 'other';

/**
 * Final decision payload after a session terminates (approved or not).
 * The adapter normalizes vendor-specific decision objects into this
 * shape; the canton-vc pipeline consumes it verbatim.
 */
export interface KycDecision {
  readonly sessionId: string;
  readonly userRef: string;
  readonly status: 'approved' | 'declined' | 'in_review' | 'pending' | 'expired';
  readonly level?: KycLevel;
  readonly evidence: KycEvidence;
  /**
   * SHA-256 (hex, lowercase) of the canonical proof input derived from
   * the named identity fields listed in the adapter's
   * `ProofSchemaSpec`. The hash binds the on-chain credential to a
   * specific named-field set so that an auditor can replay the digest
   * from the firm's retained raw bytes years later — see
   * `@canton-vc/core#computeProofHash` for the canonical pipeline
   * (`sortKeys + shortenFloats + JSON.stringify + SHA-256`).
   *
   * Hash INPUT contains PII (firstName, lastName, DOB, document
   * number) but OUTPUT is one-way hex and PII-anti-leak by design.
   */
  readonly proofHash: string;
  /**
   * Content-addressed id of the {@link ProofSchemaSpec} that produced
   * `proofHash`. The schema spec itself is published in the canton-vc
   * `docs/proof-schemas/<id>.json` registry; auditors fetch the schema
   * by id to learn which named fields were hashed and in what order.
   *
   * Adapters MUST emit a non-empty value here; the Canton.VC.Credential
   * template ensure clause rejects empty/null on every mint.
   */
  readonly proofSchemaId: string;
  /** ISO 8601 timestamp at which the credential should expire. */
  readonly expiresAt: string;
  /** Decline branch — present only when `status === 'declined'`. */
  readonly declineReason?: KycDeclineReason;
  /**
   * Optional vendor-specific payload retained for audit. canton-vc
   * stores this opaque (vendor decides what to put here).
   */
  readonly raw?: Readonly<Record<string, unknown>>;
}

/**
 * Webhook payload after {@link KycProvider.verifyWebhookSignature}
 * confirms authenticity. The adapter normalizes the vendor's webhook
 * body into either a decision-changed or session-expired event.
 */
export type KycWebhookEvent =
  | { readonly type: 'decision'; readonly decision: KycDecision }
  | { readonly type: 'session.expired'; readonly sessionId: string; readonly userRef: string };

/**
 * Adapter contract — implement once per KYC vendor.
 *
 * Each method MUST be safe to call concurrently; adapters are typically
 * stateless wrappers around a vendor SDK / HTTP client.
 */
export interface KycProvider {
  /**
   * Stable identifier for the vendor. Stamped onto the on-chain
   * credential as the `validator` field so verifiers know which KYC
   * vendor stood behind the credential. Examples: `"Didit"`,
   * `"Onfido"`, `"Persona"`. Use the vendor's canonical brand
   * spelling; do not mutate per environment.
   */
  readonly vendorName: string;

  /**
   * Open a KYC session for the user. Returns the redirect URL the
   * issuer's frontend should send the user to.
   */
  startSession(options: StartSessionOptions): Promise<KycSession>;

  /**
   * Fetch the current decision for an existing session. Used both
   * as a webhook fallback (the issuer pulls on a timer in case the
   * webhook is lost) and to re-hydrate state after a callback.
   *
   * Returns a {@link KycDecision} whose `status` may still be
   * `pending` / `in_review` if the vendor hasn't reached a verdict.
   */
  fetchDecision(sessionId: string): Promise<KycDecision>;

  /**
   * Verify a webhook request's signature using the vendor's scheme
   * (HMAC-SHA256, RSA, etc.) and parse the body into a normalized
   * {@link KycWebhookEvent}. Returns `null` if the signature is
   * invalid or the payload is unrecognized — the caller MUST refuse
   * to process the event in that case.
   *
   * @param rawBody The exact request body bytes the vendor sent.
   *   Adapters that compute signatures over the raw body need the
   *   pre-parse string, so pass it before JSON-decoding.
   * @param headers Request headers as a plain map (`Headers` works too).
   */
  verifyWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<KycWebhookEvent | null>;
}
