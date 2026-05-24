/**
 * PersonaAdapter — `KycProvider` implementation wrapping Persona's
 * Inquiry API.
 *
 * Third reference adapter for canton-vc, alongside
 * `@canton-vc/adapter-didit` and `@canton-vc/adapter-sumsub`. The
 * three adapters cover three structurally distinct vendor shapes:
 *
 *   - **Auth**: Didit uses a static `X-Api-Key`. Sumsub signs every
 *     request with HMAC over `ts + method + path + body`. Persona
 *     uses a Bearer token plus a `Persona-Version` header that pins
 *     the response shape.
 *   - **Identity model**: Didit uses opaque session ids. Sumsub uses
 *     an `applicantId` per user keyed by `externalUserId`. Persona
 *     uses an `inquiry` id and the user-supplied `reference-id`.
 *   - **Workflow vocabulary**: Didit uses `workflow_id` UUIDs.
 *     Sumsub uses level-name strings. Persona uses
 *     `inquiry-template-id` references (`itmpl_xxxx`).
 *   - **Wire format**: Didit and Sumsub return flat JSON. Persona
 *     returns JSON:API documents with `data.attributes`,
 *     `data.relationships`, and an `included` array for related
 *     resources.
 *
 * Wire mapping:
 *
 *   startSession    → POST /api/v1/inquiries with
 *                     meta.auto-create-inquiry-session=true; the
 *                     hosted-flow URL is in
 *                     included[].attributes.url where
 *                     type === 'inquiry-session'.
 *   fetchDecision   → GET  /api/v1/inquiries/{id}?include=verifications
 *                     classifies the `included[]` verifications by
 *                     `type` prefix into government-id / selfie /
 *                     database and maps statuses onto KycEvidence.
 *   verifyWebhook   → Persona-Signature header (HMAC-SHA256 over
 *                     `<ts>.<rawBody>`), parses the event envelope
 *                     and either auto-enriches via fetchDecision or
 *                     returns the synthesized decision verbatim.
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

import { PersonaAdapterError } from './errors';
import { verifyPersonaSignatureHeader } from './hmac';
import {
  classifyVerification,
  type InquiryResource,
  InquiryResponseSchema,
  PERSONA_INQUIRY_STATUS,
  type VerificationResource,
  VerificationResourceSchema,
  WebhookBodySchema,
} from './schemas';

const DEFAULT_BASE_URL = 'https://api.withpersona.com';
const DEFAULT_PERSONA_VERSION = '2025-12-08';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_EXPIRY_DAYS = 365;
const DEFAULT_WEBHOOK_DRIFT_SECONDS = 300;

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

export interface PersonaAdapterConfig {
  /** Persona API key — required. Format `persona_sandbox_*` or `persona_live_*`. */
  readonly apiKey: string;
  /**
   * Webhook signing secret — per-endpoint shared secret configured
   * in the Persona console. Required if the issuer consumes webhooks.
   */
  readonly webhookSecret: string;
  /**
   * Inquiry-template id Persona runs for identity verification
   * (Government ID + Selfie / Liveness). Format `itmpl_xxxxxxxxxx`.
   * Required.
   */
  readonly identityTemplateId: string;
  /**
   * Optional inquiry-template id Persona runs for proof-of-address
   * verification (typically a Database step or document upload).
   * Required only when the issuer uses canton-vc's `address` workflow.
   */
  readonly addressTemplateId?: string;
  /**
   * Optional redirect URI Persona uses after the hosted flow
   * completes. Defaults to none — when omitted the user lands on
   * Persona's hosted "verification complete" screen.
   */
  readonly redirectUri?: string;
  /** Override the API base URL (defaults to `https://api.withpersona.com`). */
  readonly baseUrl?: string;
  /**
   * Override the `Persona-Version` header value. Defaults to a known
   * recent version. Bumping this value is a breaking change in
   * Persona's response shape — keep pinned across deployments.
   */
  readonly personaVersion?: string;
  /** Per-request HTTP timeout in milliseconds. Default 10s. */
  readonly requestTimeoutMs?: number;
  /** Webhook timestamp drift tolerance in seconds. Default 300. */
  readonly webhookDriftSeconds?: number;
  /**
   * Fetch implementation. Defaults to global `fetch`. Override for
   * tests or runtimes without a global.
   */
  readonly fetch?: typeof fetch;
  /** Wall-clock source. Defaults to `Date.now`. */
  readonly clock?: () => number;
}

