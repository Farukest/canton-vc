/**
 * Live end-to-end with MANUAL KYC submission via Didit:
 *
 *   DiditAdapter.startSession  → real session URL printed to stdout
 *   (you open it in a browser, scan your ID, take a selfie, finish)
 *   DiditAdapter.fetchDecision → polled until terminal (approved / declined)
 *   @canton-vc/core.createCredential → real on-chain mint with Didit-derived
 *     proofHash + DiditValidator constructor
 *   @canton-vc/credential.verifyDisclosure → DisclosedContract re-check
 *
 * Unlike `live-didit-test.ts` (which fetches decisions on pre-existing
 * hardcoded session ids) and `live-sumsub-canton-e2e.ts` (which uses
 * the sandbox `testCompleted` shortcut), this script exercises the
 * full human-in-the-loop path: a fresh Didit session you actually
 * complete by hand, then the canton-vc pipeline picks up the real
 * decision and mints it to Canton.
 *
 * Required env:
 *   DIDIT_API_KEY
 *   DIDIT_KYC_WORKFLOW_ID
 *   DIDIT_BASE_URL                (optional; defaults to https://verification.didit.me)
 *   DIDIT_WEBHOOK_SECRET          (optional; not used here, adapter requires it for construction)
 *   CANTON_JSON_API_BASE_URL
 *   CANTON_NETWORK / CANTON_NETWORK_LABEL
 *
 * Run:
 *     pnpm exec tsx scripts/live-didit-canton-manual-e2e.ts
 *
 * Then open the printed URL in a browser, complete the verification,
 * and wait. The script polls Didit every 5 seconds and prints status
 * transitions. When it reaches a terminal state, it mints (on
 * approve) or exits cleanly (on decline / expire).
 */

/* eslint-disable no-console */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DiditAdapter } from '../packages/adapter-didit/src/index';
import {
  CantonClient,
  type CantonConfig,
  CantonConfigSchema,
  type PartyId,
  type Validator,
} from '../packages/core/src/index';
import { verifyDisclosure } from '../packages/credential/src/canton';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ---------- env ---------- */

function loadDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const envFile = {
  ...loadDotEnv(resolve(process.cwd(), '.env')),
  ...loadDotEnv(resolve(process.cwd(), '.env.local')),
};
const env: Record<string, string | undefined> = { ...envFile, ...process.env };

function required(key: string): string {
  const v = env[key];
  if (typeof v !== 'string' || v.length === 0) {
    console.error(`Missing required env var: ${key}`);
    process.exit(2);
  }
  return v;
}

const DIDIT_API_KEY = required('DIDIT_API_KEY');
const DIDIT_KYC_WORKFLOW_ID = required('DIDIT_KYC_WORKFLOW_ID');
const DIDIT_BASE_URL = env.DIDIT_BASE_URL ?? 'https://verification.didit.me';
const DIDIT_WEBHOOK_SECRET = env.DIDIT_WEBHOOK_SECRET ?? 'unused-but-required-by-adapter';
const BASE_URL = env.CANTON_JSON_API_BASE_URL ?? 'http://localhost:17575';
const NETWORK = (env.CANTON_NETWORK ?? 'devnet') as 'devnet' | 'mainnet' | 'testnet';
const NETWORK_LABEL = env.CANTON_NETWORK_LABEL ?? 'Canton DevNet';
const AUTH_TOKEN = env.CANTON_AUTH_TOKEN;

const DAR_PATH = resolve(
  __dirname,
  '..',
  'daml',
  'canton-vc-credential',
  'release',
  'canton-vc-credential-1.1.0.dar',
);
const PACKAGE_ID =
  '02806dc9e912f57a61ad83a0f8b300452baf4f734cd259d56458c9b1023d4421';

/* ---------- helpers ---------- */

const AUTH_HEADERS =
  AUTH_TOKEN !== undefined && AUTH_TOKEN.length > 0
    ? { Authorization: `Bearer ${AUTH_TOKEN}` }
    : {};

async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T | null; raw: string }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...AUTH_HEADERS, ...(init.headers ?? {}) },
  });
  const raw = await res.text();
  let body: T | null = null;
  try {
    body = raw.length > 0 ? (JSON.parse(raw) as T) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, raw };
}

