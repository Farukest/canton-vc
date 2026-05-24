/**
 * DiditAdapter — `KycProvider` implementation wrapping Didit's v3 API.
 *
 * Reference adapter for canton-vc. Drops onto the issuer pipeline as
 * the KYC vendor; users who want a different vendor implement the
 * same `KycProvider` interface (see `@canton-vc/kyc-provider`).
 *
 * Wire mapping at a glance:
 *
 *   startSession    → POST /v3/session/         (workflow_id, vendor_data, …)
 *   fetchDecision   → GET  /v3/session/{id}/decision/
 *   verifyWebhook   → HMAC-SHA256 over canonical JSON of the inbound body,
 *                     compared against the `X-Signature-V2` header,
 *                     with `X-Timestamp` enforced inside a 5-minute window.
 *
 * The adapter is intentionally thin: no retries, no audit-logging,
 * no DB. Caller wraps with their own policies.
 *
 * @module
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { CANONICAL_FORM_DEFAULT, canonicalJson, computeProofHash } from '@canton-vc/core';
import type {
  KycDecision,
  KycEvidence,
  KycLevel,
  KycProvider,
  KycSession,
  KycWebhookEvent,
  StartSessionOptions,
} from '@canton-vc/kyc-provider';

import { DiditAdapterError } from './errors';
import {
  CreateSessionResponseSchema,
  type DecisionResponse,
  DecisionResponseSchema,
  type WebhookBody,
  WebhookBodySchema,
} from './schemas';

/** Didit's documented status enum. Mirrored here so the mapping stays in one place. */
const DIDIT_STATUS = {
  NOT_STARTED: 'Not Started',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  RESUBMITTED: 'Resubmitted',
  APPROVED: 'Approved',
  DECLINED: 'Declined',
  EXPIRED: 'Expired',
  ABANDONED: 'Abandoned',
  KYC_EXPIRED: 'Kyc Expired',
} as const;

/** Default Didit API root (production / sandbox both run on HTTPS). */
const DEFAULT_BASE_URL = 'https://verification.didit.me';

/** Default acceptable webhook timestamp drift. Matches Didit docs. */
const DEFAULT_WEBHOOK_DRIFT_SECONDS = 300;

/** Default request timeout. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface DiditAdapterConfig {
  /** Didit API key — required. */
  readonly apiKey: string;
  /** Webhook signing secret — required. */
  readonly webhookSecret: string;
  /**
   * Workflow id Didit runs for identity verification (document scan +
   * face match + liveness). Required.
   */
  readonly kycWorkflowId: string;
  /**
   * Optional workflow id Didit runs for proof-of-address verification.
   * Required only if the issuer uses canton-vc's `address` workflow.
   */
  readonly addressWorkflowId?: string;
  /** Optional callback URL Didit redirects the user back to after KYC. */
  readonly callbackUrl?: string;
  /** Override the API base URL (e.g. for sandbox / tests). */
  readonly baseUrl?: string;
  /** Override webhook drift window in seconds. Defaults to 300. */
  readonly webhookDriftSeconds?: number;
  /** Override per-request timeout in ms. Defaults to 10_000. */
  readonly requestTimeoutMs?: number;
  /**
   * Fetch implementation. Defaults to the global `fetch`. Override
   * for tests or runtimes without a global.
   */
  readonly fetch?: typeof fetch;
  /** Wall-clock source for webhook freshness checks. Defaults to `Date.now`. */
  readonly clock?: () => number;
}

/* ---------- Helpers ---------- */

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

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

/**
 * Map Didit's status string + decision sub-blocks to a canton-vc
 * {@link KycDecision}. Conservative on unknown statuses (returns
 * `'pending'` rather than throwing).
 */
