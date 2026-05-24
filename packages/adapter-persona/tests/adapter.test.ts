/**
 * @canton-vc/adapter-persona — full test suite for the PersonaAdapter.
 *
 * Covers the three KycProvider methods plus the Persona-Signature
 * webhook parsing/verification surface:
 *
 *  - constructor: missing config validation, baseUrl normalisation.
 *  - parsePersonaSignatureHeader: single + multi-pair, garbage tolerance.
 *  - verifyPersonaSignatureHeader: valid HMAC, tampered digest rejected,
 *    expired timestamp rejected (drift window), key-rotation pair accepted.
 *  - startSession: identity vs address template routing, fields +
 *    redirect-uri + locale injection, schema rejection on malformed
 *    response, missing session URL error.
 *  - fetchDecision: full inquiry status enum mapping, verification
 *    type classification (government-id / selfie / database / document),
 *    evidence projection, level derivation from passing verifications,
 *    declined → declineReason, partial verifications.
 *  - verifyWebhook: signature acceptance, missing header rejection,
 *    invalid signature rejection, inquiry.expired → session.expired,
 *    inquiry.approved → auto-enriched decision via fetchDecision.
 *
 * Persona's API isn't reachable from CI — the adapter runs against
 * a hand-rolled fetch stub that asserts URL/method/headers/body so
 * the wire contract is pinned in tests.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PersonaAdapter } from '../src/adapter';
import { isPersonaAdapterError, PersonaAdapterError } from '../src/errors';
import {
  parsePersonaSignatureHeader,
  verifyPersonaSignatureHeader,
  verifyPersonaSignaturePair,
} from '../src/hmac';
import { classifyVerification, PERSONA_INQUIRY_STATUS } from '../src/schemas';

/* ---------- Fetch stub helpers ---------- */

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function makeFetchStub(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    const body = init?.body !== undefined ? JSON.parse(init.body as string) : undefined;
    const call: FetchCall = { url, method, headers, body };
    calls.push(call);
    return handler(call);
  };
  return { fetch: stub, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ---------- Fixtures ---------- */

const BASE_CONFIG = {
  apiKey: 'persona_sandbox_test_key',
  webhookSecret: 'whsec_test',
  identityTemplateId: 'itmpl_aaaaaaaaaaaaaaaaaaaaaaaa',
  addressTemplateId: 'itmpl_bbbbbbbbbbbbbbbbbbbbbbbb',
};

function buildInquiryResponse(opts: {
  status?: string | undefined;
  referenceId?: string | undefined;
  verifications?: ReadonlyArray<{ type: string; status: string }> | undefined;
  /** Hosted-flow URL placed at top-level `meta.one-time-link`. */
  oneTimeLink?: string | undefined;
  inquiryId?: string | undefined;
}) {
  const inquiryId = opts.inquiryId ?? 'inq_abc123';
  const verifications = opts.verifications ?? [];
  const included: unknown[] = [];
  for (const [i, v] of verifications.entries()) {
    included.push({
      type: v.type,
      id: `ver_${i}`,
      attributes: {
        status: v.status,
        'created-at': '2026-01-01T00:00:00Z',
      },
    });
  }
  const body: Record<string, unknown> = {
    data: {
      type: 'inquiry',
      id: inquiryId,
      attributes: {
        status: opts.status ?? 'created',
        'reference-id': opts.referenceId ?? null,
        'created-at': '2026-01-01T00:00:00Z',
      },
      relationships: {
        verifications: {
          data: verifications.map((_, i) => ({ type: 'verification', id: `ver_${i}` })),
        },
      },
    },
    included,
  };
  if (opts.oneTimeLink !== undefined) {
    body['meta'] = { 'one-time-link': opts.oneTimeLink };
  }
  return body;
}

/* =====================================================================
 * Constructor
 * ===================================================================== */

describe('PersonaAdapter — constructor', () => {
  it('rejects missing apiKey', () => {
    expect(() => new PersonaAdapter({ ...BASE_CONFIG, apiKey: '' })).toThrow(PersonaAdapterError);
  });

  it('rejects missing webhookSecret', () => {
    expect(
      () => new PersonaAdapter({ ...BASE_CONFIG, webhookSecret: '' }),
    ).toThrow(PersonaAdapterError);
  });

  it('rejects missing identityTemplateId', () => {
    expect(
      () => new PersonaAdapter({ ...BASE_CONFIG, identityTemplateId: '' }),
    ).toThrow(PersonaAdapterError);
  });

  it('accepts minimal valid config without addressTemplateId', () => {
    const adapter = new PersonaAdapter({
      apiKey: BASE_CONFIG.apiKey,
      webhookSecret: BASE_CONFIG.webhookSecret,
      identityTemplateId: BASE_CONFIG.identityTemplateId,
    });
    expect(adapter.vendorName).toBe('Persona');
  });

  it('vendorName is "Persona"', () => {
    const adapter = new PersonaAdapter(BASE_CONFIG);
    expect(adapter.vendorName).toBe('Persona');
  });

  it('strips trailing slashes from baseUrl', async () => {
    const { fetch, calls } = makeFetchStub(() =>
      jsonResponse(
        200,
        buildInquiryResponse({
          status: 'created',
          referenceId: 'u',
          oneTimeLink: 'https://hosted.test/x',
        }),
      ),
    );
    const adapter = new PersonaAdapter({
      ...BASE_CONFIG,
      baseUrl: 'https://custom.test///',
      fetch,
    });
    await adapter.startSession({ userRef: 'u1' });
    expect(calls[0]?.url).toBe('https://custom.test/api/v1/inquiries');
  });
});

/* =====================================================================
 * HMAC: parsePersonaSignatureHeader
 * ===================================================================== */

describe('parsePersonaSignatureHeader', () => {
  it('parses a single t=,v1= pair', () => {
    const pairs = parsePersonaSignatureHeader('t=1700000000,v1=deadbeef');
    expect(pairs).toEqual([{ timestamp: '1700000000', signatureHex: 'deadbeef' }]);
  });

  it('parses two space-separated pairs (key rotation)', () => {
    const pairs = parsePersonaSignatureHeader(
      't=1700000000,v1=aaaa t=1700000001,v1=bbbb',
    );
    expect(pairs).toHaveLength(2);
    expect(pairs?.[0]?.signatureHex).toBe('aaaa');
    expect(pairs?.[1]?.signatureHex).toBe('bbbb');
  });

  it('returns null on empty header', () => {
    expect(parsePersonaSignatureHeader('')).toBeNull();
    expect(parsePersonaSignatureHeader('   ')).toBeNull();
  });

  it('returns null when no parseable pair present', () => {
    expect(parsePersonaSignatureHeader('garbage')).toBeNull();
    expect(parsePersonaSignatureHeader('t=,v1=')).toBeNull();
  });

  it('tolerates extra fields in a pair', () => {
    const pairs = parsePersonaSignatureHeader('v0=ignored,t=42,v1=abcd,extra=x');
    expect(pairs).toEqual([{ timestamp: '42', signatureHex: 'abcd' }]);
  });
});

/* =====================================================================
 * HMAC: verifyPersonaSignaturePair + verifyPersonaSignatureHeader
 * ===================================================================== */

function signPersonaWebhook(secret: string, ts: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

describe('verifyPersonaSignaturePair', () => {
  it('verifies a correctly-signed pair', () => {
    const ts = '1700000000';
    const body = '{"hello":"world"}';
    const sig = signPersonaWebhook('whsec_x', ts, body);
    expect(
      verifyPersonaSignaturePair('whsec_x', body, { timestamp: ts, signatureHex: sig }),
    ).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const ts = '1700000000';
    const body = '{"hello":"world"}';
    const sig = signPersonaWebhook('whsec_x', ts, body);
    const tampered = `${sig.slice(0, -2)}ff`;
    expect(
      verifyPersonaSignaturePair('whsec_x', body, {
        timestamp: ts,
        signatureHex: tampered,
      }),
    ).toBe(false);
  });

  it('rejects when secret is wrong', () => {
    const ts = '1700000000';
    const body = '{}';
    const sig = signPersonaWebhook('whsec_x', ts, body);
    expect(
      verifyPersonaSignaturePair('whsec_other', body, {
        timestamp: ts,
        signatureHex: sig,
      }),
    ).toBe(false);
  });
});

describe('verifyPersonaSignatureHeader', () => {
  it('verifies a fresh single-pair header', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"x":1}';
    const sig = signPersonaWebhook('whsec_a', ts, body);
    expect(
      verifyPersonaSignatureHeader('whsec_a', body, `t=${ts},v1=${sig}`, {
        nowSeconds: Number.parseInt(ts, 10),
      }),
    ).toBe(true);
  });

  it('rejects a stale (>drift) timestamp', () => {
    const oldTs = '1000000000';
    const body = '{}';
    const sig = signPersonaWebhook('whsec_a', oldTs, body);
    expect(
      verifyPersonaSignatureHeader('whsec_a', body, `t=${oldTs},v1=${sig}`, {
        nowSeconds: 1_700_000_000,
        driftSeconds: 300,
      }),
    ).toBe(false);
  });

  it('accepts when ANY pair in a multi-pair header verifies (rotation)', () => {
    const now = Math.floor(Date.now() / 1000);
    const ts = String(now);
    const body = '{"rotated":true}';
    const goodSig = signPersonaWebhook('whsec_new', ts, body);
    const header = `t=${ts},v1=badbadbadbad t=${ts},v1=${goodSig}`;
    expect(
      verifyPersonaSignatureHeader('whsec_new', body, header, { nowSeconds: now }),
    ).toBe(true);
  });

  it('rejects when all pairs fail to verify', () => {
    const now = Math.floor(Date.now() / 1000);
    const ts = String(now);
    const header = `t=${ts},v1=00 t=${ts},v1=11`;
    expect(verifyPersonaSignatureHeader('whsec_z', '{}', header, { nowSeconds: now })).toBe(
      false,
    );
  });

  it('returns false for empty/garbage header', () => {
    expect(verifyPersonaSignatureHeader('whsec', '{}', '')).toBe(false);
    expect(verifyPersonaSignatureHeader('whsec', '{}', 'lol')).toBe(false);
  });
});

