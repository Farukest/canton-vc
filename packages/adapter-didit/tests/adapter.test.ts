/**
 * @canton-vc/adapter-didit — full test suite for the DiditAdapter.
 *
 * Covers all three KycProvider methods + edge cases:
 *  - startSession: workflow routing, callback + expectedFullName injection,
 *    fail-on-missing-workflow, schema-rejection on malformed response.
 *  - fetchDecision: full Didit status enum mapping → canton-vc status,
 *    level derivation from sub-block outcomes, evidence projection,
 *    proofHash determinism, unknown-status falls back to 'pending'.
 *  - verifyWebhook: HMAC signature acceptance, tampered signature
 *    rejection, stale timestamp rejection, missing-header rejection,
 *    decision vs session.expired event mapping.
 *
 * The adapter is exercised against a hand-rolled fetch stub — Didit's
 * real API isn't reachable from CI. The stub asserts the request shape
 * (URL, method, headers, body) so the adapter's wire contract is pinned.
 */

import { createHmac } from 'node:crypto';

import { canonicalJson } from '@canton-vc/core';
import { describe, expect, it } from 'vitest';

import { DiditAdapter, type DiditAdapterConfig } from '../src/adapter';
import { DiditAdapterError, isDiditAdapterError } from '../src/errors';

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

function signWebhook(secret: string, body: unknown): string {
  return createHmac('sha256', secret).update(canonicalJson(body)).digest('hex');
}

/* ---------- Fixtures ---------- */

const BASE_CONFIG = {
  apiKey: 'k_test_abc',
  webhookSecret: 'whs_test_xyz',
  kycWorkflowId: 'wf_kyc_001',
  addressWorkflowId: 'wf_address_001',
  baseUrl: 'https://stub.didit.local',
} as const;

const APPROVED_DECISION = {
  session_id: 'sess_abc',
  status: 'Approved',
  vendor_data: 'user-123',
  expires_at: '2027-01-01T00:00:00.000Z',
  // Didit V3 wire format: per-feature outcomes live in plural arrays.
  id_verifications: [{ status: 'Approved' }],
  liveness_checks: [{ status: 'Approved' }],
  face_matches: [{ status: 'Approved', score: 0.97 }],
  poa_verifications: [{ status: 'Approved' }],
} as const;

/* ---------- Constructor ---------- */

describe('DiditAdapter — constructor', () => {
  it('vendorName is "Didit"', () => {
    const adapter = new DiditAdapter({ ...BASE_CONFIG });
    expect(adapter.vendorName).toBe('Didit');
  });

  it('throws on missing apiKey', () => {
    expect(() =>
      new DiditAdapter({ ...BASE_CONFIG, apiKey: '' }),
    ).toThrow(DiditAdapterError);
  });

  it('throws on missing webhookSecret', () => {
    expect(() =>
      new DiditAdapter({ ...BASE_CONFIG, webhookSecret: '' }),
    ).toThrow(/webhookSecret is required/);
  });

  it('throws on missing kycWorkflowId', () => {
    expect(() =>
      new DiditAdapter({ ...BASE_CONFIG, kycWorkflowId: '' }),
    ).toThrow(/kycWorkflowId is required/);
  });

  it('strips trailing slashes from baseUrl', () => {
    const { fetch, calls } = makeFetchStub(() =>
      jsonResponse(200, { session_id: 's_1', url: 'https://didit.local/s_1' }),
    );
    const adapter = new DiditAdapter({
      ...BASE_CONFIG,
      baseUrl: 'https://stub.didit.local///',
      fetch,
    });
    return adapter.startSession({ userRef: 'u' }).then(() => {
      expect(calls[0]?.url).toBe('https://stub.didit.local/v3/session/');
    });
  });
});

/* ---------- startSession ---------- */

