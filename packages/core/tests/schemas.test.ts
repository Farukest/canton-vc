/**
 * Tests for `./src/schemas` — v2.0.0 (CIP #204 alignment).
 *
 * The schemas gate every 2xx response from the participant. A failing
 * parse becomes a `CantonError('invalid_response', …)` upstream, so
 * these tests lock the accepted wire shapes in place:
 *
 *   * Happy-path bodies pass and preserve the core fields.
 *   * Missing required fields are rejected.
 *   * Unknown extras are tolerated via `passthrough`.
 *   * Datetime / base64 literals are enforced.
 *   * The credential payload uses the v2.0.0 #204 shape
 *     (`issuer`/`holder`/`admin`/`claims`/`createdAt`/`expiresAt`/`meta`).
 */

import { describe, expect, it } from 'vitest';

import {
  ActiveContractsResponseSchema,
  CantonApiErrorSchema,
  LedgerEndResponseSchema,
  ParticipantIdResponseSchema,
  PartyAllocationResponseSchema,
  PartyLookupResponseSchema,
  SubmitAndWaitResponseSchema,
} from '../src';
import { CredentialViewSchema, parseCredentialPayload } from '../src/schemas';

import {
  buildAcsEntry,
  buildCreatedEvent,
  buildCreateSubmitResponse,
  buildPublicFetchSubmitResponse,
  buildRevokeSubmitResponse,
  FIXTURE_ADMIN_PARTY,
  FIXTURE_CLAIM_NS,
  FIXTURE_CONTRACT_ID,
  FIXTURE_HOLDER_PARTY,
  FIXTURE_ISSUER_PARTY,
  FIXTURE_LEDGER_OFFSET,
  FIXTURE_PARTICIPANT_ID,
  FIXTURE_RECORD_TIME,
  FIXTURE_UPDATE_ID,
} from './fixtures';

/**
 * The submit-response schema keeps `createArgument` lax (`unknown`)
 * because the same envelope ships both Credential and KycNFT mints.
 * The credential-shape invariants live in `parseCredentialPayload`.
 */