/* =====================================================================
 * classifyVerification
 * ===================================================================== */

describe('classifyVerification', () => {
  it('maps government-id types', () => {
    expect(classifyVerification('verification/government-id')).toBe('government-id');
    expect(classifyVerification('verification/government-id-nfc')).toBe('government-id');
  });

  it('maps selfie types', () => {
    expect(classifyVerification('verification/selfie')).toBe('selfie');
    expect(classifyVerification('verification/selfie-photo')).toBe('selfie');
  });

  it('maps database family to database', () => {
    expect(classifyVerification('verification/database')).toBe('database');
    expect(classifyVerification('verification/database-standard')).toBe('database');
    expect(classifyVerification('verification/aamva')).toBe('database');
  });

  it('maps phone-carrier separately (not address)', () => {
    expect(classifyVerification('verification/database-phone-carrier')).toBe('phone-carrier');
  });

  it('maps document types', () => {
    expect(classifyVerification('verification/document')).toBe('document');
  });

  it('returns other for unknown types', () => {
    expect(classifyVerification('verification/future-thing')).toBe('other');
    expect(classifyVerification('not-a-verification')).toBe('other');
  });
});

/* =====================================================================
 * startSession
 * ===================================================================== */

describe('PersonaAdapter — startSession', () => {
  it('POSTs to /api/v1/inquiries with the identity template by default', async () => {
    const { fetch, calls } = makeFetchStub(() =>
      jsonResponse(
        200,
        buildInquiryResponse({
          status: 'created',
          referenceId: 'u1',
          oneTimeLink: 'https://hosted.withpersona.com/x',
        }),
      ),
    );
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    const session = await adapter.startSession({ userRef: 'u1' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe('https://api.withpersona.com/api/v1/inquiries');
    expect(call?.method).toBe('POST');
    expect(call?.headers['Authorization']).toBe('Bearer persona_sandbox_test_key');
    expect(call?.headers['Persona-Version']).toBeDefined();
    expect(call?.headers['Content-Type']).toBe('application/json');
    const body = call?.body as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes['inquiry-template-id']).toBe(BASE_CONFIG.identityTemplateId);
    expect(body.data.attributes['reference-id']).toBe('u1');
    expect(session.sessionId).toBe('inq_abc123');
    expect(session.redirectUrl).toBe('https://hosted.withpersona.com/x');
  });

  it('routes to the address template when workflow=address', async () => {
    const { fetch, calls } = makeFetchStub(() =>
      jsonResponse(
        200,
        buildInquiryResponse({
          status: 'created',
          referenceId: 'u2',
          oneTimeLink: 'https://hosted.withpersona.com/y',
        }),
      ),
    );
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    await adapter.startSession({ userRef: 'u2', workflow: 'address' });
    const body = calls[0]?.body as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes['inquiry-template-id']).toBe(BASE_CONFIG.addressTemplateId);
  });

  it('throws when address workflow requested but addressTemplateId is absent', async () => {
    const adapter = new PersonaAdapter({
      apiKey: BASE_CONFIG.apiKey,
      webhookSecret: BASE_CONFIG.webhookSecret,
      identityTemplateId: BASE_CONFIG.identityTemplateId,
    });
    await expect(adapter.startSession({ userRef: 'u', workflow: 'address' })).rejects.toThrow(
      PersonaAdapterError,
    );
  });

  it('rejects empty userRef', async () => {
    const adapter = new PersonaAdapter(BASE_CONFIG);
    await expect(adapter.startSession({ userRef: '' })).rejects.toThrow(PersonaAdapterError);
  });

  it('injects redirect-uri + expectedFullName + locale', async () => {
    const { fetch, calls } = makeFetchStub(() =>
      jsonResponse(
        200,
        buildInquiryResponse({
          status: 'created',
          referenceId: 'u3',
          oneTimeLink: 'https://hosted.withpersona.com/z',
        }),
      ),
    );
    const adapter = new PersonaAdapter({
      ...BASE_CONFIG,
      redirectUri: 'https://app.test/cb',
      fetch,
    });
    await adapter.startSession({
      userRef: 'u3',
      expectedFullName: { first: 'Ada', last: 'Lovelace' },
      locale: 'en',
    });
    const body = calls[0]?.body as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes['redirect-uri']).toBe('https://app.test/cb');
    expect(body.data.attributes['fields']).toEqual({
      'name-first': 'Ada',
      'name-last': 'Lovelace',
    });
    expect(body.data.attributes['locale']).toBe('en');
  });

  it('throws session_url_missing when included[] has no inquiry-session', async () => {
    const { fetch } = makeFetchStub(() =>
      // No oneTimeLink → included is empty
      jsonResponse(200, buildInquiryResponse({ status: 'created', referenceId: 'u' })),
    );
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    await expect(adapter.startSession({ userRef: 'u' })).rejects.toMatchObject({
      code: 'session_url_missing',
    });
  });

  it('throws invalid_response on malformed schema', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(200, { not: 'json:api' }));
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    await expect(adapter.startSession({ userRef: 'u' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('throws unauthorized on 401', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(401, { errors: [{ title: 'nope' }] }));
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    await expect(adapter.startSession({ userRef: 'u' })).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

/* =====================================================================
 * fetchDecision
 * ===================================================================== */

describe('PersonaAdapter — fetchDecision', () => {
  it('GETs /api/v1/inquiries/{id}?include=verifications', async () => {
    const { fetch, calls } = makeFetchStub(() =>
      jsonResponse(
        200,
        buildInquiryResponse({
          status: 'approved',
          referenceId: 'u1',
          verifications: [
            { type: 'verification/government-id', status: 'passed' },
            { type: 'verification/selfie', status: 'passed' },
          ],
        }),
      ),
    );
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    const d = await adapter.fetchDecision('inq_abc123');
    expect(calls[0]?.url).toBe(
      'https://api.withpersona.com/api/v1/inquiries/inq_abc123?include=verifications',
    );
    expect(calls[0]?.method).toBe('GET');
    expect(d.status).toBe('approved');
    expect(d.evidence.identityVerified).toBe(true);
    expect(d.evidence.livenessVerified).toBe(true);
    expect(d.evidence.addressVerified).toBe(false);
    expect(d.level).toBe('basic');
  });

  it('derives level=enhanced when address verification passes', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(
        200,
        buildInquiryResponse({
          status: 'approved',
          referenceId: 'u1',
          verifications: [
            { type: 'verification/government-id', status: 'passed' },
            { type: 'verification/selfie', status: 'passed' },
            { type: 'verification/database-standard', status: 'passed' },
          ],
        }),
      ),
    );
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    const d = await adapter.fetchDecision('inq_x');
    expect(d.level).toBe('enhanced');
    expect(d.evidence.addressVerified).toBe(true);
  });

  it('maps declined inquiry to status=declined with declineReason=other', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(
        200,
        buildInquiryResponse({
          status: 'declined',
          referenceId: 'u',
          verifications: [{ type: 'verification/government-id', status: 'failed' }],
        }),
      ),
    );
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    const d = await adapter.fetchDecision('inq_d');
    expect(d.status).toBe('declined');
    expect(d.declineReason).toBe('other');
    // evidence is forced false on non-approved outcomes
    expect(d.evidence.identityVerified).toBe(false);
  });

  it('maps expired inquiry to status=expired', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, buildInquiryResponse({ status: 'expired', referenceId: 'u' })),
    );
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    const d = await adapter.fetchDecision('inq_e');
    expect(d.status).toBe('expired');
  });

  it('maps needs_review to status=in_review', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, buildInquiryResponse({ status: 'needs_review', referenceId: 'u' })),
    );
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    const d = await adapter.fetchDecision('inq_r');
    expect(d.status).toBe('in_review');
  });

  it('maps created to status=pending', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, buildInquiryResponse({ status: 'created', referenceId: 'u' })),
    );
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    const d = await adapter.fetchDecision('inq_c');
    expect(d.status).toBe('pending');
  });

  it('falls back to pending for unknown status strings (forward-compat)', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(
        200,
        buildInquiryResponse({ status: 'future_unknown_status', referenceId: 'u' }),
      ),
    );
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    const d = await adapter.fetchDecision('inq_u');
    expect(d.status).toBe('pending');
  });

  it('computes proofHash as a 64-char hex SHA-256', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(
        200,
        buildInquiryResponse({
          status: 'approved',
          referenceId: 'u',
          verifications: [
            { type: 'verification/government-id', status: 'passed' },
            { type: 'verification/selfie', status: 'passed' },
          ],
        }),
      ),
    );
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    const d = await adapter.fetchDecision('inq_x');
    expect(d.proofHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects empty sessionId', async () => {
    const adapter = new PersonaAdapter(BASE_CONFIG);
    await expect(adapter.fetchDecision('')).rejects.toThrow(PersonaAdapterError);
  });

  it('translates 404 → inquiry_not_found', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(404, { errors: [] }));
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    await expect(adapter.fetchDecision('inq_missing')).rejects.toMatchObject({
      code: 'inquiry_not_found',
    });
  });
});