function mapDecision(
  d: DecisionResponse,
  userRef: string,
): KycDecision {
  const status = (() => {
    switch (d.status) {
      case DIDIT_STATUS.APPROVED:
        return 'approved' as const;
      case DIDIT_STATUS.DECLINED:
      case DIDIT_STATUS.ABANDONED:
        return 'declined' as const;
      case DIDIT_STATUS.IN_REVIEW:
      case DIDIT_STATUS.RESUBMITTED:
        return 'in_review' as const;
      case DIDIT_STATUS.EXPIRED:
      case DIDIT_STATUS.KYC_EXPIRED:
        return 'expired' as const;
      default:
        return 'pending' as const;
    }
  })();

  // Didit V3 wire format: per-feature outcomes live in PLURAL arrays
  // (`id_verifications[]` / `liveness_checks[]` / `face_matches[]` /
  // `poa_verifications[]`). Each array entry is one capture or
  // comparison; the primary outcome is at index 0. A null/empty
  // array means the workflow did not run that feature for this
  // session (e.g. POA-only sessions have id/liveness/face_matches all null).
  const idVerArr = d.id_verifications;
  const livenessArr = d.liveness_checks;
  const faceArr = d.face_matches;
  const poaArr = d.poa_verifications;

  const sessionApproved = status === 'approved';

  // If a feature ran in this session, look at its primary entry. If
  // not (array null/empty) AND the session is approved overall, treat
  // it as verified by the sibling session — Didit splits identity and
  // address into two sessions for issuers that ran the full pipeline.
  const featureFlag = (
    arr: ReadonlyArray<{ readonly status?: string | null | undefined }> | null | undefined,
    fallbackOnApprove: boolean,
  ): boolean => {
    if (arr === null || arr === undefined || arr.length === 0) {
      return fallbackOnApprove ? sessionApproved : false;
    }
    return arr[0]?.status === 'Approved';
  };

  const identityVerified = featureFlag(idVerArr, /* fallbackOnApprove */ true);
  const livenessVerified = featureFlag(livenessArr, /* fallbackOnApprove */ true);
  const faceMatched = featureFlag(faceArr, /* fallbackOnApprove */ true);
  // Address is the only feature that is NOT inferred from a sibling
  // session — verifiers want a hard "we saw the PoA document" signal.
  const addressVerified = featureFlag(poaArr, /* fallbackOnApprove */ false);

  const humanScoreTop = typeof d.human_score === 'number' ? d.human_score : undefined;
  const humanScoreFace = typeof faceArr?.[0]?.score === 'number' ? faceArr[0].score : undefined;
  const humanScore = humanScoreTop ?? humanScoreFace;

  const evidence: KycEvidence = {
    identityVerified: identityVerified && faceMatched,
    livenessVerified,
    addressVerified,
    ...(humanScore !== undefined ? { humanScore } : {}),
  };

  const level: KycLevel | undefined = (() => {
    if (!sessionApproved) return undefined;
    if (addressVerified && identityVerified) return 'enhanced';
    if (identityVerified) return 'basic';
    return undefined;
  })();

  // Schema-bound proof hash. Adapter declares the field set in
  // `DIDIT_PROOF_SCHEMA`; auditors fetch the schema by id from the
  // canton-vc registry and replay the digest from retained raw bytes.
  const proofValues = {
    vendor: DIDIT_PROOF_SCHEMA.vendor,
    schemaVersion: DIDIT_PROOF_SCHEMA.schemaVersion,
    sessionId: d.session_id,
    vendorData: d.vendor_data ?? '',
    overallStatus: d.status ?? '',
    identityVerified: evidence.identityVerified === true,
    livenessVerified: evidence.livenessVerified === true,
    addressVerified: evidence.addressVerified === true,
  };
  const proofResult = computeProofHash(DIDIT_PROOF_SCHEMA, proofValues);

  const expiresAt =
    typeof d.expires_at === 'string' && d.expires_at.length > 0
      ? d.expires_at
      : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  return Object.freeze({
    sessionId: d.session_id,
    userRef,
    status,
    ...(level !== undefined && { level }),
    evidence,
    proofHash: proofResult.proofHash,
    proofSchemaId: proofResult.proofSchemaId,
    expiresAt,
    raw: d as Readonly<Record<string, unknown>>,
  });
}

/**
 * Canonical proof schema for the DiditAdapter (v1). Bumping the
 * fields_in_order list or vendor name requires a schemaVersion bump
 * so the content-addressed id changes and existing credentials
 * remain auditable against their original spec.
 */
const DIDIT_PROOF_SCHEMA = Object.freeze({
  vendor: 'didit',
  schemaVersion: 'v1',
  fieldsInOrder: Object.freeze([
    'vendor',
    'schemaVersion',
    'sessionId',
    'vendorData',
    'overallStatus',
    'identityVerified',
    'livenessVerified',
    'addressVerified',
  ]),
  canonicalForm: CANONICAL_FORM_DEFAULT,
} as const);

/* ---------- DiditAdapter ---------- */

export class DiditAdapter implements KycProvider {
  readonly vendorName = 'Didit';

  readonly #apiKey: string;
  readonly #webhookSecret: string;
  readonly #kycWorkflowId: string;
  readonly #addressWorkflowId: string | undefined;
  readonly #callbackUrl: string | undefined;
  readonly #baseUrl: string;
  readonly #webhookDriftSeconds: number;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;

