/**
 * Tests for `./src/schemas`.
 *
 * The schemas gate every 2xx response from the participant. A failing
 * parse becomes a `CantonError('invalid_response', …)` upstream, so
 * these tests lock the accepted wire shapes in place:
 *
 *   * Happy-path bodies pass and preserve the core fields.
 *   * Missing required fields are rejected.
 *   * Type-wrong fields are rejected (string for number, etc.).
 *   * Unknown extras are tolerated via `passthrough`.
 *   * Enum / date / base64 literals are enforced.
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
import { parseKycCredentialPayload } from '../src/schemas';

/**
 * The submit-response schema (`SubmitAndWaitResponseSchema`) keeps
 * `createArgument` lax (`unknown`) because the same envelope ships
 * both KycCredential and KycNFT mints. The credential-shape
 * invariants live in `parseKycCredentialPayload`. Tests that exercise
 * those invariants run the response through both stages.
 */
function parseSubmitWithCredentialPayload(body: unknown): {
  ok: boolean;
} {
  const submitParse = SubmitAndWaitResponseSchema.safeParse(body);
  if (!submitParse.success) {
    return { ok: false };
  }
  const arg = submitParse.data.transaction.events[0]?.CreatedEvent?.createArgument;
  try {
    parseKycCredentialPayload(arg);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

import {
  buildAcsEntry,
  buildCreatedEvent,
  buildCreateSubmitResponse,
  buildRevokeSubmitResponse,
  buildVerifySubmitResponse,
  FIXTURE_CONTRACT_ID,
  FIXTURE_LEDGER_OFFSET,
  FIXTURE_OPERATOR_PARTY,
  FIXTURE_PARTICIPANT_ID,
  FIXTURE_RECORD_TIME,
  FIXTURE_UPDATE_ID,
  FIXTURE_USER_PARTY,
} from './fixtures';

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
      partyDetails: [{ party: FIXTURE_OPERATOR_PARTY, isLocal: true }],
    });
    expect(parsed.partyDetails).toHaveLength(1);
    expect(parsed.partyDetails[0]?.party).toBe(FIXTURE_OPERATOR_PARTY);
  });

  it('accepts an empty party list', () => {
    const parsed = PartyLookupResponseSchema.parse({ partyDetails: [] });
    expect(parsed.partyDetails).toEqual([]);
  });

  it('tolerates extra fields on the entry', () => {
    const parsed = PartyLookupResponseSchema.parse({
      partyDetails: [
        { party: FIXTURE_OPERATOR_PARTY, displayName: 'TestOperator', identityProviderId: 'idp' },
      ],
    });
    expect(parsed.partyDetails[0]?.party).toBe(FIXTURE_OPERATOR_PARTY);
  });

  it('rejects missing partyDetails', () => {
    expect(PartyLookupResponseSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-array partyDetails', () => {
    expect(PartyLookupResponseSchema.safeParse({ partyDetails: {} }).success).toBe(false);
  });

  it('rejects a party entry missing the party field', () => {
    expect(PartyLookupResponseSchema.safeParse({ partyDetails: [{ isLocal: true }] }).success).toBe(
      false,
    );
  });
});