/* =====================================================================
 * verifyWebhook
 * ===================================================================== */

describe('PersonaAdapter — verifyWebhook', () => {
  function buildEventBody(opts: {
    name: string;
    inquiryStatus: string;
    referenceId?: string;
    verifications?: ReadonlyArray<{ type: string; status: string }>;
  }) {
    const inner = buildInquiryResponse({
      status: opts.inquiryStatus,
      referenceId: opts.referenceId,
      verifications: opts.verifications,
    });
    return {
      data: {
        type: 'event',
        id: 'evt_xxx',
        attributes: {
          name: opts.name,
          payload: inner,
        },
      },
    };
  }

  function signAndHeader(body: string, secret: string, nowSeconds: number): string {
    const sig = createHmac('sha256', secret).update(`${nowSeconds}.${body}`).digest('hex');
    return `t=${nowSeconds},v1=${sig}`;
  }

  it('throws when Persona-Signature header is absent', async () => {
    const adapter = new PersonaAdapter(BASE_CONFIG);
    await expect(adapter.verifyWebhook('{}', {})).rejects.toMatchObject({
      code: 'missing_signature_header',
    });
  });

  it('throws invalid_signature on tampered digest', async () => {
    const adapter = new PersonaAdapter(BASE_CONFIG);
    const rawBody = '{"data":{}}';
    const now = Math.floor(Date.now() / 1000);
    const header = `t=${now},v1=00`;
    await expect(
      adapter.verifyWebhook(rawBody, { 'Persona-Signature': header }),
    ).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  it('returns session.expired on inquiry.expired event', async () => {
    const adapter = new PersonaAdapter(BASE_CONFIG);
    const body = JSON.stringify(
      buildEventBody({ name: 'inquiry.expired', inquiryStatus: 'expired', referenceId: 'u' }),
    );
    const now = Math.floor(Date.now() / 1000);
    const event = await adapter.verifyWebhook(body, {
      'Persona-Signature': signAndHeader(body, BASE_CONFIG.webhookSecret, now),
    });
    expect(event?.type).toBe('session.expired');
    if (event?.type !== 'session.expired') throw new Error('expected session.expired');
    expect(event.userRef).toBe('u');
  });

  it('auto-enriches inquiry.approved by calling fetchDecision', async () => {
    const enrichedBody = buildInquiryResponse({
      status: 'approved',
      referenceId: 'u',
      verifications: [
        { type: 'verification/government-id', status: 'passed' },
        { type: 'verification/selfie', status: 'passed' },
        { type: 'verification/database-standard', status: 'passed' },
      ],
    });
    const { fetch } = makeFetchStub(() => jsonResponse(200, enrichedBody));
    const adapter = new PersonaAdapter({ ...BASE_CONFIG, fetch });
    const rawBody = JSON.stringify(
      buildEventBody({
        name: 'inquiry.approved',
        inquiryStatus: 'approved',
        referenceId: 'u',
      }),
    );
    const now = Math.floor(Date.now() / 1000);
    const event = await adapter.verifyWebhook(rawBody, {
      'Persona-Signature': signAndHeader(rawBody, BASE_CONFIG.webhookSecret, now),
    });
    if (event === null || event.type !== 'decision') throw new Error('expected decision');
    expect(event.decision.status).toBe('approved');
    // The enriched call surfaces the address verification (only present in
    // the enrich response, not in the synthetic webhook payload).
    expect(event.decision.level).toBe('enhanced');
  });

  it('accepts the lower-cased persona-signature header alias', async () => {
    const adapter = new PersonaAdapter(BASE_CONFIG);
    const body = JSON.stringify(
      buildEventBody({ name: 'inquiry.expired', inquiryStatus: 'expired', referenceId: 'u' }),
    );
    const now = Math.floor(Date.now() / 1000);
    const event = await adapter.verifyWebhook(body, {
      'persona-signature': signAndHeader(body, BASE_CONFIG.webhookSecret, now),
    });
    expect(event?.type).toBe('session.expired');
  });
});

/* =====================================================================
 * isPersonaAdapterError
 * ===================================================================== */

describe('isPersonaAdapterError', () => {
  it('narrows PersonaAdapterError', () => {
    const err = new PersonaAdapterError('invalid_config', 'oops');
    expect(isPersonaAdapterError(err)).toBe(true);
  });
  it('returns false for plain Errors', () => {
    expect(isPersonaAdapterError(new Error('x'))).toBe(false);
  });
  it('returns false for non-Error values', () => {
    expect(isPersonaAdapterError(null)).toBe(false);
    expect(isPersonaAdapterError('err')).toBe(false);
  });
});

/* =====================================================================
 * PERSONA_INQUIRY_STATUS constants
 * ===================================================================== */

describe('PERSONA_INQUIRY_STATUS', () => {
  it('exposes the full enum surface', () => {
    expect(PERSONA_INQUIRY_STATUS.CREATED).toBe('created');
    expect(PERSONA_INQUIRY_STATUS.APPROVED).toBe('approved');
    expect(PERSONA_INQUIRY_STATUS.DECLINED).toBe('declined');
    expect(PERSONA_INQUIRY_STATUS.EXPIRED).toBe('expired');
    expect(PERSONA_INQUIRY_STATUS.NEEDS_REVIEW).toBe('needs_review');
  });
});
