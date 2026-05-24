/**
 * SumsubAdapter — `KycProvider` implementation wrapping Sumsub's
 * applicant API.
 *
 * Second reference adapter for canton-vc, alongside
 * `@canton-vc/adapter-didit`. The two adapters cover structurally
 * different vendor API shapes; Didit's API differs from Sumsub's
 * across three dimensions:
 *
 *   - **Auth**: Didit uses a static `X-Api-Key`. Sumsub signs every
 *     request with HMAC-SHA256 over `ts + method + path + body`.
 *   - **Identity model**: Didit uses opaque session ids. Sumsub uses
 *     an `applicantId` per user keyed by `externalUserId`.
 *   - **Level vocabulary**: Didit uses `workflow_id` UUIDs. Sumsub
 *     uses level-name strings configured in the Sumsub console.
 *
 * The `KycProvider` interface absorbs all three differences. From the
 * canton-vc issuer pipeline's perspective, the adapter swap is a
 * one-line constructor change.
 *
 * Wire mapping:
 *
 *   startSession    → POST /resources/applicants?levelName=...     (create applicant)
 *                   + POST /resources/sdkIntegrations/levels/.../websdkLink
 *   fetchDecision   → GET  /resources/applicants/{id}/status
 *                   + GET  /resources/applicants/{id}/one          (for levelName)
 *   verifyWebhook   → HMAC over raw body (algorithm from
 *                     `X-Payload-Digest-Alg`, digest from
 *                     `X-Payload-Digest`).
 *
 * @module
 */

import { CANONICAL_FORM_DEFAULT, computeProofHash } from '@canton-vc/core';
import type {
  KycDecision,
  KycDeclineReason,
  KycEvidence,
  KycLevel,
  KycProvider,
  KycSession,
  KycWebhookEvent,
  StartSessionOptions,
} from '@canton-vc/kyc-provider';

import { SumsubAdapterError } from './errors';
import {
  isSupportedWebhookAlg,
  type SumsubWebhookAlg,
  signSumsubRequest,
  verifySumsubWebhookDigest,
} from './hmac';
import {
  type ApplicantLookupResponse,
  ApplicantLookupResponseSchema,
  type ApplicantStatusResponse,
  ApplicantStatusResponseSchema,
  CreateApplicantResponseSchema,
  type ReviewResult,
  type WebhookBody,
  WebhookBodySchema,
  WebsdkLinkResponseSchema,
} from './schemas';

const DEFAULT_BASE_URL = 'https://api.sumsub.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_WEBSDK_TTL_SECONDS = 1800;
const DEFAULT_EXPIRY_DAYS = 365;

/** Sumsub `reviewStatus` enum mirrored locally for the mapper. */
const SUMSUB_REVIEW_STATUS = {
  INIT: 'init',
  PENDING: 'pending',
  PRECHECKED: 'prechecked',
  QUEUED: 'queued',
  COMPLETED: 'completed',
  ON_HOLD: 'onHold',
} as const;

/** Reject-label → KycDeclineReason mapping. Conservative; unknown labels fall to `other`. */
function mapDeclineReason(labels: ReadonlyArray<string> | undefined): KycDeclineReason {
  if (labels === undefined || labels.length === 0) return 'other';
  for (const label of labels) {
    switch (label) {
      case 'FORGERY':
      case 'DOCUMENT_TEMPLATE':
      case 'WRONG_USER_BEHAVIOR':
        return 'document_rejected';
      case 'LIVENESS':
      case 'SELFIE_LIVENESS_REQUIRED':
        return 'liveness_failed';
      case 'ID_SELFIE':
      case 'SELFIE_MISMATCH':
        return 'face_match_failed';
      case 'PROBLEMATIC_APPLICANT_DATA':
      case 'REQUESTED_DATA_MISMATCH':
        return 'name_mismatch';
      case 'BLOCKLIST':
      case 'FRAUDULENT_PATTERNS':
      case 'COMPROMISED_PERSONS':
      case 'CRIMINAL':
      case 'BLACK_AND_WHITE_PHOTO':
        return 'fraud_signals';
      case 'DOCUMENT_PAGE_MISSING':
      case 'BAD_PHOTO':
      case 'BAD_VIDEO':
      case 'BAD_AVATAR':
      case 'INCOMPATIBLE_LANGUAGE':
        return 'unsupported_document';
      case 'EXPIRED_DOCUMENT':
        return 'expired';
      case 'APPLICANT_INTERRUPTED_INTERVIEW':
        return 'declined_by_user';
      default:
        continue;
    }
  }
  return 'other';
}