describe('PartyAllocationResponseSchema', () => {
  it('accepts a single-object partyDetails body', () => {
    const parsed = PartyAllocationResponseSchema.parse({
      partyDetails: { party: FIXTURE_USER_PARTY, isLocal: true },
    });
    expect(parsed.partyDetails.party).toBe(FIXTURE_USER_PARTY);
  });

  it('rejects an array partyDetails (allocation returns single object)', () => {
    expect(
      PartyAllocationResponseSchema.safeParse({
        partyDetails: [{ party: FIXTURE_USER_PARTY }],
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

  it('coerces a numeric offset to a string (Canton 3.x JSON-encodes Long offsets as numbers)', () => {
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
  it('accepts a create response with a CreatedEvent', () => {
    const body = buildCreateSubmitResponse();
    const parsed = SubmitAndWaitResponseSchema.parse(body);
    expect(parsed.transaction.updateId).toBe(FIXTURE_UPDATE_ID);
    expect(parsed.transaction.recordTime).toBe(FIXTURE_RECORD_TIME);
    expect(parsed.transaction.offset).toBe(FIXTURE_LEDGER_OFFSET);
    expect(parsed.transaction.events).toHaveLength(1);
    const created = parsed.transaction.events[0]?.CreatedEvent;
    expect(created).toBeDefined();
    expect(created?.contractId).toBe(FIXTURE_CONTRACT_ID);
    const payload = parseKycCredentialPayload(created?.createArgument);
    expect(payload.status).toBe('Active');
    expect(payload.level).toBe('Enhanced');
    expect(payload.validator).toBe('DiditValidator');
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

  it('rejects a payload missing required credential fields', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created && 'createArgument' in created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      delete arg['proofHash'];
    }
    expect(parseSubmitWithCredentialPayload(body).ok).toBe(false);
  });

  it('rejects an unknown status enum', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      arg['status'] = 'Unknown';
    }
    expect(parseSubmitWithCredentialPayload(body).ok).toBe(false);
  });

  it('rejects a humanScore out of range', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      arg['humanScore'] = 101;
    }
    expect(parseSubmitWithCredentialPayload(body).ok).toBe(false);
  });

  it('coerces a string-encoded humanScore to a number (Canton 3.x JSON-encodes Daml `Int` as string)', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      arg['humanScore'] = '90';
    }
    const parsed = SubmitAndWaitResponseSchema.parse(body);
    const parsedArg = parseKycCredentialPayload(
      parsed.transaction.events[0]?.CreatedEvent?.createArgument,
    );
    expect(parsedArg.humanScore).toBe(90);
    expect(typeof parsedArg.humanScore).toBe('number');
  });

  it('rejects a non-integer humanScore string', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      arg['humanScore'] = 'abc';
    }
    expect(parseSubmitWithCredentialPayload(body).ok).toBe(false);
  });

  it('rejects a string-encoded humanScore that exceeds the 0..100 invariant', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      arg['humanScore'] = '150';
    }
    expect(parseSubmitWithCredentialPayload(body).ok).toBe(false);
  });

  it('rejects a non-ISO validUntil', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      arg['validUntil'] = '2027/04/11';
    }
    expect(parseSubmitWithCredentialPayload(body).ok).toBe(false);
  });

  it('rejects a date-only validUntil (Daml `Time` requires full timestamp)', () => {
    const body = buildCreateSubmitResponse();
    const created = (
      body['transaction'] as { events: Array<{ CreatedEvent: Record<string, unknown> }> }
    ).events[0]?.CreatedEvent;
    if (created) {
      const arg = created['createArgument'] as Record<string, unknown>;
      arg['validUntil'] = '2027-04-11';
    }
    expect(parseSubmitWithCredentialPayload(body).ok).toBe(false);
  });

  it('tolerates an optional createdEventBlob when present and base64', () => {
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

describe('SubmitAndWaitResponseSchema — verify', () => {
  // the template returns a `CredentialView` struct from
  // the `Verify` choice. The wire schema only validates the
  // `ExercisedEvent` envelope (not the struct shape, which is parsed
  // by `KycCredentialViewSchema` in `ledger.ts`); these tests pin
  // that the envelope round-trips cleanly with both an "active" and
  // a "revoked" view.
  it('accepts a Verify exercise response with an isActive=true view', () => {
    const parsed = SubmitAndWaitResponseSchema.parse(buildVerifySubmitResponse(true));
    const exercised = parsed.transaction.events[0]?.ExercisedEvent;
    expect(exercised?.choice).toBe('Verify');
    expect((exercised?.exerciseResult as { isActive: boolean }).isActive).toBe(true);
  });

  it('accepts a Verify exercise response with an isActive=false view', () => {
    const parsed = SubmitAndWaitResponseSchema.parse(buildVerifySubmitResponse(false));
    const exercised = parsed.transaction.events[0]?.ExercisedEvent;
    expect((exercised?.exerciseResult as { isActive: boolean }).isActive).toBe(false);
    // status flips with the active flag so the snapshot stays
    // internally consistent (Active when isActive, Revoked otherwise).
    expect((exercised?.exerciseResult as { status: string }).status).toBe('Revoked');
  });

  it('tolerates a non-consuming exercise (consuming: false)', () => {
    const body = buildVerifySubmitResponse(true);
    // consuming is already false in the fixture; assert parser accepts it
    expect(SubmitAndWaitResponseSchema.safeParse(body).success).toBe(true);
  });
});

describe('SubmitAndWaitResponseSchema — revoke', () => {
  it('accepts a RevokeCredential exercise response with unit result', () => {
    const parsed = SubmitAndWaitResponseSchema.parse(buildRevokeSubmitResponse());
    const exercised = parsed.transaction.events[0]?.ExercisedEvent;
    expect(exercised?.choice).toBe('RevokeCredential');
    expect(exercised?.consuming).toBe(true);
    expect(exercised?.exerciseResult).toEqual({});
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

  it('rejects a bogus validator enum at the credential-payload parse step', () => {
    // The ACS response schema keeps `createArgument` lax (the same
    // envelope ships KycCredential + KycNFT mints), so a bogus
    // validator enum no longer trips the top-level parse. The
    // invariant is enforced at the next stage —
    // `parseKycCredentialPayload` — which `query.ts::hydrateActiveContract`
    // calls before exposing the typed payload to callers.
    const entry = buildAcsEntry();
    const created = entry['contractEntry'] as {
      JsActiveContract: { createdEvent: { createArgument: Record<string, unknown> } };
    };
    created.JsActiveContract.createdEvent.createArgument['validator'] = 'BadValidator';

    // ACS schema accepts (createArgument is `unknown`).
    expect(ActiveContractsResponseSchema.safeParse([entry]).success).toBe(true);

    // Re-parse rejects.
    expect(() =>
      parseKycCredentialPayload(
        created.JsActiveContract.createdEvent.createArgument,
      ),
    ).toThrow();
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
    const created = buildCreatedEvent({ humanScore: 42, level: 'Enhanced' });
    expect((created['createArgument'] as Record<string, unknown>)['humanScore']).toBe(42);
    expect((created['createArgument'] as Record<string, unknown>)['level']).toBe('Enhanced');
  });
});
