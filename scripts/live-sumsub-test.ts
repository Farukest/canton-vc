/**
 * canton-vc SumsubAdapter live test against real Sumsub sandbox.
 *
 * Drives the full SumsubAdapter surface against `https://api.sumsub.com`
 * using a sandbox token (sbx: prefix). No webhook needed, no user
 * action needed — Sumsub's sandbox supports synthetic applicants whose
 * review answer can be mocked through the `testCompleted` endpoint.
 *
 * Flow:
 *
 *   1. startSession → POST /resources/applicants + WebSDK link.
 *   2. POST /resources/applicants/{id}/status/testCompleted with
 *      reviewAnswer=GREEN to mock approval.
 *   3. fetchDecision → poll status until terminal, assert
 *      KycDecision shape matches expected.
 *   4. Self-sign a synthetic webhook payload + verifyWebhook →
 *      assert returns the same approved KycDecision (via enrichment).
 *
 * Pin: if Sumsub mutates their response shape, the adapter's parse
 * step will throw — surface here, fix in `schemas.ts`.
 *
 * Run:
 *     SUMSUB_APP_TOKEN=sbx:... SUMSUB_SECRET_KEY=... \
 *       SUMSUB_WEBHOOK_SECRET=... pnpm exec tsx scripts/live-sumsub-test.ts
 *
 * The webhook secret defaults to the secret key when not provided —
 * fine for the self-signed parse test path; only a real Sumsub-sent
 * webhook needs the per-endpoint webhook secret.
 */

import { createHmac, randomBytes } from 'node:crypto';

import { SumsubAdapter } from '../packages/adapter-sumsub/src/index';

/* eslint-disable no-console */

const appToken = process.env['SUMSUB_APP_TOKEN'];
const secretKey = process.env['SUMSUB_SECRET_KEY'];
const webhookSecret = process.env['SUMSUB_WEBHOOK_SECRET'] ?? secretKey;
const identityLevelName = process.env['SUMSUB_IDENTITY_LEVEL_NAME'] ?? 'basic-kyc-level';

if (typeof appToken !== 'string' || appToken.length === 0) {
  console.error('SUMSUB_APP_TOKEN env var is required.');
  process.exit(2);
}
if (typeof secretKey !== 'string' || secretKey.length === 0) {
  console.error('SUMSUB_SECRET_KEY env var is required.');
  process.exit(2);
}
if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
  console.error('SUMSUB_WEBHOOK_SECRET env var is required.');
  process.exit(2);
}

if (!appToken.startsWith('sbx:')) {
  console.error('Refusing to run live test against a non-sandbox token (must start with `sbx:`).');
  process.exit(2);
}

const adapter = new SumsubAdapter({
  appToken,
  secretKey,
  webhookSecret,
  identityLevelName,
});