/* ---------- Helpers ---------- */

function getHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

export interface SumsubAdapterConfig {
  /** Sumsub app token (sandbox values start with `sbx:`, prod with `prd:`). */
  readonly appToken: string;
  /** Sumsub app secret key — keys REST request HMAC. Required. */
  readonly secretKey: string;
  /**
   * Webhook signing secret — per-endpoint shared secret configured in
   * the Sumsub console. Required if the issuer consumes webhooks.
   */
  readonly webhookSecret: string;
  /**
   * Level name Sumsub runs for identity-only verification (e.g.
   * `"basic-kyc-level"`). Required.
   */
  readonly identityLevelName: string;
  /**
   * Optional level name Sumsub runs for enhanced (identity + address)
   * verification. Required only when the issuer uses canton-vc's
   * `address` workflow.
   */
  readonly addressLevelName?: string;
  /** Override the API base URL (defaults to `https://api.sumsub.com`). */
  readonly baseUrl?: string;
  /** Per-request HTTP timeout in milliseconds. Default 10s. */
  readonly requestTimeoutMs?: number;
  /** WebSDK link TTL in seconds. Default 30 minutes. */
  readonly websdkTtlSeconds?: number;
  /**
   * Fetch implementation. Defaults to global `fetch`. Override for
   * tests or runtimes without a global.
   */
  readonly fetch?: typeof fetch;
  /** Wall-clock source. Defaults to `Date.now`. */
  readonly clock?: () => number;
}

/**
 * Map a Sumsub status response to a canton-vc {@link KycDecision}.
 *
 * `levelName` is read from the applicant lookup (sibling fetch) — it
 * tells us whether the applicant ran at the identity-only level or
 * the enhanced level, which the issuer relies on to decide
 * `KycLevel`.
 */