describe('DiditAdapter.startSession', () => {
  it('POSTs to /v3/session/ with workflow_id + vendor_data', async () => {
    const { fetch, calls } = makeFetchStub(() =>
      jsonResponse(200, {
        session_id: 'sess_new',
        url: 'https://didit.local/sess_new',
        expires_at: '2026-05-22T00:00:00.000Z',
      }),
    );
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const result = await adapter.startSession({ userRef: 'user-42' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://stub.didit.local/v3/session/');
    expect(calls[0]?.headers['X-Api-Key']).toBe('k_test_abc');
    expect(calls[0]?.body).toEqual({
      workflow_id: 'wf_kyc_001',
      vendor_data: 'user-42',
    });
    expect(result.sessionId).toBe('sess_new');
    expect(result.redirectUrl).toBe('https://didit.local/sess_new');
    expect(result.expiresAt).toBe('2026-05-22T00:00:00.000Z');
  });

  it('routes to addressWorkflowId when workflow="address"', async () => {
    const { fetch, calls } = makeFetchStub(() =>
      jsonResponse(200, { session_id: 'sess_addr', url: 'https://didit.local/sess_addr' }),
    );
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    await adapter.startSession({ userRef: 'u', workflow: 'address' });

    expect(calls[0]?.body).toMatchObject({ workflow_id: 'wf_address_001' });
  });

  it('throws if workflow="address" but addressWorkflowId is unset', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, { session_id: 's', url: 'https://x' }),
    );
    const { addressWorkflowId: _omit, ...configWithoutAddress } = BASE_CONFIG;
    void _omit;
    const adapter = new DiditAdapter({
      ...configWithoutAddress,
      fetch,
    });

    await expect(
      adapter.startSession({ userRef: 'u', workflow: 'address' }),
    ).rejects.toThrow(/addressWorkflowId is not configured/);
  });

  it('attaches callback URL when configured', async () => {
    const { fetch, calls } = makeFetchStub(() =>
      jsonResponse(200, { session_id: 's', url: 'https://x' }),
    );
    const adapter = new DiditAdapter({
      ...BASE_CONFIG,
      callbackUrl: 'https://your-issuer.com/kyc/callback',
      fetch,
    });

    await adapter.startSession({ userRef: 'u' });

    expect(calls[0]?.body).toMatchObject({
      callback: 'https://your-issuer.com/kyc/callback',
    });
  });

  it('injects expected_details for fuzzy name match', async () => {
    const { fetch, calls } = makeFetchStub(() =>
      jsonResponse(200, { session_id: 's', url: 'https://x' }),
    );
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    await adapter.startSession({
      userRef: 'u',
      expectedFullName: { first: 'Ada', last: 'Lovelace' },
    });

    expect(calls[0]?.body).toMatchObject({
      expected_details: { first_name: 'Ada', last_name: 'Lovelace' },
    });
  });

  it('defaults expiresAt when Didit omits it', async () => {
    const fixedNow = 1_700_000_000_000;
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, { session_id: 's', url: 'https://x' }),
    );
    const adapter = new DiditAdapter({
      ...BASE_CONFIG,
      fetch,
      clock: () => fixedNow,
    });

    const result = await adapter.startSession({ userRef: 'u' });

    // Defaults to 24h forward.
    const expected = new Date(fixedNow + 24 * 60 * 60 * 1000).toISOString();
    expect(result.expiresAt).toBe(expected);
  });

  it('throws DiditAdapterError on 401', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(401, { error: 'unauthorized' }));
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const err = await adapter.startSession({ userRef: 'u' }).catch((e) => e);
    expect(isDiditAdapterError(err)).toBe(true);
    expect((err as DiditAdapterError).code).toBe('unauthorized');
  });

  it('throws invalid_response on schema mismatch', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(200, { wat: true }));
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const err = await adapter.startSession({ userRef: 'u' }).catch((e) => e);
    expect(isDiditAdapterError(err)).toBe(true);
    expect((err as DiditAdapterError).code).toBe('invalid_response');
  });
});