const externalUserId = `cvc-livetest-${randomBytes(6).toString('hex')}`;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Raw sandbox-only helper: POST /resources/applicants/{id}/status/testCompleted
// with reviewAnswer=GREEN flips the applicant to completed/GREEN
// without requiring document uploads. Sumsub documents this as the
// sandbox automation primitive.
async function mockApprove(applicantId: string): Promise<void> {
  const path = `/resources/applicants/${encodeURIComponent(applicantId)}/status/testCompleted`;
  const body = JSON.stringify({
    reviewAnswer: 'GREEN',
    rejectLabels: [],
    reviewRejectType: undefined,
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', secretKey!).update(`${ts}POST${path}${body}`).digest('hex');
  const res = await fetch(`https://api.sumsub.com${path}`, {
    method: 'POST',
    headers: {
      'X-App-Token': appToken!,
      'X-App-Access-Sig': sig,
      'X-App-Access-Ts': ts,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Sumsub testCompleted returned ${res.status}: ${text.slice(0, 400)}`);
  }
}

async function main(): Promise<void> {
  console.log('=== canton-vc SumsubAdapter live sandbox test ===');
  console.log('externalUserId:', externalUserId);
  console.log('identityLevelName:', identityLevelName);
  console.log();

  console.log('STEP 1 → startSession (createApplicant + websdkLink)');
  const session = await adapter.startSession({ userRef: externalUserId });
  console.log('  sessionId (applicantId):', session.sessionId);
  console.log('  redirectUrl (WebSDK):   ', session.redirectUrl);
  console.log('  expiresAt:               ', session.expiresAt);
  console.log();

  console.log('STEP 2 → mock approval (sandbox-only)');
  await mockApprove(session.sessionId);
  console.log('  testCompleted accepted; awaiting completed reviewStatus…');
  console.log();

  console.log('STEP 3 → poll fetchDecision until terminal');
  let decision = await adapter.fetchDecision(session.sessionId);
  let attempts = 0;
  while (decision.status === 'pending' || decision.status === 'in_review') {
    if (attempts >= 20) {
      console.error('  TIMEOUT — sandbox did not transition within 60s. Last decision:');
      console.error(decision);
      process.exit(3);
    }
    await sleep(3000);
    decision = await adapter.fetchDecision(session.sessionId);
    attempts += 1;
    console.log(`  attempt ${attempts}: status=${decision.status}`);
  }
  console.log('  FINAL decision:');
  console.log(JSON.stringify(decision, null, 2));
  console.log();

  if (decision.status !== 'approved') {
    console.error(`✗ Expected status='approved', got '${decision.status}'`);
    process.exit(4);
  }
  if (decision.level !== 'basic') {
    console.error(`✗ Expected level='basic', got '${decision.level ?? 'undefined'}'`);
    process.exit(4);
  }
  if (decision.evidence.identityVerified !== true) {
    console.error('✗ Expected evidence.identityVerified=true');
    process.exit(4);
  }
  if (typeof decision.proofHash !== 'string' || decision.proofHash.length !== 64) {
    console.error('✗ Expected proofHash to be a 64-char hex digest');
    process.exit(4);
  }
  console.log('✓ Live fetchDecision returns the expected KycDecision shape.');
  console.log();

  console.log('STEP 4 → self-sign a synthetic webhook payload and verifyWebhook');
  const webhookBody = {
    applicantId: session.sessionId,
    inspectionId: 'inspection_synthetic',
    correlationId: 'corr_synthetic',
    externalUserId,
    levelName: identityLevelName,
    type: 'applicantReviewed',
    reviewStatus: 'completed',
    reviewResult: {
      reviewAnswer: 'GREEN',
      rejectLabels: [],
    },
    createdAtMs: Date.now().toString(),
  };
  const raw = JSON.stringify(webhookBody);
  const sig = createHmac('sha256', webhookSecret!).update(raw).digest('hex');
  const event = await adapter.verifyWebhook(raw, {
    'X-Payload-Digest': sig,
    'X-Payload-Digest-Alg': 'HMAC_SHA256_HEX',
  });
  if (event === null) {
    console.error('✗ verifyWebhook returned null on a valid synthetic webhook.');
    process.exit(5);
  }
  if (event.type !== 'decision') {
    console.error(`✗ Expected event.type='decision', got '${event.type}'`);
    process.exit(5);
  }
  console.log('  enriched webhook event:');
  console.log(JSON.stringify(event, null, 2));
  console.log();
  if (event.decision.status !== 'approved') {
    console.error('✗ Webhook-derived decision did not match the live applicant state.');
    process.exit(5);
  }
  console.log('✓ verifyWebhook accepted self-signed payload and auto-enriched to the live state.');

  console.log();
  console.log('=== ALL CHECKS PASSED ===');
  console.log('  applicantId:', session.sessionId);
  console.log('  externalUserId:', externalUserId);
  console.log('  status: approved | level: basic | identityVerified: true');
}

main().catch((err) => {
  console.error('Live test FAILED:', err);
  process.exit(1);
});