function mapDecision(
  status: ApplicantStatusResponse,
  lookup: ApplicantLookupResponse,
  externalUserId: string,
  identityLevelName: string,
  addressLevelName: string | undefined,
  expiryMs: number,
): KycDecision {
  const reviewResult: ReviewResult | undefined = status.reviewResult ?? undefined;
  const reviewAnswer = reviewResult?.reviewAnswer;
  const rejectType = reviewResult?.reviewRejectType;
  const rejectLabels = reviewResult?.rejectLabels;
  const appliedLevel = lookup.review?.levelName;

  const mappedStatus: KycDecision['status'] = (() => {
    switch (status.reviewStatus) {
      case SUMSUB_REVIEW_STATUS.COMPLETED: {
        if (reviewAnswer === 'GREEN') return 'approved';
        if (reviewAnswer === 'RED') {
          return rejectType === 'RETRY' ? 'in_review' : 'declined';
        }
        return 'in_review';
      }
      case SUMSUB_REVIEW_STATUS.PENDING:
      case SUMSUB_REVIEW_STATUS.PRECHECKED:
      case SUMSUB_REVIEW_STATUS.QUEUED:
      case SUMSUB_REVIEW_STATUS.ON_HOLD:
        return 'in_review';
      case SUMSUB_REVIEW_STATUS.INIT:
        return 'pending';
      default:
        return 'pending';
    }
  })();

  const approved = mappedStatus === 'approved';
  const isAddressLevel =
    addressLevelName !== undefined && appliedLevel === addressLevelName;
  const isIdentityLevel = appliedLevel === identityLevelName;

  const evidence: KycEvidence = {
    identityVerified: approved,
    livenessVerified: approved,
    addressVerified: approved && isAddressLevel,
  };

  const level: KycLevel | undefined = (() => {
    if (!approved) return undefined;
    if (isAddressLevel) return 'enhanced';
    if (isIdentityLevel) return 'basic';
    // Issuer-configured level we don't recognise — refuse to label.
    return undefined;
  })();

  const declineReason: KycDeclineReason | undefined =
    mappedStatus === 'declined' ? mapDeclineReason(rejectLabels) : undefined;

  // Schema-bound proof hash. Field set is content-addressed via
  // `ProofSchemaSpec`; auditors fetch the schema by id and replay the
  // hash from the firm's retained raw bytes. See
  // `@canton-vc/core#computeProofHash` for the canonical pipeline.
  const proofValues = {
    vendor: SUMSUB_PROOF_SCHEMA.vendor,
    schemaVersion: SUMSUB_PROOF_SCHEMA.schemaVersion,
    applicantId: lookup.id,
    externalUserId,
    reviewStatus: status.reviewStatus ?? '',
    reviewAnswer: reviewAnswer ?? '',
    appliedLevel: appliedLevel ?? '',
    identityVerified: evidence.identityVerified === true,
    livenessVerified: evidence.livenessVerified === true,
    addressVerified: evidence.addressVerified === true,
  };
  const proofResult = computeProofHash(SUMSUB_PROOF_SCHEMA, proofValues);

  const expiresAt = new Date(expiryMs).toISOString();

  return Object.freeze({
    sessionId: lookup.id,
    userRef: externalUserId,
    status: mappedStatus,
    ...(level !== undefined && { level }),
    evidence,
    proofHash: proofResult.proofHash,
    proofSchemaId: proofResult.proofSchemaId,
    expiresAt,
    ...(declineReason !== undefined && { declineReason }),
    raw: { status, lookup } as Readonly<Record<string, unknown>>,
  });
}

/**
 * Canonical proof schema for the SumsubAdapter. Fields are listed in
 * a stable order; bumping the schema in any way (new field, renamed
 * field, dropped field) requires a schemaVersion bump so the
 * content-addressed schema id changes and existing credentials remain
 * verifiable against their original spec.
 */
const SUMSUB_PROOF_SCHEMA = Object.freeze({
  vendor: 'sumsub',
  schemaVersion: 'v1',
  fieldsInOrder: Object.freeze([
    'vendor',
    'schemaVersion',
    'applicantId',
    'externalUserId',
    'reviewStatus',
    'reviewAnswer',
    'appliedLevel',
    'identityVerified',
    'livenessVerified',
    'addressVerified',
  ]),
  canonicalForm: CANONICAL_FORM_DEFAULT,
} as const);

/* ---------- SumsubAdapter ---------- */

export class SumsubAdapter implements KycProvider {
  readonly vendorName = 'Sumsub';

  readonly #appToken: string;
  readonly #secretKey: string;
  readonly #webhookSecret: string;
  readonly #identityLevelName: string;
  readonly #addressLevelName: string | undefined;
  readonly #baseUrl: string;
  readonly #requestTimeoutMs: number;
  readonly #websdkTtlSeconds: number;
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;

