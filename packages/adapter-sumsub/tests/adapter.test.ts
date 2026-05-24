/**
 * @canton-vc/adapter-sumsub — full test suite for the SumsubAdapter.
 *
 * Covers all three KycProvider methods + the Sumsub-specific HMAC
 * request signing surface:
 *
 *  - constructor: missing config validation, baseUrl normalisation.
 *  - signSumsubRequest: deterministic, matches known fixture, wire
 *    contract pinned (the format Sumsub documents in their HMAC docs).
 *  - startSession: identity vs address level routing, fixedInfo +
 *    locale injection, fail-on-missing-level, schema reject on
 *    malformed response.
 *  - fetchDecision: full reviewStatus enum mapping → canton-vc status,
 *    level derivation from applied level, evidence projection,
 *    declineReason from reject labels, GREEN/RED/RETRY/FINAL matrix.
 *  - verifyWebhook: HMAC over raw body acceptance, tampered digest
 *    rejection, unsupported algorithm rejection, applicantDeleted →
 *    session.expired, applicantReviewed GREEN → auto-enriched
 *    decision.
 *
 * The adapter runs against a hand-rolled fetch stub — Sumsub's API
 * isn't reachable from CI. The stub asserts request URL/method/
 * headers/body so the adapter's wire contract is pinned in tests.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SumsubAdapter } from '../src/adapter';
import { isSumsubAdapterError, SumsubAdapterError } from '../src/errors';
import {
  isSupportedWebhookAlg,
  signSumsubRequest,
  verifySumsubWebhookDigest,
} from '../src/hmac';

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
  appToken: 'sbx:test_token.aaaaaa',
  secretKey: 'sk_test_xyz',
  webhookSecret: 'whs_test_abc',
  identityLevelName: 'basic-kyc-level',
  addressLevelName: 'enhanced-poa-level',
  baseUrl: 'https://stub.sumsub.local',
  clock: () => 1_700_000_000_000,
} as const;

const APPROVED_STATUS = {
  reviewStatus: 'completed',
  reviewResult: {
    reviewAnswer: 'GREEN',
    rejectLabels: [],
    reviewRejectType: undefined,
  },
} as const;

const DECLINED_STATUS_FINAL = {
  reviewStatus: 'completed',
  reviewResult: {
    reviewAnswer: 'RED',
    rejectLabels: ['FORGERY'],
    reviewRejectType: 'FINAL',
  },
} as const;

const DECLINED_STATUS_RETRY = {
  reviewStatus: 'completed',
  reviewResult: {
    reviewAnswer: 'RED',
    rejectLabels: ['BAD_PHOTO'],
    reviewRejectType: 'RETRY',
  },
} as const;

const LOOKUP_IDENTITY_LEVEL = {
  id: 'app_abc',
  externalUserId: 'user-123',
  review: { levelName: 'basic-kyc-level' },
} as const;

const LOOKUP_ADDRESS_LEVEL = {
  id: 'app_abc',
  externalUserId: 'user-123',
  review: { levelName: 'enhanced-poa-level' },
} as const;

/* ---------- Constructor ---------- */

describe('SumsubAdapter — constructor', () => {
  it('vendorName is "Sumsub"', () => {
    const adapter = new SumsubAdapter({ ...BASE_CONFIG });
    expect(adapter.vendorName).toBe('Sumsub');
  });

  it('throws on missing appToken', () => {
    expect(() => new SumsubAdapter({ ...BASE_CONFIG, appToken: '' })).toThrow(
      SumsubAdapterError,
    );
  });

  it('throws on missing secretKey', () => {
    expect(() => new SumsubAdapter({ ...BASE_CONFIG, secretKey: '' })).toThrow(
      /secretKey is required/,
    );
  });

  it('throws on missing webhookSecret', () => {
    expect(() => new SumsubAdapter({ ...BASE_CONFIG, webhookSecret: '' })).toThrow(
      /webhookSecret is required/,
    );
  });

  it('throws on missing identityLevelName', () => {
    expect(() => new SumsubAdapter({ ...BASE_CONFIG, identityLevelName: '' })).toThrow(
      /identityLevelName is required/,
    );
  });

  it('isSumsubAdapterError type guard', () => {
    const err = new SumsubAdapterError('invalid_config', 'msg');
    expect(isSumsubAdapterError(err)).toBe(true);
    expect(isSumsubAdapterError(new Error('plain'))).toBe(false);
  });
});

