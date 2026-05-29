/**
 * canton-vc DiditAdapter live test against real Didit production API.
 *
 * Uses an existing DIDIT_API_KEY to call:
 *
 *   GET /v3/session/{id}/decision/
 *
 * on a hand-picked set of real session ids that landed in 3 distinct
 * terminal/intermediate states from past KYC flows:
 *
 *   - approved        (golden path)
 *   - identity_approved (intermediate, address phase pending)
 *   - expired         (decline path)
 *
 * For each, the script prints:
 *
 *   1. Didit's raw response (the wire shape Didit emits today).
 *   2. canton-vc's normalised KycDecision (what the adapter produces).
 *
 * Pin the parser against reality: if Didit changes their wire shape
 * (added field, renamed enum), the normalised output drifts and we
 * catch it here.
 *
 * Run:
 *     DIDIT_API_KEY=... pnpm exec tsx scripts/live-didit-test.ts
 */

import { DiditAdapter } from '../packages/adapter-didit/src/index';

/* eslint-disable no-console */

interface FixtureCase {
  readonly label: string;
  readonly sessionId: string;
  readonly expectedCantonVcStatus:
    | 'approved'
    | 'declined'
    | 'in_review'
    | 'pending'
    | 'expired';
}

const FIXTURES: readonly FixtureCase[] = [
  {
    label: 'approved (golden path)',
    sessionId: 'ef59095f-81fa-40e5-8784-3cf31f50cb0b',
    expectedCantonVcStatus: 'approved',
  },
  {
    label: 'identity_approved (intermediate)',
    sessionId: '078b09eb-4deb-4c3c-8aa6-0ac5bc609698',
    expectedCantonVcStatus: 'approved', // adapter maps Didit "Approved" → approved regardless of address phase
  },
  {
    label: 'expired',
    sessionId: '0e99bc17-f010-4000-8d17-0de2c8258815',
    expectedCantonVcStatus: 'expired',
  },
];

async function runCase(adapter: DiditAdapter, fixture: FixtureCase): Promise<boolean> {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${fixture.label}`);
  console.log(`  session_id = ${fixture.sessionId}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  let decision: Awaited<ReturnType<DiditAdapter['fetchDecision']>>;
  try {
    decision = await adapter.fetchDecision(fixture.sessionId);
  } catch (err: unknown) {
    console.log(`✗ adapter.fetchDecision() threw:`);
    console.log(err instanceof Error ? `   ${err.message}` : err);
    return false;
  }

  console.log('\n--- Didit RAW response (top-level fields) ---');
  const raw = (decision.raw ?? {}) as Record<string, unknown>;
  console.log(
    JSON.stringify(
      {
        session_id: raw['session_id'],
        status: raw['status'],
        vendor_data: raw['vendor_data'],
        expires_at: raw['expires_at'],
        kyc_status: (raw['kyc'] as Record<string, unknown> | null)?.['status'],
        liveness_status: (raw['liveness'] as Record<string, unknown> | null)?.['status'],
        face_match_status: (raw['face_match'] as Record<string, unknown> | null)?.['status'],
        face_match_score: (raw['face_match'] as Record<string, unknown> | null)?.['score'],
        address_status: (raw['address_verification'] as Record<string, unknown> | null)?.['status'],
      },
      null,
      2,
    ),
  );

  console.log('\n--- canton-vc NORMALISED decision ---');
  console.log(
    JSON.stringify(
      {
        sessionId: decision.sessionId,
        userRef: decision.userRef,
        status: decision.status,
        level: decision.level,
        evidence: decision.evidence,
        proofHashHex: `${decision.proofHash.slice(0, 16)}…${decision.proofHash.slice(-8)}`,
        expiresAt: decision.expiresAt,
      },
      null,
      2,
    ),
  );

  // Cross-check: does the normalised status match what we expect?
  const ok = decision.status === fixture.expectedCantonVcStatus;
  console.log(
    `\n${ok ? '✓' : '✗'} normalised status = "${decision.status}" (expected "${fixture.expectedCantonVcStatus}")`,
  );

  // Cross-check: raw status string is a documented value
  const rawStatus = raw['status'];
  const KNOWN = [
    'Not Started',
    'In Progress',
    'In Review',
    'Resubmitted',
    'Approved',
    'Declined',
    'Expired',
    'Abandoned',
    'Kyc Expired',
  ];
  const isKnownStatus = typeof rawStatus === 'string' && KNOWN.includes(rawStatus);
  console.log(
    `${isKnownStatus ? '✓' : '⚠'} raw Didit status "${String(rawStatus)}" is ${isKnownStatus ? '' : 'NOT '}in the documented enum`,
  );

  return ok && isKnownStatus;
}

async function main(): Promise<void> {
  const apiKey = process.env['DIDIT_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('DIDIT_API_KEY env var is required');
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  canton-vc DiditAdapter LIVE TEST — production Didit API');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  base URL  : ${process.env['DIDIT_BASE_URL'] ?? 'https://verification.didit.me'}`);
  console.log(`  workflow  : ${(process.env['DIDIT_KYC_WORKFLOW_ID'] ?? '').slice(0, 8)}…`);
  console.log(`  api key   : ${apiKey.slice(0, 8)}…`);
  console.log(`  fixtures  : ${FIXTURES.length}`);

  const adapter = new DiditAdapter({
    apiKey,
    webhookSecret: process.env['DIDIT_WEBHOOK_SECRET'] ?? 'unused-for-fetchDecision',
    kycWorkflowId: process.env['DIDIT_KYC_WORKFLOW_ID'] ?? 'unused-for-fetchDecision',
    ...(process.env['DIDIT_BASE_URL'] !== undefined
      ? { baseUrl: process.env['DIDIT_BASE_URL'] }
      : {}),
  });

  let passed = 0;
  for (const fixture of FIXTURES) {
    if (await runCase(adapter, fixture)) {
      passed += 1;
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Result: ${passed} / ${FIXTURES.length} cases passed`);
  console.log('═══════════════════════════════════════════════════════');

  if (passed !== FIXTURES.length) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('\n✗ FATAL');
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