/* ---------- fetchDecision ---------- */

describe('DiditAdapter.fetchDecision', () => {
  it('GETs /v3/session/{id}/decision/ with X-Api-Key', async () => {
    const { fetch, calls } = makeFetchStub(() => jsonResponse(200, APPROVED_DECISION));
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    await adapter.fetchDecision('sess_abc');

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://stub.didit.local/v3/session/sess_abc/decision/');
    expect(calls[0]?.headers['X-Api-Key']).toBe('k_test_abc');
  });

  it('URL-encodes the session id', async () => {
    const { fetch, calls } = makeFetchStub(() => jsonResponse(200, APPROVED_DECISION));
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    await adapter.fetchDecision('sess/with spaces');

    expect(calls[0]?.url).toBe(
      'https://stub.didit.local/v3/session/sess%2Fwith%20spaces/decision/',
    );
  });

  it('maps Approved → status="approved", level="enhanced" (kyc + address)', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(200, APPROVED_DECISION));
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('sess_abc');

    expect(decision.status).toBe('approved');
    expect(decision.level).toBe('enhanced');
    expect(decision.evidence.identityVerified).toBe(true);
    expect(decision.evidence.livenessVerified).toBe(true);
    expect(decision.evidence.addressVerified).toBe(true);
    expect(decision.evidence.humanScore).toBe(0.97);
    expect(decision.userRef).toBe('user-123');
  });

  it('maps Approved without address → level="basic"', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, {
        ...APPROVED_DECISION,
        // V3 wire format: clearing the PoA feature means an empty / null
        // array, not a singular "address_verification" field.
        poa_verifications: null,
      }),
    );
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('sess_abc');

    expect(decision.status).toBe('approved');
    expect(decision.level).toBe('basic');
    expect(decision.evidence.addressVerified).toBe(false);
  });

  it('maps Declined → status="declined", no level', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, {
        ...APPROVED_DECISION,
        status: 'Declined',
        kyc: { status: 'Declined' },
      }),
    );
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('sess_abc');

    expect(decision.status).toBe('declined');
    expect(decision.level).toBeUndefined();
  });

  it('maps Abandoned → status="declined"', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, { ...APPROVED_DECISION, status: 'Abandoned' }),
    );
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('sess_abc');
    expect(decision.status).toBe('declined');
  });

  it('maps In Review → status="in_review"', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, { ...APPROVED_DECISION, status: 'In Review' }),
    );
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('sess_abc');
    expect(decision.status).toBe('in_review');
  });

  it('maps Resubmitted → status="in_review"', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, { ...APPROVED_DECISION, status: 'Resubmitted' }),
    );
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('sess_abc');
    expect(decision.status).toBe('in_review');
  });

  it('maps Expired + Kyc Expired → status="expired"', async () => {
    const { fetch } = makeFetchStub((call) =>
      jsonResponse(200, {
        ...APPROVED_DECISION,
        status: call.url.endsWith('/x1/decision/') ? 'Expired' : 'Kyc Expired',
      }),
    );
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const d1 = await adapter.fetchDecision('x1');
    const d2 = await adapter.fetchDecision('x2');
    expect(d1.status).toBe('expired');
    expect(d2.status).toBe('expired');
  });

  it('maps unknown status conservatively → "pending"', async () => {
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, { ...APPROVED_DECISION, status: 'WhateverNewState' }),
    );
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('sess_abc');
    expect(decision.status).toBe('pending');
  });

  it('proofHash is deterministic for the same input', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(200, APPROVED_DECISION));
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const d1 = await adapter.fetchDecision('sess_abc');
    const d2 = await adapter.fetchDecision('sess_abc');
    expect(d1.proofHash).toBe(d2.proofHash);
    expect(d1.proofHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws session_not_found on 404', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(404, { error: 'not found' }));
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const err = await adapter.fetchDecision('sess_unknown').catch((e) => e);
    expect((err as DiditAdapterError).code).toBe('session_not_found');
  });

  it('throws http_error on 500', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(500, { error: 'boom' }));
    const adapter = new DiditAdapter({ ...BASE_CONFIG, fetch });

    const err = await adapter.fetchDecision('sess_abc').catch((e) => e);
    expect((err as DiditAdapterError).code).toBe('http_error');
  });
});