/* ---------- signSumsubRequest ---------- */

describe('signSumsubRequest', () => {
  it('matches the HMAC fixture Sumsub documents', () => {
    // Sumsub docs: HMAC-SHA256(secret, ts + method + path + body), hex.
    // We recompute the expected value with Node's crypto so the test
    // pins the canonical formula exactly as the adapter applies it.
    const secret = 'super_secret';
    const ts = '1700000000';
    const method = 'POST';
    const path = '/resources/applicants?levelName=basic';
    const body = '{"externalUserId":"u-1"}';
    const expected = createHmac('sha256', secret).update(`${ts}${method}${path}${body}`).digest('hex');
    expect(signSumsubRequest(secret, ts, method, path, body)).toBe(expected);
  });

  it('is deterministic across calls', () => {
    const a = signSumsubRequest('s', '1', 'GET', '/p', '');
    const b = signSumsubRequest('s', '1', 'GET', '/p', '');
    expect(a).toBe(b);
  });

  it('different timestamps produce different signatures', () => {
    const a = signSumsubRequest('s', '1', 'GET', '/p', '');
    const b = signSumsubRequest('s', '2', 'GET', '/p', '');
    expect(a).not.toBe(b);
  });
});

/* ---------- verifySumsubWebhookDigest ---------- */

describe('verifySumsubWebhookDigest', () => {
  it('accepts a digest signed with the matching algorithm', () => {
    const body = '{"applicantId":"a","type":"applicantReviewed"}';
    const sig = createHmac('sha256', 'whs').update(body).digest('hex');
    expect(verifySumsubWebhookDigest('whs', body, sig, 'HMAC_SHA256_HEX')).toBe(true);
  });

  it('rejects a tampered digest', () => {
    const body = '{"applicantId":"a"}';
    const sig = createHmac('sha256', 'whs').update(body).digest('hex');
    const tampered = `${sig.slice(0, -1)}0`;
    expect(verifySumsubWebhookDigest('whs', body, tampered, 'HMAC_SHA256_HEX')).toBe(false);
  });

  it('rejects when length differs', () => {
    expect(verifySumsubWebhookDigest('whs', 'body', 'abc', 'HMAC_SHA256_HEX')).toBe(false);
  });

  it('supports SHA1 and SHA512', () => {
    const body = 'payload';
    const sig1 = createHmac('sha1', 'whs').update(body).digest('hex');
    const sig512 = createHmac('sha512', 'whs').update(body).digest('hex');
    expect(verifySumsubWebhookDigest('whs', body, sig1, 'HMAC_SHA1_HEX')).toBe(true);
    expect(verifySumsubWebhookDigest('whs', body, sig512, 'HMAC_SHA512_HEX')).toBe(true);
  });

  it('isSupportedWebhookAlg recognises documented algorithms', () => {
    expect(isSupportedWebhookAlg('HMAC_SHA256_HEX')).toBe(true);
    expect(isSupportedWebhookAlg('HMAC_SHA1_HEX')).toBe(true);
    expect(isSupportedWebhookAlg('HMAC_SHA512_HEX')).toBe(true);
    expect(isSupportedWebhookAlg('HMAC_MD5_HEX')).toBe(false);
    expect(isSupportedWebhookAlg(undefined)).toBe(false);
  });
});

/* ---------- startSession ---------- */

