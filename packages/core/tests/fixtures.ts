/**
 * Shared test fixtures for the Canton-client suite — v2.0.0 (CIP #204).
 *
 * The Canton client uses a small `FetchLike` surface (see `http.ts`)
 * so tests can inject a fully-deterministic stub. `buildFakeFetch`
 * below produces one that reads from a FIFO queue of pre-programmed
 * responses and records each request for later assertions.
 *
 * No real HTTP client is ever instantiated.
 */

import { vi } from 'vitest';
import type { CantonConfig, Claims, FetchLike, FetchLikeResponse } from '../src';
import { loadCantonConfig } from '../src';

/* ---------- Canonical constants ---------- */

export const FIXTURE_NAMESPACE =
  '1220deadbeef0123456789abcdef0123456789abcdef0123456789abcdef0011';

export const FIXTURE_ISSUER_PARTY = `Issuer::${FIXTURE_NAMESPACE}`;
export const FIXTURE_ADMIN_PARTY = FIXTURE_ISSUER_PARTY;
export const FIXTURE_HOLDER_PARTY = `Holder-abc123::${FIXTURE_NAMESPACE}`;

export const FIXTURE_PARTICIPANT_ID = `participant::${FIXTURE_NAMESPACE}`;

export const FIXTURE_CONTRACT_ID =
  '00a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';

export const FIXTURE_UPDATE_ID = 'update-0000000001';
export const FIXTURE_RECORD_TIME = '2026-04-11T18:00:00.000Z';
export const FIXTURE_LEDGER_OFFSET = '000000000000000001';

export const FIXTURE_NOW = new Date('2026-04-11T18:00:00.000Z');

export function fixtureRand(n: number): Buffer {
  return Buffer.alloc(n, 0xab);
}

export function fixtureClock(): number {
  return FIXTURE_NOW.getTime();
}

/**
 * Example reverse-DNS namespace for tests. Reflects the CIP #204
 * convention (application picks its own prefix) without coupling
 * the fixture set to any specific consumer.
 */
export const FIXTURE_CLAIM_NS = 'com.example';

/**
 * Canonical claims map used by the happy-path fixtures. Uses
 * `com.example/*` keys so the fixture is decoupled from any
 * specific consumer's namespace.
 */
export function buildClaims(overrides: Partial<Claims> = {}): Claims {
  return {
    values: overrides.values ?? {
      [`${FIXTURE_CLAIM_NS}/userRef`]: 'firm-user-fixture',
      [`${FIXTURE_CLAIM_NS}/level`]: 'Enhanced',
      [`${FIXTURE_CLAIM_NS}/proofHash`]: 'deadbeef',
    },
    validFrom: overrides.validFrom ?? null,
    validUntil: overrides.validUntil ?? '2027-04-11T00:00:00Z',
    meta: overrides.meta ?? {},
  };
}

/* ---------- Config builder ---------- */

export function buildTestConfig(overrides: Partial<Record<string, string>> = {}): CantonConfig {
  const env = {
    CANTON_JSON_API_BASE_URL: 'http://canton-participant.test:7575',
    CANTON_OPERATOR_PARTY: FIXTURE_ISSUER_PARTY,
    CANTON_PACKAGE_NAME: '#canton-vc-credential:Canton.VC.Credential:Credential',
    CANTON_NETWORK: 'mainnet',
    CANTON_NETWORK_LABEL: 'Canton MainNet',
    CANTON_USER_ID: 'canton-vc-test',
    CANTON_REQUEST_TIMEOUT_MS: '1000',
    CANTON_MAX_RETRIES: '0',
    CANTON_RETRY_BASE_DELAY_MS: '0',
    CANTON_COMMAND_ID_PREFIX: 'crv',
    CANTON_MAX_COMMAND_BODY_BYTES: '65536',
    CANTON_ALLOCATE_MISSING_PARTIES: 'false',
    ...overrides,
  };
  return loadCantonConfig(env);
}

/* ---------- Fake fetch ---------- */

