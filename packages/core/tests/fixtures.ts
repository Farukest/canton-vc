/**
 * Shared test fixtures for the Canton-client suite.
 *
 * The Canton client uses a small `FetchLike` surface (see `http.ts`)
 * so tests can inject a fully-deterministic stub. `buildFakeFetch`
 * below produces one that reads from a FIFO queue of pre-programmed
 * responses and records each request for later assertions.
 *
 * No real HTTP client is ever instantiated. The fixture also exports
 * canonical values — party ids, contract ids, time — that match
 * MainNet shapes so the assertions read like real traces.
 */

import { vi } from 'vitest';
import type { CantonConfig, FetchLike, FetchLikeResponse } from '../src';
import { loadCantonConfig } from '../src';

/* ---------- Canonical constants ---------- */

/**
 * 64-hex fingerprint matching the MainNet operator namespace shape.
 * Stored without the `::` so tests can reuse it for multiple party
 * labels (e.g. operator and user parties on the same participant).
 */
export const FIXTURE_NAMESPACE =
  '1220deadbeef0123456789abcdef0123456789abcdef0123456789abcdef0011';

/**
 * Operator party — matches the MEMORY.md record.
 */
export const FIXTURE_OPERATOR_PARTY = `Operator::${FIXTURE_NAMESPACE}`;

/**
 * Example user party for happy-path tests.
 */
export const FIXTURE_USER_PARTY = `User-abc123::${FIXTURE_NAMESPACE}`;

/**
 * Participant id — the participant's own party id, used by
 * `/v2/parties/participant-id`.
 */
export const FIXTURE_PARTICIPANT_ID = `participant::${FIXTURE_NAMESPACE}`;

/**
 * Plausible contract id — the participant format is a long hex
 * string. Here we use a shorter fixture since we never parse it.
 */
export const FIXTURE_CONTRACT_ID =
  '00a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';

/**
 * Sample `updateId` and `recordTime` — used in transaction fixtures.
 */
export const FIXTURE_UPDATE_ID = 'update-0000000001';
export const FIXTURE_RECORD_TIME = '2026-04-11T18:00:00.000Z';
export const FIXTURE_LEDGER_OFFSET = '000000000000000001';

/**
 * Fixed deterministic clock — tests can freeze time to this value
 * when they want to assert the exact command id or `fetchedAt`
 * timestamp.
 */
export const FIXTURE_NOW = new Date('2026-04-11T18:00:00.000Z');

/**
 * Deterministic random source used by `newCommandId` in tests.
 * Produces a fixed 4-byte sequence so the generated command id is
 * stable across runs.
 */
export function fixtureRand(n: number): Buffer {
  return Buffer.alloc(n, 0xab);
}

/**
 * Deterministic clock for command id generation.
 */
export function fixtureClock(): number {
  return FIXTURE_NOW.getTime();
}

/* ---------- Config builder ---------- */

/**
 * Build a fresh `CantonConfig` with safe test defaults. Tests can
 * spread overrides to change individual fields without touching the
 * environment.
 */