/* ---------- Decision mapping ---------- */

function mapInquiryStatus(raw: string): KycDecision['status'] {
  switch (raw) {
    case PERSONA_INQUIRY_STATUS.APPROVED:
    case PERSONA_INQUIRY_STATUS.COMPLETED:
      // `completed` means the user finished every required step. Some
      // Persona accounts then run an automation rule that escalates the
      // inquiry to `approved` or `declined`; others treat `completed`
      // as the terminal good state. canton-vc's status union has no
      // "completed-pending-decision" state, so we collapse `completed`
      // into `approved` — the firm's decision policy on the resulting
      // evidence + verification statuses is then the source of truth.
      return 'approved';
    case PERSONA_INQUIRY_STATUS.DECLINED:
    case PERSONA_INQUIRY_STATUS.FAILED:
      return 'declined';
    case PERSONA_INQUIRY_STATUS.EXPIRED:
      return 'expired';
    case PERSONA_INQUIRY_STATUS.NEEDS_REVIEW:
      return 'in_review';
    case PERSONA_INQUIRY_STATUS.STARTED:
    case PERSONA_INQUIRY_STATUS.PENDING:
      return 'in_review';
    case PERSONA_INQUIRY_STATUS.CREATED:
      return 'pending';
    default:
      return 'pending';
  }
}

const VERIFICATION_PASS_STATUSES = new Set(['passed', 'confirmed']);

function verificationPassed(v: VerificationResource): boolean {
  return VERIFICATION_PASS_STATUSES.has(v.attributes.status);
}

/**
 * Compute canton-vc evidence flags from a list of related
 * verifications.
 *
 * - identityVerified  iff a government-id verification passed
 * - livenessVerified  iff a selfie verification passed
 * - addressVerified   iff a database / document verification passed
 *
 * If a verification family is absent from the inquiry, the
 * corresponding flag is `false` (the user did not run that step).
 */
function evidenceFromVerifications(
  verifications: readonly VerificationResource[],
): KycEvidence {
  let identityVerified = false;
  let livenessVerified = false;
  let addressVerified = false;
  for (const v of verifications) {
    if (!verificationPassed(v)) continue;
    const family = classifyVerification(v.type);
    if (family === 'government-id') identityVerified = true;
    else if (family === 'selfie') livenessVerified = true;
    else if (family === 'database' || family === 'document') addressVerified = true;
  }
  return Object.freeze({ identityVerified, livenessVerified, addressVerified });
}

function deriveLevel(evidence: KycEvidence): KycLevel | undefined {
  if (evidence.identityVerified && evidence.livenessVerified && evidence.addressVerified) {
    return 'enhanced';
  }
  if (evidence.identityVerified && evidence.livenessVerified) {
    return 'basic';
  }
  return undefined;
}

/**
 * No structured decline taxonomy in Persona's public API today; the
 * adapter returns `'other'` for declined inquiries until a more
 * specific signal lands. Caller-side policy can inspect
 * `decision.raw` for the inquiry's verification array if needed.
 */
function mapDeclineReason(): KycDeclineReason {
  return 'other';
}

/**
 * Build a canton-vc {@link KycDecision} from Persona's inquiry +
 * included verifications.
 */