describe('SumsubAdapter.startSession', () => {
  it('creates applicant at identity level + fetches WebSDK link', async () => {
    const { fetch, calls } = makeFetchStub((call) => {
      if (call.url.includes('/resources/applicants?levelName=basic-kyc-level')) {
        return jsonResponse(200, { id: 'app_new', externalUserId: 'user-x' });
      }
      if (call.url.includes('/resources/sdkIntegrations/levels/basic-kyc-level/websdkLink')) {
        return jsonResponse(200, { url: 'https://websdk.sumsub.com/abc' });
      }
      return jsonResponse(404, {});
    });
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const session = await adapter.startSession({ userRef: 'user-x' });

    expect(session.sessionId).toBe('app_new');
    expect(session.redirectUrl).toBe('https://websdk.sumsub.com/abc');
    expect(session.expiresAt).toMatch(/^\d{4}-/);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ externalUserId: 'user-x' });
    expect(calls[0]?.headers['X-App-Token']).toBe(BASE_CONFIG.appToken);
    expect(calls[0]?.headers['X-App-Access-Sig']).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]?.headers['X-App-Access-Ts']).toBe(
      Math.floor(BASE_CONFIG.clock() / 1000).toString(),
    );
  });

  it('routes to address level when workflow="address"', async () => {
    const { fetch, calls } = makeFetchStub((call) => {
      // Both /applicants and /sdkIntegrations/levels/.../websdkLink
      // carry the level in URL form. /applicants uses `?levelName=...`,
      // /sdkIntegrations uses `/levels/{level}/...`.
      if (call.method === 'POST' && call.url.includes('websdkLink')) {
        return jsonResponse(200, { url: 'https://websdk.sumsub.com/poa' });
      }
      if (call.method === 'POST' && call.url.includes('/resources/applicants')) {
        return jsonResponse(200, { id: 'app_poa' });
      }
      return jsonResponse(404, {});
    });
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const session = await adapter.startSession({ userRef: 'user-x', workflow: 'address' });

    expect(session.sessionId).toBe('app_poa');
    expect(calls.every((c) => c.url.includes('enhanced-poa-level'))).toBe(true);
  });

  it('throws when address workflow requested but addressLevelName missing', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(404, {}));
    // exactOptionalPropertyTypes — destructure-omit instead of `undefined`.
    const { addressLevelName: _omit, ...rest } = BASE_CONFIG;
    const adapter = new SumsubAdapter({ ...rest, fetch });

    await expect(
      adapter.startSession({ userRef: 'user-x', workflow: 'address' }),
    ).rejects.toThrow(/addressLevelName is not configured/);
  });

  it('threads expectedFullName into fixedInfo', async () => {
    const { fetch, calls } = makeFetchStub((call) => {
      if (call.url.includes('/resources/applicants?')) {
        return jsonResponse(200, { id: 'app_named' });
      }
      return jsonResponse(200, { url: 'https://websdk' });
    });
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    await adapter.startSession({
      userRef: 'user-x',
      expectedFullName: { first: 'Jane', last: 'Doe' },
    });

    expect(calls[0]?.body).toEqual({
      externalUserId: 'user-x',
      fixedInfo: { firstName: 'Jane', lastName: 'Doe' },
    });
  });

  it('threads locale into WebSDK link request', async () => {
    const { fetch, calls } = makeFetchStub((call) => {
      if (call.url.includes('/resources/applicants?')) {
        return jsonResponse(200, { id: 'app_loc' });
      }
      return jsonResponse(200, { url: 'https://websdk' });
    });
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    await adapter.startSession({ userRef: 'user-x', locale: 'tr-TR' });

    expect(calls[1]?.body).toEqual(
      expect.objectContaining({ externalUserId: 'user-x', locale: 'tr-TR' }),
    );
  });

  it('rejects malformed POST /applicants response', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(200, { wrong_field: 'x' }));
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    await expect(adapter.startSession({ userRef: 'user-x' })).rejects.toThrow(
      /schema validation/,
    );
  });

  it('rejects empty userRef', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(200, {}));
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });
    await expect(adapter.startSession({ userRef: '' })).rejects.toThrow(/userRef is required/);
  });
});

/* ---------- fetchDecision — status mapping matrix ---------- */