/* ---------- verifyWebhook ---------- */

describe('DiditAdapter.verifyWebhook', () => {
  const SECRET = 'whs_test_xyz';
  const NOW_SEC = 1_700_000_000;
  const NOW_MS = NOW_SEC * 1000;

  function makeAdapter(overrides: Partial<DiditAdapterConfig> = {}) {
    return new DiditAdapter({
      ...BASE_CONFIG,
      clock: () => NOW_MS,
      ...overrides,
    });
  }

  it('accepts a properly signed decision webhook', async () => {
    const body = {
      event_type: 'session.decision',
      session_id: 'sess_xyz',
      status: 'Approved',
      vendor_data: 'user-9',
      kyc: { status: 'Approved' },
      liveness: { status: 'Approved' },
      face_match: { status: 'Approved', score: 0.91 },
    };
    const raw = JSON.stringify(body);
    const sig = signWebhook(SECRET, body);

    // Terminal status webhooks trigger an auto-enrich GET to
    // /v3/session/{id}/decision/ so the returned KycDecision carries the
    // full evidence + level + proofHash. Stub the fetch with the standard
    // APPROVED_DECISION fixture (vendor_data must match `user-9` so the
    // userRef projection from the enriched response stays consistent
    // with the webhook event).
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, { ...APPROVED_DECISION, session_id: 'sess_xyz', vendor_data: 'user-9' }),
    );

    const adapter = makeAdapter({ fetch });
    const event = await adapter.verifyWebhook(raw, {
      'x-signature-v2': sig,
      'x-timestamp': String(NOW_SEC),
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe('decision');
    if (event?.type === 'decision') {
      expect(event.decision.status).toBe('approved');
      expect(event.decision.userRef).toBe('user-9');
      expect(event.decision.sessionId).toBe('sess_xyz');
    }
  });

  it('emits session.expired event when status is Expired', async () => {
    const body = {
      session_id: 'sess_old',
      status: 'Expired',
      vendor_data: 'user-7',
    };
    const sig = signWebhook(SECRET, body);

    const adapter = makeAdapter();
    const event = await adapter.verifyWebhook(JSON.stringify(body), {
      'x-signature-v2': sig,
      'x-timestamp': String(NOW_SEC),
    });

    expect(event?.type).toBe('session.expired');
    if (event?.type === 'session.expired') {
      expect(event.sessionId).toBe('sess_old');
      expect(event.userRef).toBe('user-7');
    }
  });

  it('rejects a tampered signature with invalid_signature', async () => {
    const body = { session_id: 's', status: 'Approved' };
    const sig = signWebhook('different-secret', body);

    const adapter = makeAdapter();
    const err = await adapter
      .verifyWebhook(JSON.stringify(body), {
        'x-signature-v2': sig,
        'x-timestamp': String(NOW_SEC),
      })
      .catch((e) => e);

    expect((err as DiditAdapterError).code).toBe('invalid_signature');
  });

  it('rejects a stale timestamp (>5 minutes drift)', async () => {
    const body = { session_id: 's', status: 'Approved' };
    const sig = signWebhook(SECRET, body);
    const staleTimestamp = NOW_SEC - 600; // 10 minutes ago

    const adapter = makeAdapter();
    const err = await adapter
      .verifyWebhook(JSON.stringify(body), {
        'x-signature-v2': sig,
        'x-timestamp': String(staleTimestamp),
      })
      .catch((e) => e);

    expect((err as DiditAdapterError).code).toBe('stale_signature');
  });

  it('accepts a timestamp inside the drift window (<= 5 min)', async () => {
    const body = { session_id: 's', status: 'Approved', vendor_data: 'u' };
    const sig = signWebhook(SECRET, body);
    const slightlyOld = NOW_SEC - 200; // 200s < 300s drift

    // Terminal-status webhooks trigger an auto-enrich fetchDecision()
    // call; stub it with the APPROVED_DECISION fixture so the test does
    // not reach the real Didit API (which would time out on macOS CI).
    const { fetch } = makeFetchStub(() =>
      jsonResponse(200, { ...APPROVED_DECISION, session_id: 's', vendor_data: 'u' }),
    );
    const adapter = makeAdapter({ fetch });
    const event = await adapter.verifyWebhook(JSON.stringify(body), {
      'x-signature-v2': sig,
      'x-timestamp': String(slightlyOld),
    });

    expect(event).not.toBeNull();
  });

  it('rejects missing X-Signature-V2 header', async () => {
    const adapter = makeAdapter();
    const err = await adapter
      .verifyWebhook('{}', { 'x-timestamp': String(NOW_SEC) })
      .catch((e) => e);
    expect((err as DiditAdapterError).code).toBe('missing_signature_header');
  });

  it('rejects missing X-Timestamp header', async () => {
    const body = { session_id: 's' };
    const sig = signWebhook(SECRET, body);

    const adapter = makeAdapter();
    const err = await adapter
      .verifyWebhook(JSON.stringify(body), { 'x-signature-v2': sig })
      .catch((e) => e);
    expect((err as DiditAdapterError).code).toBe('missing_signature_header');
  });

  it('rejects unparseable JSON body', async () => {
    const sig = signWebhook(SECRET, { x: 1 });
    const adapter = makeAdapter();

    const err = await adapter
      .verifyWebhook('not json', {
        'x-signature-v2': sig,
        'x-timestamp': String(NOW_SEC),
      })
      .catch((e) => e);
    expect((err as DiditAdapterError).code).toBe('invalid_signature');
  });

  it('signature comparison is constant-time (uses timingSafeEqual)', async () => {
    // This is more a behavioural pin than a strict timing assertion —
    // ensure two near-equal hex strings of different content still
    // result in invalid_signature (not a length-mismatch shortcut).
    const body = { session_id: 's', status: 'Approved' };
    const realSig = signWebhook(SECRET, body);
    const fakeSig = realSig.replace(/[0-9a-f]/, (c) =>
      c === '0' ? '1' : '0',
    );

    const adapter = makeAdapter();
    const err = await adapter
      .verifyWebhook(JSON.stringify(body), {
        'x-signature-v2': fakeSig,
        'x-timestamp': String(NOW_SEC),
      })
      .catch((e) => e);

    expect((err as DiditAdapterError).code).toBe('invalid_signature');
  });
});

/* ---------- Request timeout ---------- */

describe('DiditAdapter — request timeout', () => {
  it('aborts a slow request and surfaces http_error', async () => {
    // Real timers — fake timers + abort listener trigger spurious
    // "promise rejection handled asynchronously" warnings under
    // vitest@2's strict unhandled-rejection detector. The behaviour
    // we care about is: requestTimeoutMs elapses → AbortController
    // fires → fetch resolves to a thrown error → adapter wraps as
    // http_error. 50ms timeout + 20ms request budget is more than
    // enough on any CI runner.
    const slowFetch: typeof fetch = async (_input, init) => {
      await new Promise<void>((resolve) => {
        init?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted by AbortController');
    };
    const adapter = new DiditAdapter({
      ...BASE_CONFIG,
      requestTimeoutMs: 20,
      fetch: slowFetch,
    });

    const err = await adapter.fetchDecision('sess_abc').catch((e: unknown) => e);
    expect(isDiditAdapterError(err)).toBe(true);
    expect((err as DiditAdapterError).code).toBe('http_error');
  });
});