export function buildTestConfig(overrides: Partial<Record<string, string>> = {}): CantonConfig {
  const env = {
    CANTON_JSON_API_BASE_URL: 'http://canton-participant.test:7575',
    CANTON_OPERATOR_PARTY: FIXTURE_OPERATOR_PARTY,
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

/**
 * Captured request — each call to the fake fetch pushes one of
 * these. Tests assert on the shape (method, path, parsed body).
 */
export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/**
 * Programmed response — either a body object + status, or an error
 * to throw. `status` defaults to 200.
 */
export type FakeResponse =
  | {
      readonly kind: 'json';
      readonly status?: number;
      readonly body: unknown;
    }
  | {
      readonly kind: 'text';
      readonly status?: number;
      readonly body: string;
    }
  | {
      readonly kind: 'throw';
      readonly error: Error;
    }
  | {
      readonly kind: 'empty';
      readonly status?: number;
    };

/**
 * Handle returned by `buildFakeFetch`. Tests program responses
 * via `.enqueue()` and assert captured requests via `.captured`.
 */
export interface FakeFetchHandle {
  readonly fetch: FetchLike;
  readonly captured: CapturedRequest[];
  readonly enqueue: (response: FakeResponse) => void;
  readonly reset: () => void;
  readonly remaining: () => number;
}

/**
 * Build a `FetchLike` that pulls responses from a FIFO queue and
 * captures each request. Calls fail if no response is queued.
 *
 * The fake is synchronous internally — it resolves the promise
 * immediately — but it respects the `AbortSignal`: if the signal
 * is already aborted by the time the fake runs, it throws an
 * abort error the same way the real fetch would.
 */
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

/**
 * Parse the string body that `cantonFetch` serialized back into a
 * structured value for easier assertions.
 */
function parseBody(raw: string | undefined): unknown {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Build a `FetchLikeResponse` from a programmed `FakeResponse`.
 * Mirrors the narrow interface `http.ts` actually consumes.
 */
function buildFakeResponse(response: FakeResponse): FetchLikeResponse {
  if (response.kind === 'json') {
    const status = response.status ?? 200;
    const text = JSON.stringify(response.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
    };
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
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(''),
    };
  }
  // Unreachable — `throw` is handled in the caller.
  throw new Error('unreachable: buildFakeResponse called with throw');
}

/* ---------- Canned response bodies ---------- */

/**
 * Build a canonical `createdEvent` wire shape for a KYCCredential
 * active contract. Any field can be overridden; defaults mirror a
 * plausible MainNet credential for `FIXTURE_USER_PARTY`.
 */
export function buildCreatedEvent(
  overrides: {
    contractId?: string;
    templateId?: string;
    user?: string;
    userRef?: string;
    status?: 'Pending' | 'Active' | 'Revoked' | 'Expired';
    // the level enum dropped 'Standard' tier — fixtures now produce
    // either 'Basic' or 'Enhanced'.
    level?: 'Basic' | 'Enhanced';
    validator?:
      | 'DiditValidator'
      | 'OnfidoValidator'
      | 'PersonaValidator'
      | 'SumsubValidator'
      | 'VeriffValidator'
      | 'Au10tixValidator'
      | 'JumioValidator'
      | 'ZkValidator'
      | 'Generic';
    createdEventBlob?: string | undefined;
    validUntil?: string;
    humanScore?: number;
    identityVerified?: boolean;
    livenessVerified?: boolean;
    addressVerified?: boolean;
    network?: string;
    proofHash?: string;
  } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    contractId: overrides.contractId ?? FIXTURE_CONTRACT_ID,
    templateId: overrides.templateId ?? '#canton-vc-credential:Canton.VC.Credential:Credential',
    createArgument: {
      operator: FIXTURE_OPERATOR_PARTY,
      user: overrides.user ?? FIXTURE_USER_PARTY,
      // `userRef` added to the on-chain payload.
      userRef: overrides.userRef ?? 'firm-user-fixture',
      proofHash: overrides.proofHash ?? 'deadbeef',
      status: overrides.status ?? 'Active',
      level: overrides.level ?? 'Enhanced',
      validUntil: overrides.validUntil ?? '2027-04-11T00:00:00Z',
      network: overrides.network ?? 'Canton MainNet',
      humanScore: overrides.humanScore ?? 90,
      validator: overrides.validator ?? 'DiditValidator',
      identityVerified: overrides.identityVerified ?? true,
      livenessVerified: overrides.livenessVerified ?? true,
      addressVerified: overrides.addressVerified ?? false,
    },
    signatories: [FIXTURE_OPERATOR_PARTY],
    observers: [overrides.user ?? FIXTURE_USER_PARTY],
  };
  if (overrides.createdEventBlob !== undefined) {
    base['createdEventBlob'] = overrides.createdEventBlob;
  }
  return base;
}

/**
 * Build a canonical ACS array entry wrapping a created event.
 */
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
 * Build a submit-and-wait response body for a successful create. Used
 * by the ledger tests to stub the participant's response.
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
 * Build a submit-and-wait response body for a successful Verify.
 *
 * the template returns a `CredentialView` struct rather
 * than a `Bool`. The boolean argument here drives the
 * `isActive` field of the produced view (and toggles the status
 * between 'Active' and 'Revoked' so the snapshot stays internally
 * consistent). Tests can override individual fields.
 */
export function buildVerifySubmitResponse(
  isActive: boolean,
  overrides: {
    updateId?: string;
    recordTime?: string;
    offset?: string;
    userRef?: string;
    level?: 'Basic' | 'Enhanced';
    status?: 'Pending' | 'Active' | 'Revoked' | 'Expired';
    exerciseResult?: unknown;
  } = {},
): Record<string, unknown> {
  const view =
    overrides.exerciseResult !== undefined
      ? overrides.exerciseResult
      : {
          userRef: overrides.userRef ?? 'firm-user-fixture',
          proofHash: 'deadbeef',
          status: overrides.status ?? (isActive ? 'Active' : 'Revoked'),
          level: overrides.level ?? 'Enhanced',
          validUntil: '2027-04-11T00:00:00Z',
          network: 'Canton MainNet',
          humanScore: 90,
          validator: 'DiditValidator',
          identityVerified: true,
          livenessVerified: true,
          addressVerified: true,
          isActive,
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
            choice: 'Verify',
            consuming: false,
            exerciseResult: view,
          },
        },
      ],
    },
  };
}

/**
 * Build a submit-and-wait response body for a successful revoke.
 * The consuming `RevokeCredential` choice returns `Unit` (`{}`).
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
            exerciseResult: {},
          },
        },
      ],
    },
  };
}
