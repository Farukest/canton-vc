/**
 * canton-vc issuer-demo — CLI entry point.
 *
 * Walks the issuer pipeline end-to-end against a vendor-agnostic
 * `KycProvider` and an in-memory Canton mock:
 *
 *   1. Build adapter         — mock / didit / sumsub / persona via .env
 *   2. startSession          — vendor returns sessionId + redirectUrl
 *   3. fetchDecision         — poll until terminal (instant for mock,
 *                              up to 30 min for real vendor sandbox)
 *   4. createCredential      — mock canton accepts the mint, returns
 *                              a deterministic contractId
 *   5. Log result            — print the inputs the on-chain payload
 *                              carries so the reader can match the
 *                              SDK call sites to the Daml template
 *
 * The on-chain leg is mocked locally; for a full mint round-trip
 * against a real Canton participant use the canton-vc repo's
 * `scripts/live-*-canton-*-e2e.ts` scripts.
 *
 * The on-chain credential payload is the CIP #204 storage shape:
 * `issuer / holder / admin / claims (TextMap) / createdAt /
 * expiresAt / meta`. Application-specific KYC fields (level,
 * validator, humanScore, *Verified flags) are encoded as text
 * claim values under an application-chosen reverse-DNS namespace —
 * here we use `com.example/*` for the demo.
 *
 * @module
 */

import { config as loadDotenv } from 'dotenv';

import type { Claims, CreateCredentialInput } from '@canton-vc/core';

import { buildAdapter, resolveVendor, type VendorId } from './adapter-factory.js';
import { MockCantonClient } from './mock-canton.js';

/* eslint-disable no-console */

loadDotenv({ quiet: true });

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 30 * 60 * 1000;

/**
 * Demo namespace for claim keys. A real issuer would use their own
 * reverse-DNS namespace (e.g. `io.acme/*`).
 */
const DEMO_NS = 'com.example';

const VENDOR_TO_VALIDATOR_STRING: Readonly<Record<VendorId, string>> = Object.freeze({
  mock: 'GenericValidator',
  didit: 'DiditValidator',
  sumsub: 'SumsubValidator',
  persona: 'PersonaValidator',
});

function tag(phase: string): string {
  return `[${new Date().toISOString().slice(11, 19)}] ${phase}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  const vendor = resolveVendor(process.env['CANTON_VC_VENDOR']);

  console.log('canton-vc — issuer demo');
  console.log(`  vendor:  ${vendor}${vendor === 'mock' ? ' (no credentials needed)' : ''}`);
  console.log('  backend: in-memory Canton mock');
  console.log();

  const provider = buildAdapter(vendor);

  const userRef = `demo-${Date.now().toString(36)}`;
  console.log(tag('Step 1: provider.startSession({ workflow: "identity" })'));
  const session = await provider.startSession({ userRef, workflow: 'identity' });
  console.log(`  sessionId:    ${session.sessionId}`);
  console.log(`  redirectUrl:  ${session.redirectUrl}`);
  console.log(`  expiresAt:    ${session.expiresAt}`);
  console.log();

  if (vendor !== 'mock') {
    console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Open the URL above in a browser and complete the flow.');
    console.log('  Polling every 5 seconds for a terminal decision.');
    console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log();
  }

  console.log(tag('Step 2: provider.fetchDecision(sessionId)'));
  const started = Date.now();
  let decision = await provider.fetchDecision(session.sessionId);
  let lastStatus = '';
  while (decision.status === 'pending' || decision.status === 'in_review') {
    if (decision.status !== lastStatus) {
      console.log(`  ${tag('').slice(0, 10)} status=${decision.status}`);
      lastStatus = decision.status;
    }
    if (Date.now() - started > MAX_POLL_MS) {
      console.error('  Polling cap (30 min) hit. Exiting without mint.');
      process.exit(2);
    }
    await sleep(POLL_INTERVAL_MS);
    decision = await provider.fetchDecision(session.sessionId);
  }
  console.log(`  status:       ${decision.status}`);

  if (decision.status === 'declined') {
    console.log(`  reason:       ${decision.declineReason ?? '<none>'}`);
    console.log('\nClean exit — nothing to mint (declined).');
    process.exit(0);
  }
  if (decision.status === 'expired') {
    console.log('\nClean exit — nothing to mint (session expired).');
    process.exit(0);
  }
  if (decision.status !== 'approved') {
    console.error(`Unexpected terminal status: ${decision.status}`);
    process.exit(1);
  }

  const identityVerified = decision.evidence.identityVerified ?? false;
  const livenessVerified = decision.evidence.livenessVerified ?? false;
  const addressVerified = decision.evidence.addressVerified ?? false;
  const level = decision.level ?? 'basic';
  console.log(`  level:        ${level}`);
  console.log(`  identity:     ${identityVerified}`);
  console.log(`  liveness:     ${livenessVerified}`);
  console.log(`  address:      ${addressVerified}`);
  console.log(`  proofHash:    ${decision.proofHash.slice(0, 32)}…`);
  console.log(`  schemaId:     ${decision.proofSchemaId.slice(0, 32)}…`);
  console.log();

  console.log(tag('Step 3: canton.allocateParty() + canton.createCredential()'));
  const canton = new MockCantonClient();
  const issuerParty = await canton.allocateParty(`demoIssuer${Date.now()}`);
  const holderParty = await canton.allocateParty(`demoHolder${Date.now()}`);
  const expiresAt = decision.expiresAt.replace(/\.\d+Z$/, 'Z');

  // Build the claim map. Application-defined namespacing — here we
  // pick `com.example/*` as the demo's reverse-DNS prefix.
  const claims: Claims = {
    values: {
      [`${DEMO_NS}/userRef`]: decision.userRef,
      [`${DEMO_NS}/proofHash`]: decision.proofHash,
      [`${DEMO_NS}/proofSchemaId`]: decision.proofSchemaId,
      [`${DEMO_NS}/level`]: level === 'enhanced' ? 'Enhanced' : 'Basic',
      [`${DEMO_NS}/status`]: 'Active',
      [`${DEMO_NS}/humanScore`]: '95',
      [`${DEMO_NS}/validator`]: VENDOR_TO_VALIDATOR_STRING[vendor],
      [`${DEMO_NS}/identityVerified`]: identityVerified ? 'true' : 'false',
      [`${DEMO_NS}/livenessVerified`]: livenessVerified ? 'true' : 'false',
      [`${DEMO_NS}/addressVerified`]: addressVerified ? 'true' : 'false',
      [`${DEMO_NS}/network`]: 'Canton (in-memory mock)',
    },
    validFrom: null,
    validUntil: expiresAt,
    meta: {},
  };

  const input: CreateCredentialInput = {
    issuerParty,
    holderParty,
    adminParty: issuerParty,
    claims,
    expiresAt,
    meta: {},
  };
  const result = await canton.createCredential(input);
  console.log(`  contractId:   ${result.contractId.slice(0, 32)}…`);
  console.log(`  updateId:     ${result.updateId}`);
  console.log(`  recordTime:   ${result.recordTime}`);
  console.log();

  console.log(tag('done — credential minted to in-memory mock'));
  console.log();
  console.log('Next steps:');
  console.log('  • Run examples/verifier-demo to exercise verifyDisclosure().');
  console.log('  • Use scripts/live-*-canton-*-e2e.ts at the repo root for');
  console.log('    a real Canton participant mint round-trip.');
}

main().catch((err: unknown) => {
  console.error('\nissuer-demo failed:');
  console.error(err);
  process.exit(1);
});