function tag(phase: string): string {
  return `[${new Date().toISOString().slice(11, 19)}] ${phase}`;
}

function fail(phase: string, info: unknown): never {
  console.error(`\n${tag(phase)} FAILED`);
  console.error(info);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function uploadDarIfMissing(): Promise<void> {
  const pkgList = await fetchJson<{ packageIds: string[] }>('/v2/packages');
  if (pkgList.status !== 200 || pkgList.body === null) {
    fail('canton-dar', { reason: 'package list not 200', detail: pkgList });
  }
  if (pkgList.body.packageIds.includes(PACKAGE_ID)) {
    console.log(`  DAR already on participant (${PACKAGE_ID.slice(0, 16)}…)`);
    return;
  }
  if (!existsSync(DAR_PATH)) fail('canton-dar', { reason: 'DAR not found', DAR_PATH });
  const dar = readFileSync(DAR_PATH);
  console.log(`  uploading DAR (${dar.length} bytes)…`);
  const up = await fetchJson<unknown>('/v2/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: dar,
  });
  if (up.status !== 200) fail('canton-dar', { reason: 'DAR upload failed', detail: up });
}

async function allocateParty(hint: string): Promise<PartyId> {
  const res = await fetchJson<{ partyDetails: { party: string } }>('/v2/parties', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ partyIdHint: hint }),
  });
  if (res.status !== 200 || res.body === null) {
    fail('canton-parties', { reason: `allocate ${hint} failed`, detail: res });
  }
  return res.body.partyDetails.party as PartyId;
}

function buildConfig(operatorParty: PartyId): CantonConfig {
  const raw = {
    baseUrl: BASE_URL,
    authToken: AUTH_TOKEN ?? null,
    requestTimeoutMs: 10_000,
    submitTimeoutMs: 90_000,
    maxRetries: 2,
    retryBaseDelayMs: 250,
    operatorParty,
    userId: 'canton-vc-didit-manual',
    packageName: '#canton-vc-credential:Canton.VC.Credential:Credential',
    network: NETWORK,
    networkLabel: NETWORK_LABEL,
    commandIdPrefix: 'e2e',
    maxCommandBodyBytes: 65_536,
    allocateMissingParties: false,
  };
  const parsed = CantonConfigSchema.safeParse(raw);
  if (!parsed.success) {
    fail('canton-config', { reason: 'config invalid', issues: parsed.error.issues });
  }
  return parsed.data;
}

/* ---------- driver ---------- */