  constructor(config: DiditAdapterConfig) {
    if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
      throw new DiditAdapterError('invalid_config', 'apiKey is required.');
    }
    if (typeof config.webhookSecret !== 'string' || config.webhookSecret.length === 0) {
      throw new DiditAdapterError('invalid_config', 'webhookSecret is required.');
    }
    if (typeof config.kycWorkflowId !== 'string' || config.kycWorkflowId.length === 0) {
      throw new DiditAdapterError('invalid_config', 'kycWorkflowId is required.');
    }

    this.#apiKey = config.apiKey;
    this.#webhookSecret = config.webhookSecret;
    this.#kycWorkflowId = config.kycWorkflowId;
    this.#addressWorkflowId = config.addressWorkflowId;
    this.#callbackUrl = config.callbackUrl;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#webhookDriftSeconds = config.webhookDriftSeconds ?? DEFAULT_WEBHOOK_DRIFT_SECONDS;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#clock = config.clock ?? Date.now;
  }

  /** {@inheritDoc KycProvider.startSession} */
  async startSession(options: StartSessionOptions): Promise<KycSession> {
    if (typeof options.userRef !== 'string' || options.userRef.length === 0) {
      throw new DiditAdapterError('invalid_config', 'userRef is required.');
    }

    const workflowId = options.workflow === 'address'
      ? this.#addressWorkflowId
      : this.#kycWorkflowId;
    if (workflowId === undefined) {
      throw new DiditAdapterError(
        'invalid_config',
        options.workflow === 'address'
          ? 'addressWorkflowId is not configured; cannot start an address session.'
          : 'kycWorkflowId is not configured.',
      );
    }

    const body: Record<string, unknown> = {
      workflow_id: workflowId,
      vendor_data: options.userRef,
    };
    if (this.#callbackUrl !== undefined) {
      body['callback'] = this.#callbackUrl;
    }
    if (options.expectedFullName !== undefined) {
      body['expected_details'] = {
        first_name: options.expectedFullName.first,
        last_name: options.expectedFullName.last,
      };
    }
    if (options.locale !== undefined) {
      body['locale'] = options.locale;
    }

    const raw = await this.#post('/v3/session/', body);
    const parsed = CreateSessionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DiditAdapterError(
        'invalid_response',
        'Didit POST /v3/session/ returned a body that failed schema validation.',
        { context: { issues: parsed.error.issues } },
      );
    }

    const expiresAt =
      typeof parsed.data.expires_at === 'string' && parsed.data.expires_at.length > 0
        ? parsed.data.expires_at
        : new Date(this.#clock() + 24 * 60 * 60 * 1000).toISOString();

    return Object.freeze({
      sessionId: parsed.data.session_id,
      redirectUrl: parsed.data.url,
      expiresAt,
    });
  }

  /** {@inheritDoc KycProvider.fetchDecision} */
  async fetchDecision(sessionId: string): Promise<KycDecision> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new DiditAdapterError('invalid_config', 'sessionId is required.');
    }

    const raw = await this.#get(`/v3/session/${encodeURIComponent(sessionId)}/decision/`);
    const parsed = DecisionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DiditAdapterError(
        'invalid_response',
        'Didit GET /v3/session/{id}/decision/ returned a body that failed schema validation.',
        { context: { issues: parsed.error.issues } },
      );
    }

    const userRef = typeof parsed.data.vendor_data === 'string' ? parsed.data.vendor_data : '';
    return mapDecision(parsed.data, userRef);
  }

  /** {@inheritDoc KycProvider.verifyWebhook} */
  async verifyWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<KycWebhookEvent | null> {
    const signature = getHeader(headers, 'x-signature-v2');
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new DiditAdapterError(
        'missing_signature_header',
        'Didit webhook is missing the X-Signature-V2 header.',
      );
    }

    const timestampRaw = getHeader(headers, 'x-timestamp');
    const timestamp = typeof timestampRaw === 'string' ? Number.parseInt(timestampRaw, 10) : Number.NaN;
    if (!Number.isFinite(timestamp)) {
      throw new DiditAdapterError(
        'missing_signature_header',
        'Didit webhook is missing or has an invalid X-Timestamp header.',
      );
    }
    const now = Math.floor(this.#clock() / 1000);
    if (Math.abs(now - timestamp) > this.#webhookDriftSeconds) {
      throw new DiditAdapterError(
        'stale_signature',
        `Didit webhook timestamp is outside the ${this.#webhookDriftSeconds}s drift window.`,
        { context: { timestamp, now, drift: now - timestamp } },
      );
    }

    // The HMAC is computed over the canonical JSON of the body.
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch (cause) {
      throw new DiditAdapterError('invalid_signature', 'Webhook body is not valid JSON.', { cause });
    }
    const canonical = canonicalJson(parsedBody);
    const expected = hmacHex(this.#webhookSecret, canonical);
    if (!constantTimeHexEqual(expected, signature)) {
      throw new DiditAdapterError(
        'invalid_signature',
        'Didit webhook X-Signature-V2 did not match the computed HMAC.',
      );
    }

    const body = WebhookBodySchema.safeParse(parsedBody);
    if (!body.success) {
      return null;
    }
    const event = this.#mapWebhookBody(body.data);
    if (event === null) return null;

    // Auto-enrich on terminal decisions. Didit's V3 webhook body is a
    // notification — it carries `status` + `session_id` reliably, but
    // the per-feature arrays (`id_verifications[]`,
    // `liveness_checks[]`, `face_matches[]`, `poa_verifications[]`)
    // are typically null even when the session has detailed sub-block
    // data available. The authoritative source is
    // `GET /v3/session/{id}/decision/`. On `approved` / `declined`
    // status we pull the full decision so the returned KycDecision
    // reflects what the session actually verified (evidence flags,
    // level, proofHash) — issuers don't have to repeat the pull. On
    // transient states we skip the fetch to avoid noisy traffic.
    if (event.type === 'decision' && (event.decision.status === 'approved' || event.decision.status === 'declined')) {
      try {
        const enriched = await this.fetchDecision(event.decision.sessionId);
        return Object.freeze({ type: 'decision', decision: enriched });
      } catch {
        // Pull failure → fall back to the webhook-derived decision.
        // The caller still gets the canonical session_id + status;
        // they can retry the pull themselves with backoff.
        return event;
      }
    }
    return event;
  }

  /* ---------- private helpers ---------- */

  #mapWebhookBody(body: WebhookBody): KycWebhookEvent | null {
    if (typeof body.session_id !== 'string' || body.session_id.length === 0) {
      return null;
    }
    if (
      body.event_type === 'session.expired' ||
      body.status === DIDIT_STATUS.EXPIRED ||
      body.status === DIDIT_STATUS.KYC_EXPIRED
    ) {
      const userRef = typeof body.vendor_data === 'string' ? body.vendor_data : '';
      return Object.freeze({
        type: 'session.expired',
        sessionId: body.session_id,
        userRef,
      });
    }
    // Treat as a decision event. Reuse the decision mapper.
    const decisionInput = {
      session_id: body.session_id,
      status: body.status ?? DIDIT_STATUS.IN_PROGRESS,
      vendor_data: body.vendor_data ?? null,
      id_verifications: body.id_verifications ?? null,
      liveness_checks: body.liveness_checks ?? null,
      face_matches: body.face_matches ?? null,
      poa_verifications: body.poa_verifications ?? null,
      ...(typeof body.human_score === 'number' ? { human_score: body.human_score } : {}),
    };
    const parsed = DecisionResponseSchema.safeParse(decisionInput);
    if (!parsed.success) return null;
    const userRef = typeof body.vendor_data === 'string' ? body.vendor_data : '';
    return Object.freeze({
      type: 'decision',
      decision: mapDecision(parsed.data, userRef),
    });
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    return this.#request('POST', path, body);
  }

  async #get(path: string): Promise<unknown> {
    return this.#request('GET', path, undefined);
  }

  async #request(method: 'GET' | 'POST', path: string, body: unknown): Promise<unknown> {
    const url = `${this.#baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: {
          'X-Api-Key': this.#apiKey,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      };
      const res = await this.#fetch(url, init);
      if (res.status === 401 || res.status === 403) {
        throw new DiditAdapterError('unauthorized', `Didit ${method} ${path} returned ${res.status}.`);
      }
      if (res.status === 404) {
        throw new DiditAdapterError('session_not_found', `Didit ${method} ${path} returned 404.`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new DiditAdapterError(
          'http_error',
          `Didit ${method} ${path} returned ${res.status}.`,
          { context: { body: text.slice(0, 512) } },
        );
      }
      return await res.json();
    } catch (err) {
      if (err instanceof DiditAdapterError) throw err;
      throw new DiditAdapterError(
        'http_error',
        `Didit ${method} ${path} failed.`,
        { cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