function decisionStubResponder(
  statusBody: unknown,
  lookupBody: unknown,
): (call: FetchCall) => Response {
  return (call) => {
    if (call.url.endsWith('/status')) return jsonResponse(200, statusBody);
    if (call.url.endsWith('/one')) return jsonResponse(200, lookupBody);
    return jsonResponse(404, {});
  };
}

describe('SumsubAdapter.fetchDecision — status mapping', () => {
  it('GREEN + completed → approved + level=basic for identity level', async () => {
    const { fetch } = makeFetchStub(decisionStubResponder(APPROVED_STATUS, LOOKUP_IDENTITY_LEVEL));
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('app_abc');

    expect(decision.status).toBe('approved');
    expect(decision.level).toBe('basic');
    expect(decision.evidence.identityVerified).toBe(true);
    expect(decision.evidence.addressVerified).toBe(false);
    expect(decision.sessionId).toBe('app_abc');
    expect(decision.userRef).toBe('user-123');
    expect(decision.proofHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GREEN + completed → approved + level=enhanced for address level', async () => {
    const { fetch } = makeFetchStub(decisionStubResponder(APPROVED_STATUS, LOOKUP_ADDRESS_LEVEL));
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('app_abc');

    expect(decision.status).toBe('approved');
    expect(decision.level).toBe('enhanced');
    expect(decision.evidence.addressVerified).toBe(true);
  });

  it('RED + FINAL → declined with mapped reason', async () => {
    const { fetch } = makeFetchStub(
      decisionStubResponder(DECLINED_STATUS_FINAL, LOOKUP_IDENTITY_LEVEL),
    );
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('app_abc');

    expect(decision.status).toBe('declined');
    expect(decision.level).toBeUndefined();
    expect(decision.declineReason).toBe('document_rejected');
  });

  it('RED + RETRY → in_review (resubmission expected)', async () => {
    const { fetch } = makeFetchStub(
      decisionStubResponder(DECLINED_STATUS_RETRY, LOOKUP_IDENTITY_LEVEL),
    );
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('app_abc');

    expect(decision.status).toBe('in_review');
    expect(decision.declineReason).toBeUndefined();
  });

  it('reviewStatus="pending" → in_review', async () => {
    const { fetch } = makeFetchStub(
      decisionStubResponder({ reviewStatus: 'pending' }, LOOKUP_IDENTITY_LEVEL),
    );
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('app_abc');
    expect(decision.status).toBe('in_review');
  });

  it('reviewStatus="onHold" → in_review', async () => {
    const { fetch } = makeFetchStub(
      decisionStubResponder({ reviewStatus: 'onHold' }, LOOKUP_IDENTITY_LEVEL),
    );
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('app_abc');
    expect(decision.status).toBe('in_review');
  });

  it('reviewStatus="init" → pending', async () => {
    const { fetch } = makeFetchStub(
      decisionStubResponder({ reviewStatus: 'init' }, LOOKUP_IDENTITY_LEVEL),
    );
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('app_abc');
    expect(decision.status).toBe('pending');
  });

  it('unknown reviewStatus falls back to pending (not throw)', async () => {
    const { fetch } = makeFetchStub(
      decisionStubResponder({ reviewStatus: 'thisIsNew' }, LOOKUP_IDENTITY_LEVEL),
    );
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('app_abc');
    expect(decision.status).toBe('pending');
  });

  it('declineReason mapping covers fraud labels', async () => {
    const stub = decisionStubResponder(
      {
        reviewStatus: 'completed',
        reviewResult: {
          reviewAnswer: 'RED',
          rejectLabels: ['BLOCKLIST'],
          reviewRejectType: 'FINAL',
        },
      },
      LOOKUP_IDENTITY_LEVEL,
    );
    const { fetch } = makeFetchStub(stub);
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('app_abc');
    expect(decision.declineReason).toBe('fraud_signals');
  });

  it('declineReason mapping falls to "other" for unknown labels', async () => {
    const stub = decisionStubResponder(
      {
        reviewStatus: 'completed',
        reviewResult: {
          reviewAnswer: 'RED',
          rejectLabels: ['SOME_FUTURE_LABEL'],
          reviewRejectType: 'FINAL',
        },
      },
      LOOKUP_IDENTITY_LEVEL,
    );
    const { fetch } = makeFetchStub(stub);
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    const decision = await adapter.fetchDecision('app_abc');
    expect(decision.declineReason).toBe('other');
  });

  it('404 → applicant_not_found error', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(404, {}));
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    await expect(adapter.fetchDecision('missing')).rejects.toThrow(/404/);
  });

  it('401 → unauthorized error', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(401, {}));
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });

    try {
      await adapter.fetchDecision('app_abc');
      throw new Error('expected throw');
    } catch (err) {
      if (!isSumsubAdapterError(err)) throw err;
      expect(err.code).toBe('unauthorized');
    }
  });
});