  constructor(config: SumsubAdapterConfig) {
    if (typeof config.appToken !== 'string' || config.appToken.length === 0) {
      throw new SumsubAdapterError('invalid_config', 'appToken is required.');
    }
    if (typeof config.secretKey !== 'string' || config.secretKey.length === 0) {
      throw new SumsubAdapterError('invalid_config', 'secretKey is required.');
    }
    if (typeof config.webhookSecret !== 'string' || config.webhookSecret.length === 0) {
      throw new SumsubAdapterError('invalid_config', 'webhookSecret is required.');
    }
    if (
      typeof config.identityLevelName !== 'string' ||
      config.identityLevelName.length === 0
    ) {
      throw new SumsubAdapterError('invalid_config', 'identityLevelName is required.');
    }

    this.#appToken = config.appToken;
    this.#secretKey = config.secretKey;
    this.#webhookSecret = config.webhookSecret;
    this.#identityLevelName = config.identityLevelName;
    this.#addressLevelName = config.addressLevelName;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#websdkTtlSeconds = config.websdkTtlSeconds ?? DEFAULT_WEBSDK_TTL_SECONDS;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#clock = config.clock ?? Date.now;
  }

  /** {@inheritDoc KycProvider.startSession} */
  async startSession(options: StartSessionOptions): Promise<KycSession> {
    if (typeof options.userRef !== 'string' || options.userRef.length === 0) {
      throw new SumsubAdapterError('invalid_config', 'userRef is required.');
    }

    const levelName =
      options.workflow === 'address' ? this.#addressLevelName : this.#identityLevelName;
    if (levelName === undefined) {
      throw new SumsubAdapterError(
        'invalid_config',
        options.workflow === 'address'
          ? 'addressLevelName is not configured; cannot start an address session.'
          : 'identityLevelName is not configured.',
      );
    }

    // 1. Create applicant at the requested level.
    const createPath = `/resources/applicants?levelName=${encodeURIComponent(levelName)}`;
    const createBody: Record<string, unknown> = { externalUserId: options.userRef };
    if (options.expectedFullName !== undefined) {
      createBody['fixedInfo'] = {
        firstName: options.expectedFullName.first,
        lastName: options.expectedFullName.last,
      };
    }
    const createRaw = await this.#request('POST', createPath, createBody);
    const created = CreateApplicantResponseSchema.safeParse(createRaw);
    if (!created.success) {
      throw new SumsubAdapterError(
        'invalid_response',
        'Sumsub POST /resources/applicants returned a body that failed schema validation.',
        { context: { issues: created.error.issues } },
      );
    }

    // 2. Get WebSDK link for the user-facing hosted widget.
    const linkPath = `/resources/sdkIntegrations/levels/${encodeURIComponent(levelName)}/websdkLink`;
    const linkBody: Record<string, unknown> = {
      ttlInSecs: this.#websdkTtlSeconds,
      externalUserId: options.userRef,
    };
    if (options.locale !== undefined) {
      linkBody['locale'] = options.locale;
    }
    const linkRaw = await this.#request('POST', linkPath, linkBody);
    const link = WebsdkLinkResponseSchema.safeParse(linkRaw);
    if (!link.success) {
      throw new SumsubAdapterError(
        'invalid_response',
        'Sumsub WebSDK link response failed schema validation.',
        { context: { issues: link.error.issues } },
      );
    }

    const expiresAt = new Date(this.#clock() + this.#websdkTtlSeconds * 1000).toISOString();

    return Object.freeze({
      sessionId: created.data.id,
      redirectUrl: link.data.url,
      expiresAt,
    });
  }

  /** {@inheritDoc KycProvider.fetchDecision} */
  async fetchDecision(sessionId: string): Promise<KycDecision> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new SumsubAdapterError('invalid_config', 'sessionId is required.');
    }

    const [statusRaw, lookupRaw] = await Promise.all([
      this.#request('GET', `/resources/applicants/${encodeURIComponent(sessionId)}/status`),
      this.#request('GET', `/resources/applicants/${encodeURIComponent(sessionId)}/one`),
    ]);