export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export type FakeResponse =
  | { readonly kind: 'json'; readonly status?: number; readonly body: unknown }
  | { readonly kind: 'text'; readonly status?: number; readonly body: string }
  | { readonly kind: 'throw'; readonly error: Error }
  | { readonly kind: 'empty'; readonly status?: number };

export interface FakeFetchHandle {
  readonly fetch: FetchLike;
  readonly captured: CapturedRequest[];
  readonly enqueue: (response: FakeResponse) => void;
  readonly reset: () => void;
  readonly remaining: () => number;
}

export function buildFakeFetch(): FakeFetchHandle {
  const captured: CapturedRequest[] = [];
  const queue: FakeResponse[] = [];

  const fetchImpl: FetchLike = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    captured.push({
      method: init.method,
      path: `${parsed.pathname}${parsed.search}`,
      url,
      headers: init.headers,
      body: parseBody(init.body),
    });

    if (init.signal?.aborted === true) {
      const err = new Error('fetch aborted');
      err.name = 'AbortError';
      throw err;
    }

    const response = queue.shift();
    if (response === undefined) {
      throw new Error(
        `fake fetch: no response queued for ${init.method} ${parsed.pathname}. Did you forget to enqueue one?`,
      );
    }

    if (response.kind === 'throw') {
      throw response.error;
    }

    return buildFakeResponse(response);
  });

  return {
    fetch: fetchImpl,
    captured,
    enqueue: (response) => {
      queue.push(response);
    },
    reset: () => {
      captured.length = 0;
      queue.length = 0;
    },
    remaining: () => queue.length,
  };
}

function parseBody(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildFakeResponse(response: FakeResponse): FetchLikeResponse {
  if (response.kind === 'json') {
    const status = response.status ?? 200;
    const text = JSON.stringify(response.body);
    return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) };
  }
  if (response.kind === 'text') {
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(response.body),
    };
  }
  if (response.kind === 'empty') {
    const status = response.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve('') };
  }
  throw new Error('unreachable: buildFakeResponse called with throw');
}

/* ---------- Canned response bodies (v2.0.0 shape) ---------- */

/**
 * Build a canonical `createdEvent` wire shape for a Credential
 * active contract under the v2.0.0 #204 storage shape.
 */
export function buildCreatedEvent(
  overrides: {
    contractId?: string;
    templateId?: string;
    issuer?: string;
    holder?: string;
    admin?: string;
    claims?: Claims;
    createdAt?: string | null;
    expiresAt?: string | null;
    meta?: Readonly<Record<string, string>>;
    createdEventBlob?: string | undefined;
  } = {},
): Record<string, unknown> {
  const issuer = overrides.issuer ?? FIXTURE_ISSUER_PARTY;
  const holder = overrides.holder ?? FIXTURE_HOLDER_PARTY;
  const admin = overrides.admin ?? FIXTURE_ADMIN_PARTY;
  const claims = overrides.claims ?? buildClaims();
  const base: Record<string, unknown> = {
    contractId: overrides.contractId ?? FIXTURE_CONTRACT_ID,
    templateId: overrides.templateId ?? '#canton-vc-credential:Canton.VC.Credential:Credential',
    createArgument: {
      issuer,
      holder,
      admin,
      claims: {
        values: claims.values,
        validFrom: claims.validFrom ?? null,
        validUntil: claims.validUntil ?? null,
        meta: claims.meta,
      },
      createdAt: overrides.createdAt === undefined ? '2026-04-11T18:00:00Z' : overrides.createdAt,
      expiresAt: overrides.expiresAt === undefined ? '2027-04-11T00:00:00Z' : overrides.expiresAt,
      meta: overrides.meta ?? {},
    },
    signatories: [issuer, holder],
    observers: [],
  };
  if (overrides.createdEventBlob !== undefined) {
    base['createdEventBlob'] = overrides.createdEventBlob;
  }
  return base;
}