function parseSubmitWithCredentialPayload(body: unknown): { ok: boolean } {
  const submitParse = SubmitAndWaitResponseSchema.safeParse(body);
  if (!submitParse.success) {
    return { ok: false };
  }
  const arg = submitParse.data.transaction.events[0]?.CreatedEvent?.createArgument;
  try {
    parseCredentialPayload(arg);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

describe('ParticipantIdResponseSchema', () => {
  it('accepts a well-formed participant id body', () => {
    const parsed = ParticipantIdResponseSchema.parse({ participantId: FIXTURE_PARTICIPANT_ID });
    expect(parsed.participantId).toBe(FIXTURE_PARTICIPANT_ID);
  });

  it('tolerates passthrough fields', () => {
    const parsed = ParticipantIdResponseSchema.parse({
      participantId: FIXTURE_PARTICIPANT_ID,
      extra: 'ignored',
    });
    expect(parsed.participantId).toBe(FIXTURE_PARTICIPANT_ID);
  });

  it('rejects an empty body', () => {
    expect(ParticipantIdResponseSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-string participantId', () => {
    expect(ParticipantIdResponseSchema.safeParse({ participantId: 42 }).success).toBe(false);
  });

  it('rejects an empty participantId', () => {
    expect(ParticipantIdResponseSchema.safeParse({ participantId: '' }).success).toBe(false);
  });
});

describe('PartyLookupResponseSchema', () => {
  it('accepts a populated party lookup', () => {
    const parsed = PartyLookupResponseSchema.parse({
      partyDetails: [{ party: FIXTURE_ISSUER_PARTY, isLocal: true }],
    });
    expect(parsed.partyDetails).toHaveLength(1);
    expect(parsed.partyDetails[0]?.party).toBe(FIXTURE_ISSUER_PARTY);
  });

  it('accepts an empty party list', () => {
    const parsed = PartyLookupResponseSchema.parse({ partyDetails: [] });
    expect(parsed.partyDetails).toEqual([]);
  });

  it('rejects missing partyDetails', () => {
    expect(PartyLookupResponseSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-array partyDetails', () => {
    expect(PartyLookupResponseSchema.safeParse({ partyDetails: {} }).success).toBe(false);
  });
});

describe('PartyAllocationResponseSchema', () => {
  it('accepts a single-object partyDetails body', () => {
    const parsed = PartyAllocationResponseSchema.parse({
      partyDetails: { party: FIXTURE_HOLDER_PARTY, isLocal: true },
    });
    expect(parsed.partyDetails.party).toBe(FIXTURE_HOLDER_PARTY);
  });

  it('rejects an array partyDetails (allocation returns single object)', () => {
    expect(
      PartyAllocationResponseSchema.safeParse({
        partyDetails: [{ party: FIXTURE_HOLDER_PARTY }],
      }).success,
    ).toBe(false);
  });

  it('rejects a missing party field', () => {
    expect(PartyAllocationResponseSchema.safeParse({ partyDetails: {} }).success).toBe(false);
  });
});

describe('LedgerEndResponseSchema', () => {
  it('accepts a valid offset body', () => {
    const parsed = LedgerEndResponseSchema.parse({ offset: FIXTURE_LEDGER_OFFSET });
    expect(parsed.offset).toBe(FIXTURE_LEDGER_OFFSET);
  });

  it('rejects an empty offset', () => {
    expect(LedgerEndResponseSchema.safeParse({ offset: '' }).success).toBe(false);
  });

  it('coerces a numeric offset to a string', () => {
    const parsed = LedgerEndResponseSchema.parse({ offset: 42 });
    expect(parsed.offset).toBe('42');
    expect(typeof parsed.offset).toBe('string');
  });

  it('rejects a negative numeric offset', () => {
    expect(LedgerEndResponseSchema.safeParse({ offset: -1 }).success).toBe(false);
  });

  it('rejects a non-integer numeric offset', () => {
    expect(LedgerEndResponseSchema.safeParse({ offset: 1.5 }).success).toBe(false);
  });

  it('rejects an offset of the wrong type (boolean)', () => {
    expect(LedgerEndResponseSchema.safeParse({ offset: true }).success).toBe(false);
  });
});

describe('SubmitAndWaitResponseSchema — create', () => {
  it('accepts a create response with a CreatedEvent under the v2.0.0 shape', () => {
    const body = buildCreateSubmitResponse();
    const parsed = SubmitAndWaitResponseSchema.parse(body);
    expect(parsed.transaction.updateId).toBe(FIXTURE_UPDATE_ID);
    expect(parsed.transaction.recordTime).toBe(FIXTURE_RECORD_TIME);
    expect(parsed.transaction.offset).toBe(FIXTURE_LEDGER_OFFSET);
    expect(parsed.transaction.events).toHaveLength(1);
    const created = parsed.transaction.events[0]?.CreatedEvent;
    expect(created).toBeDefined();
    expect(created?.contractId).toBe(FIXTURE_CONTRACT_ID);
    const payload = parseCredentialPayload(created?.createArgument);
    expect(payload.issuer).toBe(FIXTURE_ISSUER_PARTY);
    expect(payload.holder).toBe(FIXTURE_HOLDER_PARTY);
    expect(payload.admin).toBe(FIXTURE_ADMIN_PARTY);
    expect(payload.claims.values[`${FIXTURE_CLAIM_NS}/level`]).toBe('Enhanced');
  });

  it('rejects a create body missing the transaction wrapper', () => {
    expect(SubmitAndWaitResponseSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an invalid recordTime', () => {
    const body = buildCreateSubmitResponse();
    (body['transaction'] as { recordTime: unknown }).recordTime = 'not-iso';
    expect(SubmitAndWaitResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a missing events array', () => {
    const body = buildCreateSubmitResponse();
    delete (body['transaction'] as { events?: unknown }).events;
    expect(SubmitAndWaitResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a payload missing the required claims field', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created && 'createArgument' in created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      delete arg['claims'];
    }
    expect(parseSubmitWithCredentialPayload(body).ok).toBe(false);
  });

  it('rejects a payload with a non-string claim value', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      const claims = arg['claims'] as { values: Record<string, unknown> };
      claims.values[`${FIXTURE_CLAIM_NS}/level`] = 92;
    }
    expect(parseSubmitWithCredentialPayload(body).ok).toBe(false);
  });

  it('rejects a non-ISO claims.validUntil', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      const claims = arg['claims'] as { validUntil: unknown };
      claims.validUntil = '2027/04/11';
    }
    expect(parseSubmitWithCredentialPayload(body).ok).toBe(false);
  });

  it('accepts a null claims.validUntil (Daml `Optional Time`)', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      const claims = arg['claims'] as { validUntil: unknown };
      claims.validUntil = null;
    }
    expect(parseSubmitWithCredentialPayload(body).ok).toBe(true);
  });

  it('tolerates an optional createdEventBlob when base64', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      created['createdEventBlob'] = 'YWJjZGVm';
    }
    expect(SubmitAndWaitResponseSchema.safeParse(body).success).toBe(true);
  });

  it('rejects a non-base64 createdEventBlob', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      created['createdEventBlob'] = '####';
    }
    expect(SubmitAndWaitResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('SubmitAndWaitResponseSchema — Credential_PublicFetch', () => {
  it('accepts a PublicFetch exercise response carrying the standard view', () => {
    const parsed = SubmitAndWaitResponseSchema.parse(buildPublicFetchSubmitResponse());
    const exercised = parsed.transaction.events[0]?.ExercisedEvent;
    expect(exercised?.choice).toBe('Credential_PublicFetch');
    expect(exercised?.consuming).toBe(false);
    const view = CredentialViewSchema.parse(exercised?.exerciseResult);
    expect(view.admin).toBe(FIXTURE_ADMIN_PARTY);
    expect(view.issuer).toBe(FIXTURE_ISSUER_PARTY);
    expect(view.holder).toBe(FIXTURE_HOLDER_PARTY);
  });

  it('rejects a view payload missing admin', () => {
    const body = buildPublicFetchSubmitResponse();
    const exercised = (
      body['transaction'] as { events: Array<{ ExercisedEvent: Record<string, unknown> }> }
    ).events[0]?.ExercisedEvent;
    if (exercised) {
      const view = exercised['exerciseResult'] as Record<string, unknown>;
      delete view['admin'];
      expect(CredentialViewSchema.safeParse(view).success).toBe(false);
    }
  });
});

describe('SubmitAndWaitResponseSchema — revoke', () => {
  it('accepts a RevokeCredential consuming exercise response', () => {
    const parsed = SubmitAndWaitResponseSchema.parse(buildRevokeSubmitResponse());
    const exercised = parsed.transaction.events[0]?.ExercisedEvent;
    expect(exercised?.choice).toBe('RevokeCredential');
    expect(exercised?.consuming).toBe(true);
  });
});

describe('ActiveContractsResponseSchema', () => {
  it('accepts a bare array of ACS entries', () => {
    const parsed = ActiveContractsResponseSchema.parse([buildAcsEntry()]);
    expect(parsed).toHaveLength(1);
    const first = parsed[0];
    expect(first?.contractEntry.JsActiveContract?.createdEvent.contractId).toBe(
      FIXTURE_CONTRACT_ID,
    );
  });

  it('accepts an empty array', () => {
    expect(ActiveContractsResponseSchema.parse([])).toEqual([]);
  });

  it('rejects a non-array body', () => {
    expect(ActiveContractsResponseSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an entry without contractEntry', () => {
    expect(ActiveContractsResponseSchema.safeParse([{}]).success).toBe(false);
  });

  it('tolerates an entry where JsActiveContract is absent (alternate entry type)', () => {
    expect(ActiveContractsResponseSchema.safeParse([{ contractEntry: {} }]).success).toBe(true);
  });

  it('propagates createdEventBlob through parsing when present', () => {
    const entry = buildAcsEntry({ createdEventBlob: 'c29tZS1ibG9i' });
    const parsed = ActiveContractsResponseSchema.parse([entry]);
    const first = parsed[0]?.contractEntry.JsActiveContract?.createdEvent;
    expect(first?.createdEventBlob).toBe('c29tZS1ibG9i');
  });

  it('lets the ACS envelope schema accept a malformed createArgument, but the second-stage parser rejects', () => {
    const entry = buildAcsEntry();
    const created = entry['contractEntry'] as {
      JsActiveContract: { createdEvent: { createArgument: Record<string, unknown> } };
    };
    delete created.JsActiveContract.createdEvent.createArgument['claims'];

    expect(ActiveContractsResponseSchema.safeParse([entry]).success).toBe(true);
    expect(() => parseCredentialPayload(created.JsActiveContract.createdEvent.createArgument)).toThrow();
  });
});

describe('CantonApiErrorSchema', () => {
  it('accepts a full structured error body', () => {
    const parsed = CantonApiErrorSchema.parse({
      cause: 'command validation failed',
      code: 'INVALID_ARGUMENT',
      errorCategory: 8,
      grpcCodeValue: 3,
      correlationId: 'abc-123',
      context: { commandId: 'crv-create-1' },
    });
    expect(parsed.cause).toBe('command validation failed');
    expect(parsed.code).toBe('INVALID_ARGUMENT');
  });

  it('accepts an empty object (all fields optional)', () => {
    expect(CantonApiErrorSchema.parse({})).toEqual({});
  });

  it('tolerates passthrough fields', () => {
    const parsed = CantonApiErrorSchema.parse({ cause: 'x', foo: 'bar' });
    expect(parsed.cause).toBe('x');
  });

  it('rejects a non-object input', () => {
    expect(CantonApiErrorSchema.safeParse('boom').success).toBe(false);
  });
});

describe('buildCreatedEvent fixture', () => {
  it('produces a body that passes ACS schema validation', () => {
    const entry = buildAcsEntry();
    expect(ActiveContractsResponseSchema.safeParse([entry]).success).toBe(true);
  });

  it('respects field overrides', () => {
    const created = buildCreatedEvent({ admin: 'OverrideAdmin::abc' });
    expect((created['createArgument'] as Record<string, unknown>)['admin']).toBe(
      'OverrideAdmin::abc',
    );
  });
});