    const status = ApplicantStatusResponseSchema.safeParse(statusRaw);
    if (!status.success) {
      throw new SumsubAdapterError(
        'invalid_response',
        'Sumsub GET /resources/applicants/{id}/status returned a body that failed schema validation.',
        { context: { issues: status.error.issues } },
      );
    }
    const lookup = ApplicantLookupResponseSchema.safeParse(lookupRaw);
    if (!lookup.success) {
      throw new SumsubAdapterError(
        'invalid_response',
        'Sumsub GET /resources/applicants/{id}/one returned a body that failed schema validation.',
        { context: { issues: lookup.error.issues } },
      );
    }

    const externalUserId = lookup.data.externalUserId ?? '';
    const expiryMs = this.#clock() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

    return mapDecision(
      status.data,
      lookup.data,
      externalUserId,
      this.#identityLevelName,
      this.#addressLevelName,
      expiryMs,
    );
  }

  /** {@inheritDoc KycProvider.verifyWebhook} */
  async verifyWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<KycWebhookEvent | null> {
    const digest = getHeader(headers, 'x-payload-digest');
    if (typeof digest !== 'string' || digest.length === 0) {
      throw new SumsubAdapterError(
        'missing_signature_header',
        'Sumsub webhook is missing the X-Payload-Digest header.',
      );
    }
    const algRaw = getHeader(headers, 'x-payload-digest-alg') ?? 'HMAC_SHA256_HEX';
    if (!isSupportedWebhookAlg(algRaw)) {
      throw new SumsubAdapterError(
        'invalid_signature',
        `Sumsub webhook uses unsupported digest algorithm: ${algRaw}.`,
      );
    }
    const alg: SumsubWebhookAlg = algRaw;
    if (!verifySumsubWebhookDigest(this.#webhookSecret, rawBody, digest, alg)) {
      throw new SumsubAdapterError(
        'invalid_signature',
        'Sumsub webhook X-Payload-Digest did not match the computed HMAC.',
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch (cause) {
      throw new SumsubAdapterError('invalid_signature', 'Webhook body is not valid JSON.', {
        cause,
      });
    }
    const body = WebhookBodySchema.safeParse(parsedBody);
    if (!body.success) return null;

    const event = this.#mapWebhookBody(body.data);
    if (event === null) return null;

    // Auto-enrich on terminal decisions. Sumsub's webhook body for
    // `applicantReviewed` does carry `reviewResult`, but it lacks the
    // `levelName` from the applicant lookup which we need to set
    // `KycLevel` correctly. Pull both surfaces so the returned
    // KycDecision is identical regardless of whether the caller is
    // consuming via fetchDecision or verifyWebhook.
    if (
      event.type === 'decision' &&
      (event.decision.status === 'approved' || event.decision.status === 'declined')
    ) {
      try {
        const enriched = await this.fetchDecision(event.decision.sessionId);
        return Object.freeze({ type: 'decision', decision: enriched });
      } catch {
        // Fall back to the webhook-derived event — caller can retry
        // the pull themselves with their own backoff.
        return event;
      }
    }
    return event;
  }

  /* ---------- private helpers ---------- */

  #mapWebhookBody(body: WebhookBody): KycWebhookEvent | null {
    const applicantId = body.applicantId;
    if (typeof applicantId !== 'string' || applicantId.length === 0) {
      return null;
    }
    const externalUserId = body.externalUserId ?? '';

    // `applicantDeleted` — credential should be treated as session
    // closed. canton-vc lacks a dedicated `deleted` event; we surface
    // it as `session.expired` since the upstream effect is the same:
    // the user has to start over.
    if (body.type === 'applicantDeleted') {
      return Object.freeze({
        type: 'session.expired',
        sessionId: applicantId,
        userRef: externalUserId,
      });
    }

    // Webhook-derived decision. Caller's pipeline enriches via
    // fetchDecision before consuming, but for non-terminal events
    // (pending, prechecked, queued, onHold) we still return a
    // KycDecision so issuers can observe the state.
    const reviewStatus = body.reviewStatus ?? 'pending';
    const mappedStatus: KycDecision['status'] = (() => {
      if (reviewStatus === SUMSUB_REVIEW_STATUS.COMPLETED) {
        const answer = body.reviewResult?.reviewAnswer;
        if (answer === 'GREEN') return 'approved';
        if (answer === 'RED') {
          return body.reviewResult?.reviewRejectType === 'RETRY' ? 'in_review' : 'declined';
        }
        return 'in_review';
      }
      if (
        reviewStatus === SUMSUB_REVIEW_STATUS.PENDING ||
        reviewStatus === SUMSUB_REVIEW_STATUS.PRECHECKED ||
        reviewStatus === SUMSUB_REVIEW_STATUS.QUEUED ||
        reviewStatus === SUMSUB_REVIEW_STATUS.ON_HOLD
      ) {
        return 'in_review';
      }
      return 'pending';
    })();

    const declineReason: KycDeclineReason | undefined =
      mappedStatus === 'declined' ? mapDeclineReason(body.reviewResult?.rejectLabels) : undefined;

    const evidence = {
      identityVerified: mappedStatus === 'approved',
      livenessVerified: mappedStatus === 'approved',
      addressVerified: false, // level unknown from webhook alone — auto-enrich sets the truth
    };
    // Schema-bound proof hash. The webhook body alone is insufficient
    // for full audit replay (no `lookup.review.levelName`); the auto-
    // enrich path in `verifyWebhook` replaces this decision with the
    // canonical `fetchDecision` form before terminal events surface.
    const proofResult = computeProofHash(SUMSUB_PROOF_SCHEMA, {
      vendor: SUMSUB_PROOF_SCHEMA.vendor,
      schemaVersion: SUMSUB_PROOF_SCHEMA.schemaVersion,
      applicantId,
      externalUserId,
      reviewStatus: reviewStatus ?? '',
      reviewAnswer: body.reviewResult?.reviewAnswer ?? '',
      appliedLevel: '',
      identityVerified: evidence.identityVerified,
      livenessVerified: evidence.livenessVerified,
      addressVerified: evidence.addressVerified,
    });
    const expiresAt = new Date(
      this.#clock() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    return Object.freeze({
      type: 'decision',
      decision: Object.freeze({
        sessionId: applicantId,
        userRef: externalUserId,
        status: mappedStatus,
        evidence,
        proofHash: proofResult.proofHash,
        proofSchemaId: proofResult.proofSchemaId,
        expiresAt,
        ...(declineReason !== undefined && { declineReason }),
        raw: body as Readonly<Record<string, unknown>>,
      }),
    });
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${this.#baseUrl}${path}`;
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const tsSeconds = Math.floor(this.#clock() / 1000).toString();
    const signature = signSumsubRequest(this.#secretKey, tsSeconds, method, path, bodyString);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-App-Token': this.#appToken,
        'X-App-Access-Sig': signature,
        'X-App-Access-Ts': tsSeconds,
      };
      const init: RequestInit = {
        method,
        headers,
        ...(body !== undefined
          ? { body: bodyString, headers: { ...headers, 'Content-Type': 'application/json' } }
          : {}),
        signal: controller.signal,
      };
      const res = await this.#fetch(url, init);
      if (res.status === 401 || res.status === 403) {
        throw new SumsubAdapterError(
          'unauthorized',
          `Sumsub ${method} ${path} returned ${res.status}.`,
        );
      }
      if (res.status === 404) {
        throw new SumsubAdapterError(
          'applicant_not_found',
          `Sumsub ${method} ${path} returned 404.`,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new SumsubAdapterError(
          'http_error',
          `Sumsub ${method} ${path} returned ${res.status}.`,
          { context: { body: text.slice(0, 512) } },
        );
      }
      return await res.json();
    } catch (err) {
      if (err instanceof SumsubAdapterError) throw err;
      throw new SumsubAdapterError('http_error', `Sumsub ${method} ${path} failed.`, {
        cause: err,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
