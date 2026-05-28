/**
 * canton-vc SDK live end-to-end test against a real Canton participant.
 *
 * Acts as TWO firms talking to one participant:
 *
 *   1. ISSUER firm — uses @canton-vc/core to allocate issuer + holder
 *      parties, mint a fresh `Canton.VC.Credential` contract under
 *      joint signatory (CIP #204), and read back the disclosed blob
 *      via the participant's ACS.
 *
 *   2. VERIFIER firm — uses @canton-vc/credential's `verifyDisclosure`
 *      to authenticate that blob via `DisclosedContract` and exercise
 *      the CIP #204 `Credential_PublicFetch` interface choice as a
 *      third-party verifier, then applies firm-side policy checks
 *      against the returned view.
 *
 * If both phases succeed, the canton-vc workspace is proven to work
 * end-to-end against a real ledger using pure SDK consumption only
 * (no KYC vendor involved — vendor-free chain-side smoke).
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
  type Claims,
  type ContractId,
  type CreateCredentialInput,
  createClaimSchema,
  getClaim,
  isWithinValidityWindow,
  type PartyId,
} from '../packages/core/src/index';
import { verifyDisclosure } from '../packages/credential/src/canton';
import type { CantonVcClaims } from '../packages/credential/src/types';

/* eslint-disable no-console */

const DEMO_KEYS = createClaimSchema('com.example', [
  'userRef',
  'proofHash',
  'proofSchemaId',
  'level',
  'status',
  'humanScore',
  'validator',
  'identityVerified',
  'livenessVerified',
  'addressVerified',
  'network',
] as const);