function mapDecision(
  inquiry: InquiryResource,
  verifications: readonly VerificationResource[],
  expiryMs: number,
): KycDecision {
  const status = mapInquiryStatus(inquiry.attributes.status);
  const approved = status === 'approved';
  const evidence = approved
    ? evidenceFromVerifications(verifications)
    : Object.freeze({
        identityVerified: false,
        livenessVerified: false,
        addressVerified: false,
      });

  const level = approved ? deriveLevel(evidence) : undefined;

  const declineReason: KycDeclineReason | undefined =
    status === 'declined' ? mapDeclineReason() : undefined;

  // Schema-bound proof hash. Field set pinned via PERSONA_PROOF_SCHEMA.
  const userRef = inquiry.attributes['reference-id'] ?? '';
  const proofValues = {
    vendor: PERSONA_PROOF_SCHEMA.vendor,
    schemaVersion: PERSONA_PROOF_SCHEMA.schemaVersion,
    inquiryId: inquiry.id,
    referenceId: userRef,
    inquiryStatus: inquiry.attributes.status,
    identityVerified: evidence.identityVerified === true,
    livenessVerified: evidence.livenessVerified === true,
    addressVerified: evidence.addressVerified === true,
  };
  const proofResult = computeProofHash(PERSONA_PROOF_SCHEMA, proofValues);

  const expiresAt = new Date(expiryMs).toISOString();

  return Object.freeze({
    sessionId: inquiry.id,
    userRef,
    status,
    ...(level !== undefined && { level }),
    evidence,
    proofHash: proofResult.proofHash,
    proofSchemaId: proofResult.proofSchemaId,
    expiresAt,
    ...(declineReason !== undefined && { declineReason }),
    raw: { inquiry, verifications } as Readonly<Record<string, unknown>>,
  });
}

/**
 * Canonical proof schema for the PersonaAdapter (v1).
 */
const PERSONA_PROOF_SCHEMA = Object.freeze({
  vendor: 'persona',
  schemaVersion: 'v1',
  fieldsInOrder: Object.freeze([
    'vendor',
    'schemaVersion',
    'inquiryId',
    'referenceId',
    'inquiryStatus',
    'identityVerified',
    'livenessVerified',
    'addressVerified',
  ]),
  canonicalForm: CANONICAL_FORM_DEFAULT,
} as const);

/* ---------- PersonaAdapter ---------- */

export class PersonaAdapter implements KycProvider {
  readonly vendorName = 'Persona';

  readonly #apiKey: string;
  readonly #webhookSecret: string;
  readonly #identityTemplateId: string;
  readonly #addressTemplateId: string | undefined;
  readonly #redirectUri: string | undefined;
  readonly #baseUrl: string;
  readonly #personaVersion: string;
  readonly #requestTimeoutMs: number;
  readonly #webhookDriftSeconds: number;
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;