async function main(): Promise<void> {
  console.log(`canton-vc Didit MANUAL → SDK → DAR live E2E
  Didit:   ${DIDIT_BASE_URL}
  Canton:  ${BASE_URL} (${NETWORK_LABEL})\n`);

  // ----- phase 1: open a fresh Didit session -----
  console.log(tag('phase 1: DiditAdapter.startSession'));
  const adapter = new DiditAdapter({
    apiKey: DIDIT_API_KEY,
    webhookSecret: DIDIT_WEBHOOK_SECRET,
    kycWorkflowId: DIDIT_KYC_WORKFLOW_ID,
    baseUrl: DIDIT_BASE_URL,
  });

  const userRef = `cvc-e2e-${Date.now().toString(36)}`;
  const session = await adapter.startSession({ userRef });
  console.log(`  sessionId:   ${session.sessionId}`);
  console.log(`  userRef:     ${userRef}`);
  console.log(`  expiresAt:   ${session.expiresAt}`);
  console.log();
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  OPEN THIS URL IN A BROWSER AND COMPLETE THE VERIFICATION:');
  console.log();
  console.log(`  ${session.redirectUrl}`);
  console.log();
  console.log('  Then come back — this script polls Didit every 5 seconds');
  console.log('  and continues automatically once the decision is terminal.');
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();

  // ----- phase 2: poll fetchDecision until terminal -----
  console.log(tag('phase 2: polling DiditAdapter.fetchDecision (5s interval)'));
  const POLL_INTERVAL_MS = 5_000;
  const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes
  const started = Date.now();
  let decision = await adapter.fetchDecision(session.sessionId);
  let lastStatus = '';
  while (decision.status === 'pending' || decision.status === 'in_review') {
    if (decision.status !== lastStatus) {
      console.log(`  ${tag('').slice(0, 10)} status=${decision.status}`);
      lastStatus = decision.status;
    }
    if (Date.now() - started > MAX_WAIT_MS) {
      fail('phase 2', { reason: '30-min poll cap hit', last: decision });
    }
    await sleep(POLL_INTERVAL_MS);
    decision = await adapter.fetchDecision(session.sessionId);
  }
  console.log(`  FINAL status=${decision.status}`);
  if (decision.status === 'declined') {
    console.log(`  Declined — reason: ${decision.declineReason ?? '<none>'}.`);
    console.log('  (this is a clean exit; nothing minted, nothing failed)');
    process.exit(0);
  }
  if (decision.status === 'expired') {
    console.log('  Expired before completion — nothing to mint, clean exit.');
    process.exit(0);
  }
  if (decision.status !== 'approved') {
    fail('phase 2', { reason: `unexpected terminal status: ${decision.status}`, decision });
  }

  console.log(
    `  decision: level=${decision.level ?? '-'}, identity=${decision.evidence.identityVerified}, liveness=${decision.evidence.livenessVerified}, address=${decision.evidence.addressVerified}`,
  );
  console.log(`  proofHash (Didit-derived): ${decision.proofHash.slice(0, 32)}…`);

  // ----- phase 3: participant + DAR + parties -----
  console.log(tag('phase 3: Canton bootstrap (DAR + parties)'));
  await uploadDarIfMissing();
  const ts = Date.now();
  const operator = await allocateParty(`canton-vc-didit-op-${ts}`);
  const user = await allocateParty(`canton-vc-didit-usr-${ts}`);
  console.log(`  operator: ${operator}`);
  console.log(`  user:     ${user}`);

  // ----- phase 4: mint with Didit-derived data -----
  console.log(tag('phase 4: mint Canton.VC.Credential (validator=DiditValidator)'));
  const config = buildConfig(operator);
  const canton = new CantonClient({ config });

  const validator: Validator = 'didit';
  const mint = await canton.createCredential({
    userParty: user,
    userRef: decision.userRef,
    proofHash: decision.proofHash,
    proofSchemaId: decision.proofSchemaId,
    status: 'active',
    level: decision.level ?? 'basic',
    validUntil: decision.expiresAt.replace(/\.\d+Z$/, 'Z'),
    humanScore: 95,
    validator,
    identityVerified: decision.evidence.identityVerified,
    livenessVerified: decision.evidence.livenessVerified,
    addressVerified: decision.evidence.addressVerified,
  });
  console.log(`  contractId: ${mint.contractId}`);
  console.log(`  updateId:   ${mint.updateId}`);

  // ----- phase 5: verifyDisclosure -----
  console.log(tag('phase 5: verifyDisclosure() via DisclosedContract'));
  const bundle = await canton.fetchDisclosureBundleByContractId(mint.contractId);
  if (bundle === null) fail('phase 5', { reason: 'no disclosure bundle' });
  console.log(`  blob length: ${bundle.blobBase64.length} chars (base64)`);

  const view = await verifyDisclosure(
    {
      canton_vc_credential_blob: bundle.blobBase64,
      canton_vc_contract_id: mint.contractId,
    },
    { canton, fetcher: operator },
  );
  console.log(
    `  view: isActive=${view.isActive} userRef=${view.userRef} level=${view.level} validator=${view.validator}`,
  );
  if (!view.isActive) fail('phase 5', { reason: 'view.isActive not true', view });
  if (view.userRef !== decision.userRef) fail('phase 5', { reason: 'userRef mismatch', view });
  if (view.validator !== 'DiditValidator') fail('phase 5', { reason: 'validator mismatch', view });
  if (view.proofHash !== decision.proofHash) {
    fail('phase 5', { reason: 'proofHash mismatch', expected: decision.proofHash, actual: view.proofHash });
  }

  console.log(`\n${tag('E2E PASSED — manual Didit KYC + canton-vc SDK + DAR chain intact')}`);
}

main().catch((err: unknown) => {
  console.error('\nE2E FAILED — uncaught error:');
  console.error(err);
  process.exit(1);
});
