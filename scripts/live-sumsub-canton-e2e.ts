/**
 * Pure-SDK end-to-end: Sumsub sandbox vendor → canton-vc SDK →
 * canton-vc DAR mint + verify on a real Canton participant.
 *
 * Unlike `live-canton-e2e.ts` (synthetic data → Canton) and
 * `live-sumsub-test.ts` (Sumsub adapter only), this script wires the
 * two halves together: the Sumsub-derived `KycDecision` feeds the
 * Canton `createCredential` call, and the on-chain payload carries
 * the real `proofHash` (SHA-256 of the canonical Sumsub response) and
 * the `SumsubValidator` DAML constructor.
 *
 * What this proves:
 *
 *   1. `@canton-vc/adapter-sumsub` produces a `KycDecision` that maps
 *      cleanly into `CreateCredentialInput` with vendor-neutral
 *      glue.
 *   2. The canton-vc DAR is willing to accept `SumsubValidator` as a
 *      `validator` field value (the SDK ↔ DAML validator-enum drift
 *      was real, this script confirms the fix).
 *   3. The full pipe runs against the published Sumsub sandbox API
 *      and the running Canton devnet participant without touching
 *      any reference-issuer code path.
 *
 * Required env:
 *   SUMSUB_APP_TOKEN          sbx: prefix
 *   SUMSUB_SECRET_KEY
 *   SUMSUB_WEBHOOK_SECRET     (optional; defaults to SUMSUB_SECRET_KEY)
 *   SUMSUB_IDENTITY_LEVEL_NAME (optional; defaults to 'basic-kyc-level')
 *   CANTON_JSON_API_BASE_URL  e.g. http://localhost:17575
 *   CANTON_NETWORK / CANTON_NETWORK_LABEL
 *
 * Run:
 *     SUMSUB_APP_TOKEN=sbx:... SUMSUB_SECRET_KEY=... \
 *       pnpm exec tsx scripts/live-sumsub-canton-e2e.ts
 */

/* eslint-disable no-console */

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CantonClient,
  type CantonConfig,
  CantonConfigSchema,
  type ContractId,
  type PartyId,
  type Validator,
} from '../packages/core/src/index';
import { verifyDisclosure } from '../packages/credential/src/canton';
import { SumsubAdapter } from '../packages/adapter-sumsub/src/index';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ---------- env loading ---------- */

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

const APP_TOKEN = required('SUMSUB_APP_TOKEN');
const SECRET_KEY = required('SUMSUB_SECRET_KEY');
const WEBHOOK_SECRET = env.SUMSUB_WEBHOOK_SECRET ?? SECRET_KEY;
const IDENTITY_LEVEL_NAME = env.SUMSUB_IDENTITY_LEVEL_NAME ?? 'basic-kyc-level';
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

if (!APP_TOKEN.startsWith('sbx:')) {
  console.error('Refusing to run against a non-sandbox Sumsub token (must start with `sbx:`).');
  process.exit(2);
}

/* ---------- helpers ---------- */

function tag(phase: string): string {
  return `[${new Date().toISOString().slice(11, 19)}] ${phase}`;
}

