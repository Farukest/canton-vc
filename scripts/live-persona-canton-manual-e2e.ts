/**
 * Live end-to-end with MANUAL KYC submission via Persona:
 *
 *   PersonaAdapter.startSession  → real inquiry URL printed to stdout
 *   (you open it in a browser, scan your ID, take a selfie, optionally
 *   complete the database/address step, finish)
 *   PersonaAdapter.fetchDecision → polled until the inquiry status
 *   becomes terminal (approved / declined / failed / expired)
 *   @canton-vc/core.createCredential → real on-chain mint with
 *   Persona-derived proofHash + SumsubValidator-style enum
 *   PersonaValidator constructor
 *   @canton-vc/credential.verifyDisclosure → DisclosedContract re-check
 *
 * If the resulting decision has `level === 'enhanced'` (address
 * verification passed), the script also mints a KycNFT bound to the
 * credential, then revokes the credential to exercise the cascade-burn
 * path on chain. Basic-level credentials (no address step) skip the
 * NFT branch — the DAML `ensure` clause rejects `level != "Enhanced"`.
 *
 * Required env:
 *   PERSONA_API_KEY              `persona_sandbox_*` or `persona_live_*`
 *   PERSONA_IDENTITY_TEMPLATE_ID `itmpl_xxxxxxxxxxxxxxxxxxxxxxxx`
 *   PERSONA_WEBHOOK_SECRET       (optional; defaults to a placeholder)
 *   PERSONA_REDIRECT_URI         (optional)
 *   CANTON_JSON_API_BASE_URL
 *   CANTON_NETWORK / CANTON_NETWORK_LABEL
 *
 * Run:
 *     pnpm exec tsx scripts/live-persona-canton-manual-e2e.ts
 *
 * Then open the printed URL in a browser, complete the verification,
 * and wait. The script polls Persona every 5 seconds for up to 30
 * minutes. When the inquiry reaches a terminal state, it mints (on
 * approve) or exits cleanly (on decline / expire / fail).
 */

/* eslint-disable no-console */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PersonaAdapter } from '../packages/adapter-persona/src/index';
import {
  CantonClient,
  type CantonConfig,
  CantonConfigSchema,
  type ContractId,
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

const API_KEY = required('PERSONA_API_KEY');
const IDENTITY_TEMPLATE_ID = required('PERSONA_IDENTITY_TEMPLATE_ID');
const WEBHOOK_SECRET = env.PERSONA_WEBHOOK_SECRET ?? 'unused-but-required-by-adapter';
const REDIRECT_URI = env.PERSONA_REDIRECT_URI;
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
    userId: 'canton-vc-persona-manual',
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
  console.log(`canton-vc Persona MANUAL → SDK → DAR live E2E
  Persona template: ${IDENTITY_TEMPLATE_ID}
  Canton:           ${BASE_URL} (${NETWORK_LABEL})\n`);

  // ----- phase 1: open a fresh Persona inquiry -----
  console.log(tag('phase 1: PersonaAdapter.startSession'));
  const adapter = new PersonaAdapter({
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
    identityTemplateId: IDENTITY_TEMPLATE_ID,
    ...(REDIRECT_URI !== undefined && { redirectUri: REDIRECT_URI }),
  });

  const userRef = `cvc-e2e-${Date.now().toString(36)}`;
  const session = await adapter.startSession({ userRef });
  console.log(`  inquiryId:   ${session.sessionId}`);
  console.log(`  userRef:     ${userRef}`);
  console.log(`  expiresAt:   ${session.expiresAt}`);
  console.log();
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  OPEN THIS URL IN A BROWSER AND COMPLETE THE VERIFICATION:');
  console.log();
  console.log(`  ${session.redirectUrl}`);
  console.log();
  console.log('  Then come back — this script polls Persona every 5 seconds');
  console.log('  and continues automatically once the inquiry is terminal.');
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();

  // ----- phase 2: poll fetchDecision until terminal -----
  console.log(tag('phase 2: polling PersonaAdapter.fetchDecision (5s interval)'));
  const POLL_INTERVAL_MS = 5_000;
  const MAX_WAIT_MS = 30 * 60 * 1000;
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
  console.log(`  proofHash (Persona-derived): ${decision.proofHash.slice(0, 32)}…`);

  // ----- phase 3: participant + DAR + parties -----
  console.log(tag('phase 3: Canton bootstrap (DAR + parties)'));
  await uploadDarIfMissing();
  const ts = Date.now();
  const operator = await allocateParty(`canton-vc-persona-op-${ts}`);
  const user = await allocateParty(`canton-vc-persona-usr-${ts}`);
  console.log(`  operator: ${operator}`);
  console.log(`  user:     ${user}`);

  // ----- phase 4: mint with Persona-derived data -----
  console.log(tag('phase 4: mint Canton.VC.Credential (validator=PersonaValidator)'));
  const config = buildConfig(operator);
  const canton = new CantonClient({ config });

  const validator: Validator = 'persona';
  const level = decision.level ?? 'basic';
  const mint = await canton.createCredential({
    userParty: user,
    userRef: decision.userRef,
    proofHash: decision.proofHash,
    proofSchemaId: decision.proofSchemaId,
    status: 'active',
    level,
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
  if (view.validator !== 'PersonaValidator') {
    fail('phase 5', { reason: 'validator mismatch — SDK ↔ DAML enum sync broken', view });
  }
  if (view.proofHash !== decision.proofHash) {
    fail('phase 5', {
      reason: 'proofHash mismatch — Persona-derived hash did not survive the mint',
      expected: decision.proofHash,
      actual: view.proofHash,
    });
  }

  // ----- phase 6: KycNFT mint + cascade revoke (enhanced only) -----
  if (level === 'enhanced') {
    console.log(tag('phase 6a: mint KycNFT bound to credential (level=enhanced)'));
    const svgBytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    ).toString('base64');
    const nft = await canton.createKycNft({
      customerParty: user,
      boundCredentialId: mint.contractId as ContractId,
      level: 'enhanced',
      serialNumber: `PERSONA-${Date.now()}`,
      displayName: 'canton-vc Persona E2E NFT',
      image: `data:image/svg+xml;base64,${svgBytes}`,
    });
    console.log(`  nftContractId: ${nft.contractId}`);

    console.log(tag('phase 6b: revoke credential with NFT cascade'));
    const revoke = await canton.revokeCredential({
      contractId: mint.contractId as ContractId,
      nftContractId: nft.contractId,
    });
    console.log(`  revoke updateId: ${revoke.updateId}`);

    const stillActive = await canton.findActiveKycNftByCredentialId(
      mint.contractId as ContractId,
    );
    if (stillActive !== null) {
      fail('phase 6', {
        reason: 'NFT not cascade-archived after revoke',
        foundContractId: stillActive,
      });
    }
    console.log('  NFT cascade-archived ✓');
  } else {
    console.log(
      tag(
        `phase 6: skipped — level='${level}' (no address verification → DAML ensure rejects NFT mint)`,
      ),
    );
  }

  console.log(`\n${tag('E2E PASSED — manual Persona KYC + canton-vc SDK + DAR chain intact')}`);
}

main().catch((err: unknown) => {
  console.error('\nE2E FAILED — uncaught error:');
  console.error(err);
  process.exit(1);
});