  constructor(config: PersonaAdapterConfig) {
    if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
      throw new PersonaAdapterError('invalid_config', 'apiKey is required.');
    }
    if (typeof config.webhookSecret !== 'string' || config.webhookSecret.length === 0) {
      throw new PersonaAdapterError('invalid_config', 'webhookSecret is required.');
    }
    if (
      typeof config.identityTemplateId !== 'string' ||
      config.identityTemplateId.length === 0
    ) {
      throw new PersonaAdapterError('invalid_config', 'identityTemplateId is required.');
    }
    this.#apiKey = config.apiKey;
    this.#webhookSecret = config.webhookSecret;
    this.#identityTemplateId = config.identityTemplateId;
    this.#addressTemplateId = config.addressTemplateId;
    this.#redirectUri = config.redirectUri;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#personaVersion = config.personaVersion ?? DEFAULT_PERSONA_VERSION;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#webhookDriftSeconds = config.webhookDriftSeconds ?? DEFAULT_WEBHOOK_DRIFT_SECONDS;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#clock = config.clock ?? Date.now;
  }

  /** {@inheritDoc KycProvider.startSession} */
  async startSession(options: StartSessionOptions): Promise<KycSession> {
    if (typeof options.userRef !== 'string' || options.userRef.length === 0) {
      throw new PersonaAdapterError('invalid_config', 'userRef is required.');
    }

    const templateId =
      options.workflow === 'address' ? this.#addressTemplateId : this.#identityTemplateId;
    if (templateId === undefined) {
      throw new PersonaAdapterError(
        'invalid_config',
        options.workflow === 'address'
          ? 'addressTemplateId is not configured; cannot start an address session.'
          : 'identityTemplateId is not configured.',
      );
    }

    const attributes: Record<string, unknown> = {
      'inquiry-template-id': templateId,
      'reference-id': options.userRef,
    };
    if (this.#redirectUri !== undefined) {
      attributes['redirect-uri'] = this.#redirectUri;
    }
    if (options.expectedFullName !== undefined) {
      attributes['fields'] = {
        'name-first': options.expectedFullName.first,
        'name-last': options.expectedFullName.last,
      };
    }
    if (options.locale !== undefined) {
      attributes['locale'] = options.locale;
    }

    // Single-call hosted-flow URL minting. `auto-create-one-time-link`
    // tells Persona to provision a short URL (`https://withpersona.com/session/...`)
    // alongside the inquiry; the URL surfaces at the response's
    // top-level `meta.one-time-link`. The one-time-link is single-use
    // (with a 5-minute grace period after redemption) and expires
    // after the template-configured TTL (default 24h).
    //
    // `meta.auto-create-account=true` and `meta.auto-create-one-time-link=true`
    // can coexist; `meta.auto-create-inquiry-session=true` is mutually
    // exclusive with `auto-create-one-time-link` (Persona rejects with
    // 400 if both are present).
    const body = {
      data: {
        type: 'inquiry',
        attributes,
      },
      meta: {
        'auto-create-account': true,
        'auto-create-one-time-link': true,
      },
    };

    const raw = await this.#request('POST', '/api/v1/inquiries', body);
    const parsed = InquiryResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PersonaAdapterError(
        'invalid_response',
        'Persona POST /api/v1/inquiries returned a body that failed schema validation.',
        { context: { issues: parsed.error.issues } },
      );
    }

    const url = this.#extractOneTimeLinkUrl(raw);
    if (typeof url !== 'string' || url.length === 0) {
      throw new PersonaAdapterError(
        'session_url_missing',
        'Persona did not return a `meta.one-time-link` URL despite auto-create-one-time-link=true. The API key may lack the one-time-link create scope or the template is in draft.',
        { context: { inquiryId: parsed.data.data.id } },
      );
    }

    const expiresAt = new Date(this.#clock() + 24 * 60 * 60 * 1000).toISOString();
    return Object.freeze({
      sessionId: parsed.data.data.id,
      redirectUrl: url,
      expiresAt,
    });
  }

  /** {@inheritDoc KycProvider.fetchDecision} */
  async fetchDecision(sessionId: string): Promise<KycDecision> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new PersonaAdapterError('invalid_config', 'sessionId is required.');
    }

    const raw = await this.#request(
      'GET',
      `/api/v1/inquiries/${encodeURIComponent(sessionId)}?include=verifications`,
    );
    const parsed = InquiryResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PersonaAdapterError(
        'invalid_response',
        'Persona GET /api/v1/inquiries/{id} returned a body that failed schema validation.',
        { context: { issues: parsed.error.issues } },
      );
    }

    const verifications = this.#extractVerifications(raw);
    const expiryMs = this.#clock() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    return mapDecision(parsed.data.data, verifications, expiryMs);
  }

  /** {@inheritDoc KycProvider.verifyWebhook} */
  async verifyWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<KycWebhookEvent | null> {
    const sigHeader = getHeader(headers, 'persona-signature');
    if (typeof sigHeader !== 'string' || sigHeader.length === 0) {
      throw new PersonaAdapterError(
        'missing_signature_header',
        'Persona webhook is missing the Persona-Signature header.',
      );
    }
    const nowSeconds = Math.floor(this.#clock() / 1000);
    const valid = verifyPersonaSignatureHeader(this.#webhookSecret, rawBody, sigHeader, {
      driftSeconds: this.#webhookDriftSeconds,
      nowSeconds,
    });
    if (!valid) {
      throw new PersonaAdapterError(
        'invalid_signature',
        'Persona webhook Persona-Signature did not verify against the configured webhook secret (drift or signature mismatch).',
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch (cause) {
      throw new PersonaAdapterError('invalid_signature', 'Webhook body is not valid JSON.', {
        cause,
      });
    }
    const body = WebhookBodySchema.safeParse(parsedBody);
    if (!body.success) return null;

    const event = this.#mapWebhookEvent(body.data);
    if (event === null) return null;

    // Auto-enrich on terminal decisions. The webhook payload carries
    // the inquiry resource but verification relationships may be
    // partial; fetchDecision pulls the canonical view back.
    if (
      event.type === 'decision' &&
      (event.decision.status === 'approved' || event.decision.status === 'declined')
    ) {
      try {
        const enriched = await this.fetchDecision(event.decision.sessionId);
        return Object.freeze({ type: 'decision', decision: enriched });
      } catch {
        return event;
      }
    }
    return event;
  }

  /* ---------- private helpers ---------- */

  /**
   * Extract the hosted-flow URL from a Persona inquiry create response.
   * When `auto-create-one-time-link=true` is sent, the short URL is
   * returned at the response's top-level `meta.one-time-link`:
   *
   *   { "data": { ...inquiry... }, "meta": { "one-time-link": "https://..." } }
   */
  #extractOneTimeLinkUrl(raw: unknown): string | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const root = raw as { meta?: unknown };
    const meta = root.meta;
    if (typeof meta !== 'object' || meta === null) return undefined;
    const m = meta as { 'one-time-link'?: unknown };
    const url = m['one-time-link'];
    if (typeof url === 'string' && url.length > 0) return url;
    return undefined;
  }

  #extractVerifications(raw: unknown): readonly VerificationResource[] {
    if (typeof raw !== 'object' || raw === null) return [];
    const root = raw as { included?: unknown };
    const included = root.included;
    if (!Array.isArray(included)) return [];
    const result: VerificationResource[] = [];
    for (const entry of included) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as { type?: unknown };
      if (typeof e.type !== 'string') continue;
      if (!e.type.startsWith('verification/')) continue;
      const parsed = VerificationResourceSchema.safeParse(entry);
      if (parsed.success) result.push(parsed.data);
    }
    return result;
  }

  #mapWebhookEvent(body: import('./schemas').WebhookBody): KycWebhookEvent | null {
    const eventName = body.data.attributes.name;
    const inquiry = body.data.attributes.payload.data;

    // Treat expired and redacted notifications as session.expired.
    if (eventName === 'inquiry.expired' || eventName === 'inquiry.redacted') {
      return Object.freeze({
        type: 'session.expired',
        sessionId: inquiry.id,
        userRef: inquiry.attributes['reference-id'] ?? '',
      });
    }

    // Synthesize a decision from the inquiry payload alone for
    // non-terminal events. Terminal events (approved/declined/failed)
    // get auto-enriched in verifyWebhook() above.
    const includedRaw = body.data.attributes.payload.included;
    const verifications: VerificationResource[] = [];
    if (Array.isArray(includedRaw)) {
      for (const entry of includedRaw) {
        if (typeof entry !== 'object' || entry === null) continue;
        const e = entry as { type?: unknown };
        if (typeof e.type !== 'string') continue;
        if (!e.type.startsWith('verification/')) continue;
        const parsed = VerificationResourceSchema.safeParse(entry);
        if (parsed.success) verifications.push(parsed.data);
      }
    }

    const expiryMs = this.#clock() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    const decision = mapDecision(inquiry, verifications, expiryMs);
    return Object.freeze({ type: 'decision', decision });
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = `${this.#baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
        'Persona-Version': this.#personaVersion,
      };
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      }
      const res = await this.#fetch(url, init);
      if (res.status === 401 || res.status === 403) {
        throw new PersonaAdapterError(
          'unauthorized',
          `Persona ${method} ${path} returned ${res.status}.`,
        );
      }
      if (res.status === 404) {
        throw new PersonaAdapterError(
          'inquiry_not_found',
          `Persona ${method} ${path} returned 404.`,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new PersonaAdapterError(
          'http_error',
          `Persona ${method} ${path} returned ${res.status}.`,
          { context: { body: text.slice(0, 512) } },
        );
      }
      return await res.json();
    } catch (err) {
      if (err instanceof PersonaAdapterError) throw err;
      throw new PersonaAdapterError('http_error', `Persona ${method} ${path} failed.`, {
        cause: err,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