function fail(phase: string, info: unknown): never {
  console.error(`\n${tag(phase)} FAILED`);
  console.error(info);
  process.exit(1);
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------- Sumsub sandbox helpers ---------- */

async function mockApproveSumsub(applicantId: string): Promise<void> {
  const path = `/resources/applicants/${encodeURIComponent(applicantId)}/status/testCompleted`;
  const body = JSON.stringify({
    reviewAnswer: 'GREEN',
    rejectLabels: [],
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', SECRET_KEY).update(`${ts}POST${path}${body}`).digest('hex');
  const res = await fetch(`https://api.sumsub.com${path}`, {
    method: 'POST',
    headers: {
      'X-App-Token': APP_TOKEN,
      'X-App-Access-Sig': sig,
      'X-App-Access-Ts': ts,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    fail('phase 2', { reason: `testCompleted ${res.status}`, body: text.slice(0, 400) });
  }
}

/* ---------- Canton bootstrap helpers ---------- */

async function uploadDarIfMissing(): Promise<void> {
  const pkgList = await fetchJson<{ packageIds: string[] }>('/v2/packages');
  if (pkgList.status !== 200 || pkgList.body === null) {
    fail('phase 4', { reason: 'package list not 200', detail: pkgList });
  }
  if (pkgList.body.packageIds.includes(PACKAGE_ID)) {
    console.log(`  DAR already uploaded (pkg ${PACKAGE_ID.slice(0, 16)}…)`);
    return;
  }
  if (!existsSync(DAR_PATH)) fail('phase 4', { reason: 'DAR not found', DAR_PATH });
  const dar = readFileSync(DAR_PATH);
  console.log(`  uploading DAR (${dar.length} bytes)…`);
  const up = await fetchJson<unknown>('/v2/packages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: dar,
  });
  if (up.status !== 200) fail('phase 4', { reason: 'DAR upload failed', detail: up });
}

async function allocateParty(hint: string): Promise<PartyId> {
  const res = await fetchJson<{ partyDetails: { party: string } }>('/v2/parties', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ partyIdHint: hint }),
  });
  if (res.status !== 200 || res.body === null) {
    fail('phase 5', { reason: `allocate ${hint} failed`, detail: res });
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
    userId: 'canton-vc-sumsub-e2e',
    packageName: '#canton-vc-credential:Canton.VC.Credential:Credential',
    network: NETWORK,
    networkLabel: NETWORK_LABEL,
    commandIdPrefix: 'e2e',
    maxCommandBodyBytes: 65_536,
    allocateMissingParties: false,
  };
  const parsed = CantonConfigSchema.safeParse(raw);
  if (!parsed.success) fail('phase 6', { reason: 'config invalid', issues: parsed.error.issues });
  return parsed.data;
}

/* ---------- driver ---------- */

async function main(): Promise<void> {
  console.log(
    `canton-vc Sumsub → SDK → DAR live E2E
  Sumsub sandbox: ${IDENTITY_LEVEL_NAME}
  Canton:         ${BASE_URL} (${NETWORK_LABEL})\n`,
  );

  // ----- phase 1: Sumsub adapter startSession -----
  console.log(tag('phase 1: SumsubAdapter.startSession'));
  const adapter = new SumsubAdapter({
    appToken: APP_TOKEN,
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    identityLevelName: IDENTITY_LEVEL_NAME,
  });
  const externalUserId = `cvc-e2e-${randomBytes(6).toString('hex')}`;
  const session = await adapter.startSession({ userRef: externalUserId });
  console.log(`  externalUserId: ${externalUserId}`);
  console.log(`  applicantId:    ${session.sessionId}`);

  // ----- phase 2: sandbox mock approval -----
  console.log(tag('phase 2: sandbox testCompleted GREEN (no real docs)'));
  await mockApproveSumsub(session.sessionId);
  console.log('  testCompleted accepted; polling reviewStatus…');

  // ----- phase 3: SumsubAdapter.fetchDecision until terminal -----
  console.log(tag('phase 3: SumsubAdapter.fetchDecision (poll)'));
  let decision = await adapter.fetchDecision(session.sessionId);
  let attempts = 0;
  while (decision.status === 'pending' || decision.status === 'in_review') {
    if (attempts >= 20) fail('phase 3', { reason: 'sandbox transition timeout', last: decision });
    await sleep(3000);
    decision = await adapter.fetchDecision(session.sessionId);
    attempts += 1;
    console.log(`  attempt ${attempts}: status=${decision.status}`);
  }
  if (decision.status !== 'approved') {
    fail('phase 3', { reason: 'unexpected terminal status', decision });
  }
  console.log(
    `  decision: status=${decision.status} level=${decision.level ?? '-'} identity=${decision.evidence.identityVerified} liveness=${decision.evidence.livenessVerified}`,
  );
  console.log(`  proofHash (Sumsub-derived): ${decision.proofHash.slice(0, 32)}…`);

  // ----- phase 4: participant health + DAR upload (idempotent) -----
  console.log(tag('phase 4: participant + DAR upload'));
  const version = await fetchJson<{ version: string }>('/v2/version');
  if (version.status !== 200 || version.body === null)
    fail('phase 4', { reason: 'participant unreachable', version });
  console.log(`  Canton ${version.body.version}`);
  await uploadDarIfMissing();

  // ----- phase 5: allocate fresh parties -----
  console.log(tag('phase 5: allocate fresh parties'));
  const ts = Date.now();
  const operator = await allocateParty(`canton-vc-sumsub-op-${ts}`);
  const user = await allocateParty(`canton-vc-sumsub-usr-${ts}`);
  console.log(`  operator: ${operator}`);
  console.log(`  user:     ${user}`);

  // ----- phase 6: mint Canton.VC.Credential with Sumsub-derived data -----
  console.log(tag('phase 6: mint Canton.VC.Credential (validator=SumsubValidator)'));
  const config = buildConfig(operator);
  const canton = new CantonClient({ config });

  const validator: Validator = 'sumsub';
  const mintResult = await canton.createCredential({
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
  console.log(`  contractId: ${mintResult.contractId}`);
  console.log(`  updateId:   ${mintResult.updateId}`);

  // ----- phase 7: fetch disclosure bundle + verify via DisclosedContract -----
  console.log(tag('phase 7: verifyDisclosure() via DisclosedContract'));
  const bundle = await canton.fetchDisclosureBundleByContractId(mintResult.contractId);
  if (bundle === null) fail('phase 7', { reason: 'no disclosure bundle found' });
  console.log(`  blob length: ${bundle.blobBase64.length} chars (base64)`);

  const view = await verifyDisclosure(
    {
      canton_vc_credential_blob: bundle.blobBase64,
      canton_vc_contract_id: mintResult.contractId,
    },
    { canton, fetcher: operator },
  );
  console.log(
    `  view: isActive=${view.isActive} userRef=${view.userRef} level=${view.level} validator=${view.validator}`,
  );
  if (view.isActive !== true) fail('phase 7', { reason: 'view.isActive not true', view });
  if (view.userRef !== decision.userRef) {
    fail('phase 7', {
      reason: 'userRef mismatch',
      expected: decision.userRef,
      actual: view.userRef,
    });
  }
  if (view.validator !== 'SumsubValidator') {
    fail('phase 7', {
      reason: 'validator mismatch — SDK ↔ DAML enum sync broken',
      actual: view.validator,
    });
  }
  if (view.proofHash !== decision.proofHash) {
    fail('phase 7', {
      reason: 'proofHash mismatch — Sumsub-derived hash did not survive the mint',
      expected: decision.proofHash,
      actual: view.proofHash,
    });
  }

  console.log(`\n${tag('E2E PASSED — vendor → SDK → DAR chain intact')}`);
  console.log('  Sumsub-derived proofHash and SumsubValidator constructor');
  console.log('  arrived at Canton, re-authenticated against the participant,');
  console.log('  and reflected back through the Verify choice unchanged.');
}

main().catch((err: unknown) => {
  console.error('\nE2E FAILED — uncaught error:');
  console.error(err);
  process.exit(1);
});