export function buildAcsEntry(
  createdEventOverrides: Parameters<typeof buildCreatedEvent>[0] = {},
): Record<string, unknown> {
  return {
    contractEntry: {
      JsActiveContract: {
        createdEvent: buildCreatedEvent(createdEventOverrides),
        synchronizerId: 'global-domain',
        reassignmentCounter: 0,
      },
    },
  };
}

/**
 * Submit-and-wait response body for a successful Create.
 */
export function buildCreateSubmitResponse(
  overrides: {
    contractId?: string;
    updateId?: string;
    recordTime?: string;
    offset?: string;
  } = {},
): Record<string, unknown> {
  return {
    transaction: {
      updateId: overrides.updateId ?? FIXTURE_UPDATE_ID,
      recordTime: overrides.recordTime ?? FIXTURE_RECORD_TIME,
      offset: overrides.offset ?? FIXTURE_LEDGER_OFFSET,
      events: [
        {
          CreatedEvent: buildCreatedEvent({
            ...(overrides.contractId !== undefined ? { contractId: overrides.contractId } : {}),
          }),
        },
      ],
    },
  };
}

/**
 * Submit-and-wait response body for a successful
 * `Credential_PublicFetch` exercise. Returns the standard CIP #204
 * `CredentialView` payload as `exerciseResult`.
 */
export function buildPublicFetchSubmitResponse(
  overrides: {
    updateId?: string;
    recordTime?: string;
    offset?: string;
    issuer?: string;
    holder?: string;
    admin?: string;
    claims?: Claims;
    createdAt?: string | null;
    expiresAt?: string | null;
    meta?: Readonly<Record<string, string>>;
    exerciseResult?: unknown;
  } = {},
): Record<string, unknown> {
  const issuer = overrides.issuer ?? FIXTURE_ISSUER_PARTY;
  const holder = overrides.holder ?? FIXTURE_HOLDER_PARTY;
  const admin = overrides.admin ?? FIXTURE_ADMIN_PARTY;
  const claims = overrides.claims ?? buildClaims();
  const view =
    overrides.exerciseResult !== undefined
      ? overrides.exerciseResult
      : {
          admin,
          issuer,
          holder,
          claims: {
            values: claims.values,
            validFrom: claims.validFrom ?? null,
            validUntil: claims.validUntil ?? null,
            meta: claims.meta,
          },
          createdAt: overrides.createdAt === undefined ? '2026-04-11T18:00:00Z' : overrides.createdAt,
          expiresAt: overrides.expiresAt === undefined ? '2027-04-11T00:00:00Z' : overrides.expiresAt,
          meta: overrides.meta ?? {},
        };
  return {
    transaction: {
      updateId: overrides.updateId ?? FIXTURE_UPDATE_ID,
      recordTime: overrides.recordTime ?? FIXTURE_RECORD_TIME,
      offset: overrides.offset ?? FIXTURE_LEDGER_OFFSET,
      events: [
        {
          ExercisedEvent: {
            contractId: FIXTURE_CONTRACT_ID,
            templateId: '#canton-vc-credential:Canton.VC.Credential:Credential',
            choice: 'Credential_PublicFetch',
            consuming: false,
            exerciseResult: view,
          },
        },
      ],
    },
  };
}

/**
 * Submit-and-wait response for a successful `RevokeCredential`.
 * The consuming choice returns a contract id for the new revoked
 * sibling.
 */
export function buildRevokeSubmitResponse(
  overrides: { updateId?: string; recordTime?: string; offset?: string } = {},
): Record<string, unknown> {
  return {
    transaction: {
      updateId: overrides.updateId ?? FIXTURE_UPDATE_ID,
      recordTime: overrides.recordTime ?? FIXTURE_RECORD_TIME,
      offset: overrides.offset ?? FIXTURE_LEDGER_OFFSET,
      events: [
        {
          ExercisedEvent: {
            contractId: FIXTURE_CONTRACT_ID,
            templateId: '#canton-vc-credential:Canton.VC.Credential:Credential',
            choice: 'RevokeCredential',
            consuming: true,
            exerciseResult: 'new-revoked-sibling-contract-id',
          },
        },
      ],
    },
  };
}