async function phaseIssuer(client: CantonClient): Promise<{
  contractId: ContractId;
  issuerParty: PartyId;
  holderParty: PartyId;
  userRef: string;
}> {
  console.log('\n━━━ Phase 1: ISSUER firm ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Step 1 — allocate fresh issuer + holder parties on the participant.
  // CIP #204 joint signatory: both parties must be hosted on the
  // submitting participant; a real production setup would have the
  // holder on their own participant, here we co-host for the smoke.
  const issuerHint = `LiveFirmIssuer${Date.now()}`;
  const holderHint = `LiveFirmHolder${Date.now()}`;
  console.log(`[issuer] allocateParty('${issuerHint}')…`);
  const issuerParty = await client.allocateParty(issuerHint);
  console.log(`[issuer] issuer party = ${issuerParty}`);
  console.log(`[issuer] allocateParty('${holderHint}')…`);
  const holderParty = await client.allocateParty(holderHint);
  console.log(`[issuer] holder party = ${holderParty}`);

  // Step 2 — build the credential payload. In a real pipeline this
  // is derived from a KYC vendor's decision (Didit / Sumsub /
  // Persona); here we hand-roll a fully-valid one so the script
  // exercises the chain side without any vendor dependency.
  const userRef = `live-test-${randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const claims: Claims = {
    values: {
      [DEMO_KEYS.userRef]: userRef,
      [DEMO_KEYS.proofHash]: '0'.repeat(64),
      [DEMO_KEYS.proofSchemaId]: '0'.repeat(64),
      [DEMO_KEYS.level]: 'Enhanced',
      [DEMO_KEYS.status]: 'Active',
      [DEMO_KEYS.humanScore]: '95',
      [DEMO_KEYS.validator]: 'GenericValidator',
      [DEMO_KEYS.identityVerified]: 'true',
      [DEMO_KEYS.livenessVerified]: 'true',
      [DEMO_KEYS.addressVerified]: 'true',
      [DEMO_KEYS.network]: client.config.networkLabel,
    },
    validFrom: now.toISOString(),
    validUntil: expiresAt.toISOString(),
    meta: {},
  };
  const input: CreateCredentialInput = {
    issuerParty,
    holderParty,
    adminParty: issuerParty,
    claims,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    meta: {},
  };

  // Step 3 — mint. CIP #204 joint signatory mint: `actAs` carries both
  // issuerParty and holderParty automatically.
  console.log('[issuer] createCredential() — submitting CreateCommand…');
  const result = await client.createCredential(input);
  console.log(`[issuer] minted contractId = ${result.contractId}`);
  console.log(`[issuer]         updateId   = ${result.updateId}`);
  console.log(`[issuer]         recordTime = ${result.recordTime}`);

  return { contractId: result.contractId, issuerParty, holderParty, userRef };
}

async function phaseVerifier(
  client: CantonClient,
  contractId: ContractId,
  issuerParty: PartyId,
  userRef: string,
): Promise<void> {
  console.log('\n━━━ Phase 2: VERIFIER firm ━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Step 1 — verifier firm allocates its own party (the `actor`
  // exercising the interface choice). On a real cross-participant
  // setup the verifier has their own participant; here we allocate
  // a distinct party on the same participant so the verify path is
  // structurally the same.
  const actorHint = `LiveFirmVerifier${Date.now()}`;
  console.log(`[verifier] allocateParty('${actorHint}')…`);
  const actor = await client.allocateParty(actorHint);
  console.log(`[verifier] actor party = ${actor}`);

  // Step 2 — fetch the contract's disclosed-event blob. A real
  // deployment receives this from the issuer's OAuth userinfo
  // response (`canton_vc_credential_blob` claim); here we simulate
  // that delivery by reading the just-minted blob from the ACS.
  console.log('[verifier] fetching disclosed blob from ACS…');
  const bundle = await client.fetchDisclosureBundleByContractId(contractId);
  if (bundle === null) {
    throw new Error(`Disclosure bundle for ${contractId} not found in ACS`);
  }
  console.log(`[verifier] blob length = ${bundle.blobBase64.length} chars (base64)`);

  // Step 3 — construct the userinfo-shaped claims the way a real
  // firm would receive them from the issuer's OAuth endpoint.
  const claims: CantonVcClaims = {
    sub: userRef,
    canton_vc_contract_id: contractId,
    canton_vc_credential_blob: bundle.blobBase64,
  };

  // Step 4 — verify via SDK helper. This attaches the blob as a
  // `DisclosedContract` on the CIP #204 `Credential_PublicFetch`
  // interface choice. The participant authenticates the blob
  // (sequencer signature + contract-id hash), the implementer's
  // choice body asserts `expectedAdmin == admin`, and the view is
  // returned to the third-party `actor`.
  console.log('[verifier] verifyDisclosure() — submitting Credential_PublicFetch choice…');
  const view = await verifyDisclosure(claims, {
    canton: client,
    actor,
    expectedAdmin: issuerParty,
  });

  console.log('\n━━━ VERIFICATION RESULT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(JSON.stringify(view, null, 2));

  // Step 5 — apply firm-side policy. These checks are the firm's
  // policy, not the SDK's responsibility. Under CIP #204 the view
  // exposes claims as a `TextMap Text` under the issuer's reverse-DNS
  // namespace; `isWithinValidityWindow(view)` derives activity from
  // `createdAt` / `expiresAt` against chain time.
  console.log('\n━━━ FIRM-SIDE POLICY CHECKS ━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const inWindow = isWithinValidityWindow(view);
  const observedStatus = getClaim(view.claims, DEMO_KEYS.status);
  const observedLevel = getClaim(view.claims, DEMO_KEYS.level);
  const observedUserRef = getClaim(view.claims, DEMO_KEYS.userRef);

  const isActiveOk = inWindow && observedStatus !== 'Revoked';
  const userRefMatchOk =
    typeof observedUserRef === 'string' &&
    (observedUserRef.includes(userRef) || userRef.includes(observedUserRef));
  const levelOk = observedLevel === 'Enhanced';

  console.log(`isActive       : ${isActiveOk ? '✓' : '✗'}  (inWindow=${inWindow}, status="${observedStatus ?? '—'}")`);
  console.log(`userRef match  : ${userRefMatchOk ? '✓' : '✗'}  (got "${observedUserRef ?? '—'}", expected "${userRef}")`);
  console.log(`level=Enhanced : ${levelOk ? '✓' : '✗'}  (got "${observedLevel ?? '—'}")`);

  if (!isActiveOk || !userRefMatchOk || !levelOk) {
    throw new Error('verifier-side policy checks failed');
  }
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  canton-vc LIVE FIRM TEST — vendor-free chain end-to-end');
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

  const { contractId, issuerParty, userRef } = await phaseIssuer(client);
  await phaseVerifier(client, contractId, issuerParty, userRef);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ✓ canton-vc SDK end-to-end PASSED — chain-side smoke');
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
