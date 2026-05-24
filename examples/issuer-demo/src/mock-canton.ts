/**
 * In-memory Canton mock for the issuer-demo CLI.
 *
 * The real `@canton-vc/core` `CantonClient` submits a `CreateCommand`
 * to a Canton participant over JSON Ledger v2, waits for confirmation,
 * and returns the on-chain contract id + update id. That requires a
 * running participant (`canton-vc-credential` DAR uploaded, party
 * namespace allocated, optional auth token). For a 30-second demo
 * this is overkill.
 *
 * `MockCantonClient` exposes the SAME shape (`allocateParty` +
 * `createCredential`) but resolves locally — no network, no
 * participant. The demo prints the inputs, prints what the
 * participant would have returned, and stops. The intent is to show
 * the issuer-side call sites and field flow, not to claim an on-chain
 * mint occurred.
 *
 * For the full on-chain leg (real participant, real DAR, real
 * sequencer signature) use `scripts/live-*-canton-*-e2e.ts` at the
 * canton-vc repo root.
 *
 * @module
 */

import { createHash, randomUUID } from 'node:crypto';

import type {
  CommandId,
  ContractId,
  CreateCredentialInput,
  CreateCredentialResult,
  LedgerOffset,
  PartyId,
  UpdateId,
} from '@canton-vc/core';

export class MockCantonClient {
  readonly networkLabel: string;

  constructor(networkLabel = 'Canton (in-memory mock)') {
    this.networkLabel = networkLabel;
  }

  async allocateParty(labelHint: string): Promise<PartyId> {
    // Real participants return `<Label>::1220<sha256-fingerprint>`.
    // Synthesize a structurally-identical value so downstream code
    // that parses the format keeps working.
    const fingerprint = createHash('sha256').update(`${labelHint}-${randomUUID()}`).digest('hex');
    return `${labelHint}::1220${fingerprint}` as PartyId;
  }

  async createCredential(input: CreateCredentialInput): Promise<CreateCredentialResult> {
    // The real participant would derive contractId from a Daml-LF
    // value hash. We hash the input fields deterministically so two
    // runs with identical input collide (matches real-network behavior
    // for replay protection).
    const idSource = [
      input.userParty,
      input.userRef,
      input.proofHash,
      input.proofSchemaId,
      input.status,
      input.level,
      input.validUntil,
      input.validator,
    ].join('|');
    const contractId = createHash('sha256').update(idSource).digest('hex') as unknown as ContractId;
    const commandId = `mock-cmd-${randomUUID()}` as CommandId;
    const updateId = `mock-upd-${randomUUID().replace(/-/g, '')}` as UpdateId;
    const now = new Date().toISOString();
    return Object.freeze({
      contractId,
      commandId,
      updateId,
      recordTime: now,
      completionOffset: '000000000000000000' as LedgerOffset,
    });
  }
}
