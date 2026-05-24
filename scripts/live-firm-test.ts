/**
 * canton-vc SDK live end-to-end test against a real Canton participant.
 *
 * Acts as TWO firms talking to one DevNet:
 *
 *   1. ISSUER firm  — uses @canton-vc/core to allocate a user party,
 *      mint a fresh Canton.VC.Credential contract, and query the ACS
 *      for the just-minted blob.
 *
 *   2. VERIFIER firm — uses @canton-vc/credential's verifyDisclosure()
 *      to authenticate the same blob via DisclosedContract on the
 *      participant, exercising the Verify choice as a third-party
 *      fetcher.
 *
 * If both phases succeed, the canton-vc workspace is proven to work
 * end-to-end against a real ledger using pure SDK consumption only.
 *
 * Pre-conditions:
 *   - SSH tunnel up: localhost:17575 → Canton participant
 *   - CANTON_* env vars set (CANTON_JSON_API_BASE_URL,
 *     CANTON_OPERATOR_PARTY, CANTON_PACKAGE_NAME, CANTON_NETWORK,
 *     CANTON_USER_ID). This script reads them from process.env
 *     directly, no .env loader.
 *
 * Run:
 *     pnpm exec tsx scripts/live-firm-test.ts
 */

import { randomUUID } from 'node:crypto';

import {
  buildCantonClientFromEnv,
  type CantonClient,
  type ContractId,
  type CreateCredentialInput,
  type PartyId,
} from '../packages/core/src/index';
import { verifyDisclosure } from '../packages/credential/src/canton';
import type { CantonVcClaims } from '../packages/credential/src/types';

/* eslint-disable no-console */

async function phaseIssuer(client: CantonClient): Promise<{
  contractId: ContractId;
  userParty: PartyId;
  userRef: string;
}> {
  console.log('\n━━━ Phase 1: ISSUER firm ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Step 1 — allocate a fresh user party on the participant.
  // A real issuer would pre-allocate or reuse; we generate per-run
  // so the script is idempotent across executions.
  const labelHint = `LiveTestUser${Date.now()}`;
  console.log(`[issuer] allocateParty('${labelHint}')…`);
  const userParty = await client.allocateParty(labelHint);
  console.log(`[issuer] user party = ${userParty}`);

  // Step 2 — build the credential payload. In a real pipeline this
  // is derived from the KYC vendor's decision (Didit / Onfido / …);
  // here we hand-roll a fully-valid one.
  const userRef = `live-test-${randomUUID()}`;
  const input: CreateCredentialInput = {
    userParty,
    userRef,
    proofHash: '0'.repeat(64),
    status: 'active',
    level: 'enhanced',
    validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    humanScore: 95,
    validator: 'didit',
    identityVerified: true,
    livenessVerified: true,
    addressVerified: true,
  };

  // Step 3 — mint. This submits a CreateCommand to the participant
  // and waits for confirmation.
  console.log('[issuer] createCredential() — submitting CreateCommand…');
  const result = await client.createCredential(input);
  console.log(`[issuer] minted contractId = ${result.contractId}`);
  console.log(`[issuer]         updateId   = ${result.updateId}`);
  console.log(`[issuer]         recordTime = ${result.recordTime}`);

  return { contractId: result.contractId, userParty, userRef };
}

async function phaseVerifier(
  client: CantonClient,
  contractId: ContractId,
  userRef: string,
): Promise<void> {
  console.log('\n━━━ Phase 2: VERIFIER firm ━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Step 1 — verifier firm allocates its own party (or uses an
  // existing one). On a real cross-participant setup the verifier
  // would have its own participant; on DevNet we allocate a
  // distinct fetcher on the same participant so the verify path
  // is structurally the same.
  const labelHint = `LiveTestVerifierFirm${Date.now()}`;
  console.log(`[verifier] allocateParty('${labelHint}')…`);
  const fetcher = await client.allocateParty(labelHint);
  console.log(`[verifier] fetcher party = ${fetcher}`);

  // Step 2 — fetch the contract's blob from ACS. In a real
  // deployment the issuer ships the blob to the verifier via the
  // OAuth userinfo response (`canton_vc_credential_blob` claim).
  // Here we simulate that delivery by querying our own participant
  // — the issuer just minted, so the blob is available locally.
  console.log('[verifier] fetching disclosed blob from ACS…');
  const all = await client.listActiveCredentials({ includeBlob: true });
  const ours = all.find((c) => c.contractId === contractId);
  if (ours === undefined) {
    throw new Error(`Contract ${contractId} not found in ACS`);
  }
  if (ours.createdEventBlob === null) {
    throw new Error('Active contract found but createdEventBlob was null');
  }
  console.log(`[verifier] blob length = ${ours.createdEventBlob.length} chars`);

  // Step 3 — construct the userinfo-shaped claims the way a real
  // firm would receive them from the issuer's OAuth endpoint.
  const claims: CantonVcClaims = {
    sub: userRef,
    canton_vc_contract_id: contractId,
    canton_vc_credential_blob: ours.createdEventBlob,
  };

  // Step 4 — verify via SDK helper. This attaches the blob as a
  // DisclosedContract on the Verify choice exercise. The
  // participant authenticates the blob (sequencer signature +
  // contract-id hash), runs the choice body, returns the view.
  console.log('[verifier] verifyDisclosure() — submitting Verify choice…');
  const view = await verifyDisclosure(claims, { canton: client, fetcher });

  console.log('\n━━━ VERIFICATION RESULT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(JSON.stringify(view, null, 2));

  // Step 5 — apply firm-side policy. These checks are the firm's
  // policy, not the SDK's responsibility.
  console.log('\n━━━ FIRM-SIDE POLICY CHECKS ━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const isActiveOk = view.isActive === true;
  const userRefMatchOk = view.userRef.includes(userRef) || userRef.includes(view.userRef);
  const levelOk = view.level === 'Enhanced';
  console.log(`isActive       : ${isActiveOk ? '✓' : '✗'}  (got ${String(view.isActive)})`);
  console.log(`userRef match  : ${userRefMatchOk ? '✓' : '✗'}  (got "${view.userRef}", expected "${userRef}")`);
  console.log(`level=Enhanced : ${levelOk ? '✓' : '✗'}  (got "${view.level}")`);

  if (!isActiveOk || !userRefMatchOk || !levelOk) {
    throw new Error('verifier-side policy checks failed');
  }
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  canton-vc LIVE FIRM TEST — DevNet end-to-end');
  console.log('═══════════════════════════════════════════════════════');

  const client = buildCantonClientFromEnv(process.env);
  console.log(`participant : ${client.config.baseUrl}`);
  console.log(`operator    : ${client.config.operatorParty}`);
  console.log(`network     : ${client.config.networkLabel} (${client.config.network})`);
  console.log(`package     : ${client.config.packageName}`);

  // Health probe
  console.log('\n[probe] getLedgerEnd()…');
  const offset = await client.getLedgerEnd();
  console.log(`[probe] ledger-end offset = ${offset}`);

  const { contractId, userRef } = await phaseIssuer(client);
  await phaseVerifier(client, contractId, userRef);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ✓ canton-vc SDK end-to-end PASSED on real DevNet');
  console.log('═══════════════════════════════════════════════════════');
}

main().catch((err: unknown) => {
  console.error('\n✗ TEST FAILED');
  if (err instanceof Error) {
    console.error(err.message);
    if (err.cause !== undefined) {
      console.error('cause:', err.cause);
    }
  } else {
    console.error(err);
  }
  process.exit(1);
});