/* ---------- verifyWebhook ---------- */

describe('SumsubAdapter.verifyWebhook', () => {
  const APPROVED_BODY = {
    applicantId: 'app_abc',
    externalUserId: 'user-123',
    type: 'applicantReviewed',
    reviewStatus: 'completed',
    reviewResult: {
      reviewAnswer: 'GREEN',
      rejectLabels: [],
    },
    levelName: 'basic-kyc-level',
  };

  function makeApprovedFetchStub(): { fetch: typeof fetch } {
    return makeFetchStub(
      decisionStubResponder(APPROVED_STATUS, LOOKUP_IDENTITY_LEVEL),
    );
  }

  it('accepts a valid SHA256 digest and auto-enriches via fetchDecision', async () => {
    const { fetch } = makeApprovedFetchStub();
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });
    const raw = JSON.stringify(APPROVED_BODY);
    const sig = createHmac('sha256', BASE_CONFIG.webhookSecret).update(raw).digest('hex');

    const event = await adapter.verifyWebhook(raw, {
      'X-Payload-Digest': sig,
      'X-Payload-Digest-Alg': 'HMAC_SHA256_HEX',
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe('decision');
    if (event?.type === 'decision') {
      expect(event.decision.status).toBe('approved');
      expect(event.decision.level).toBe('basic');
      expect(event.decision.evidence.identityVerified).toBe(true);
    }
  });

  it('rejects when digest header is missing', async () => {
    const adapter = new SumsubAdapter({ ...BASE_CONFIG });

    await expect(adapter.verifyWebhook('{}', {})).rejects.toThrow(/X-Payload-Digest/);
  });

  it('rejects a tampered digest', async () => {
    const adapter = new SumsubAdapter({ ...BASE_CONFIG });
    const raw = JSON.stringify(APPROVED_BODY);
    const sig = createHmac('sha256', BASE_CONFIG.webhookSecret).update(raw).digest('hex');
    const tampered = `${sig.slice(0, -1)}0`;

    await expect(
      adapter.verifyWebhook(raw, {
        'X-Payload-Digest': tampered,
        'X-Payload-Digest-Alg': 'HMAC_SHA256_HEX',
      }),
    ).rejects.toThrow(/did not match/);
  });

  it('rejects an unsupported algorithm', async () => {
    const adapter = new SumsubAdapter({ ...BASE_CONFIG });

    await expect(
      adapter.verifyWebhook('{}', {
        'X-Payload-Digest': 'abc',
        'X-Payload-Digest-Alg': 'HMAC_MD5_HEX',
      }),
    ).rejects.toThrow(/unsupported digest algorithm/);
  });

  it('defaults to HMAC_SHA256_HEX when alg header missing', async () => {
    const { fetch } = makeApprovedFetchStub();
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });
    const raw = JSON.stringify(APPROVED_BODY);
    const sig = createHmac('sha256', BASE_CONFIG.webhookSecret).update(raw).digest('hex');

    const event = await adapter.verifyWebhook(raw, { 'X-Payload-Digest': sig });

    expect(event).not.toBeNull();
  });

  it('applicantDeleted → session.expired event', async () => {
    const adapter = new SumsubAdapter({ ...BASE_CONFIG });
    const body = {
      applicantId: 'app_dead',
      externalUserId: 'user-x',
      type: 'applicantDeleted',
    };
    const raw = JSON.stringify(body);
    const sig = createHmac('sha256', BASE_CONFIG.webhookSecret).update(raw).digest('hex');

    const event = await adapter.verifyWebhook(raw, {
      'X-Payload-Digest': sig,
      'X-Payload-Digest-Alg': 'HMAC_SHA256_HEX',
    });

    expect(event?.type).toBe('session.expired');
    if (event?.type === 'session.expired') {
      expect(event.sessionId).toBe('app_dead');
      expect(event.userRef).toBe('user-x');
    }
  });

  it('non-terminal pending event returns decision without enrichment', async () => {
    const { fetch, calls } = makeFetchStub(() =>
      jsonResponse(500, {}), // Would fail if enrichment was attempted.
    );
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });
    const body = {
      applicantId: 'app_p',
      externalUserId: 'user-p',
      type: 'applicantPending',
      reviewStatus: 'pending',
    };
    const raw = JSON.stringify(body);
    const sig = createHmac('sha256', BASE_CONFIG.webhookSecret).update(raw).digest('hex');

    const event = await adapter.verifyWebhook(raw, {
      'X-Payload-Digest': sig,
      'X-Payload-Digest-Alg': 'HMAC_SHA256_HEX',
    });

    expect(event?.type).toBe('decision');
    if (event?.type === 'decision') {
      expect(event.decision.status).toBe('in_review');
    }
    expect(calls).toHaveLength(0); // No enrichment was attempted.
  });

  it('falls back to webhook-derived event when enrichment fetch fails', async () => {
    const { fetch } = makeFetchStub(() => jsonResponse(503, {}));
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });
    const raw = JSON.stringify(APPROVED_BODY);
    const sig = createHmac('sha256', BASE_CONFIG.webhookSecret).update(raw).digest('hex');

    const event = await adapter.verifyWebhook(raw, {
      'X-Payload-Digest': sig,
      'X-Payload-Digest-Alg': 'HMAC_SHA256_HEX',
    });

    // Webhook-derived approved decision survives enrichment failure.
    expect(event?.type).toBe('decision');
    if (event?.type === 'decision') {
      expect(event.decision.status).toBe('approved');
    }
  });

  it('rejects invalid JSON body', async () => {
    const adapter = new SumsubAdapter({ ...BASE_CONFIG });
    const raw = '{not json';
    const sig = createHmac('sha256', BASE_CONFIG.webhookSecret).update(raw).digest('hex');

    await expect(
      adapter.verifyWebhook(raw, {
        'X-Payload-Digest': sig,
        'X-Payload-Digest-Alg': 'HMAC_SHA256_HEX',
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('returns null on missing applicantId', async () => {
    const adapter = new SumsubAdapter({ ...BASE_CONFIG });
    const body = { type: 'applicantReviewed' };
    const raw = JSON.stringify(body);
    const sig = createHmac('sha256', BASE_CONFIG.webhookSecret).update(raw).digest('hex');

    const event = await adapter.verifyWebhook(raw, {
      'X-Payload-Digest': sig,
      'X-Payload-Digest-Alg': 'HMAC_SHA256_HEX',
    });

    expect(event).toBeNull();
  });

  it('lowercase header name is honored', async () => {
    const { fetch } = makeApprovedFetchStub();
    const adapter = new SumsubAdapter({ ...BASE_CONFIG, fetch });
    const raw = JSON.stringify(APPROVED_BODY);
    const sig = createHmac('sha256', BASE_CONFIG.webhookSecret).update(raw).digest('hex');

    const event = await adapter.verifyWebhook(raw, {
      'x-payload-digest': sig,
      'x-payload-digest-alg': 'HMAC_SHA256_HEX',
    });

    expect(event).not.toBeNull();
  });
});
