/**
 * Live end-to-end validation of the canton-vc DAR + SDK against a
 * real Canton participant (devnet/testnet).
 *
 * What this proves:
 *
 *   1. `release/canton-vc-credential-1.1.0.dar` uploads and registers
 *      on a Canton 3.4 participant via the JSON Ledger v2 admin API.
 *   2. Fresh `Operator` + `User` parties can be allocated against that
 *      participant and used as `signatory`/`observer` on a new mint.
 *   3. `@canton-vc/core` mints a `Canton.VC.Credential` contract with
 *      synthetic vendor-agnostic data and the participant returns the
 *      `createdEventBlob` Canton needs for trustless disclosure.
 *   4. `@canton-vc/credential::verifyDisclosure()` re-authenticates
 *      the blob against the participant (DisclosedContract path),
 *      runs the `Verify` choice, and returns the on-chain
 *      `CredentialView` struct with `isActive=true`.
 *   5. `@canton-vc/core` mints the companion `KycNFT` contract bound
 *      to the credential id (Enhanced level).
 *   6. `revokeCredential` exercises `RevokeCredential` with the bound
 *      NFT id, archives both contracts in a single Canton transaction,
 *      and the participant confirms the NFT is no longer in the
 *      active set (cascade burn).
 *
 * What this does NOT prove:
 *
 *   - The KYC vendor adapter side (Didit / Sumsub). That is covered
 *     by `scripts/live-didit-test.ts` and `scripts/live-sumsub-test.ts`
 *     against the vendors' sandboxes.
 *
 * Required env (any source — `.env` file in CWD, or shell):
 *
 *   CANTON_JSON_API_BASE_URL  e.g. http://localhost:17575
 *   CANTON_NETWORK            e.g. devnet
 *   CANTON_NETWORK_LABEL      e.g. "Canton DevNet"
 *
 * Run:
 *     pnpm exec tsx scripts/live-canton-e2e.ts
 *
 * Output goes to stdout. A summary line at the end says either:
 *
 *     E2E PASSED — 6/6 phases green
 *
 * or, on any failure, the failing phase + the participant's error
 * payload. Non-zero exit code on failure.
 */

/* eslint-disable no-console */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  CANONICAL_FORM_DEFAULT,
  CantonClient,
  type CantonConfig,
  CantonConfigSchema,
  computeProofHash,
  type ContractId,
  type PartyId,
  type ProofSchemaSpec,
} from '../packages/core/src/index';
import { verifyDisclosure } from '../packages/credential/src/canton';

/* ---------- env loading ---------- */

function loadDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

const dotenv = {
  ...loadDotEnv(resolve(process.cwd(), '.env')),
  ...loadDotEnv(resolve(process.cwd(), '.env.local')),
};
const env: Record<string, string | undefined> = {
  ...dotenv,
  ...process.env,
};

const BASE_URL = env.CANTON_JSON_API_BASE_URL ?? 'http://localhost:17575';
const NETWORK = env.CANTON_NETWORK ?? 'devnet';
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

const PACKAGE_ID = '02806dc9e912f57a61ad83a0f8b300452baf4f734cd259d56458c9b1023d4421';

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
  const stamp = new Date().toISOString().replace('T', ' ').slice(11, 19);
  return `[${stamp}] ${phase}`;
}

function fail(phase: string, info: unknown): never {
  console.error(`\n${tag(phase)} FAILED`);
  console.error(info);
  process.exit(1);
}

/* ---------- phase 1: participant health + DAR upload ---------- */

async function phase1Health(): Promise<{ participantId: string }> {
  console.log(tag('phase 1: participant health + DAR upload'));
  const version = await fetchJson<{ version: string }>('/v2/version');
  if (version.status !== 200 || version.body === null) {
    fail('phase 1', { reason: 'version endpoint not 200', detail: version });
  }
  const pid = await fetchJson<{ participantId: string }>(
    '/v2/parties/participant-id',
  );
  if (pid.status !== 200 || pid.body === null) {
    fail('phase 1', { reason: 'participant-id endpoint not 200', detail: pid });
  }
  console.log(
    `  participant: ${pid.body.participantId}, Canton ${version.body.version}`,
  );

  const pkgList = await fetchJson<{ packageIds: string[] }>('/v2/packages');
  if (pkgList.status !== 200 || pkgList.body === null) {
    fail('phase 1', { reason: 'package list not 200', detail: pkgList });
  }
  const present = pkgList.body.packageIds.includes(PACKAGE_ID);
  if (present) {
    console.log(`  DAR already uploaded (pkg ${PACKAGE_ID.slice(0, 16)}…)`);
  } else {
    if (!existsSync(DAR_PATH)) {
      fail('phase 1', { reason: 'DAR not found', path: DAR_PATH });
    }
    const dar = readFileSync(DAR_PATH);
    console.log(`  uploading DAR (${dar.length} bytes)…`);
    const up = await fetchJson<unknown>('/v2/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: dar,
    });
    if (up.status !== 200) {
      fail('phase 1', { reason: 'DAR upload failed', detail: up });
    }
    console.log('  DAR uploaded.');
  }
  return { participantId: pid.body.participantId };
}

/* ---------- phase 2: allocate operator + user parties ---------- */

async function allocateParty(hint: string): Promise<PartyId> {
  const res = await fetchJson<{ partyDetails: { party: string } }>(
    '/v2/parties',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partyIdHint: hint }),
    },
  );
  if (res.status !== 200 || res.body === null) {
    fail('phase 2', { reason: `allocate ${hint} failed`, detail: res });
  }
  return res.body.partyDetails.party as PartyId;
}

async function phase2Parties(): Promise<{
  operator: PartyId;
  user: PartyId;
}> {
  console.log(tag('phase 2: allocate fresh parties'));
  const ts = Date.now();
  const operator = await allocateParty(`canton-vc-e2e-op-${ts}`);
  const user = await allocateParty(`canton-vc-e2e-usr-${ts}`);
  console.log(`  operator: ${operator}`);
  console.log(`  user:     ${user}`);
  return { operator, user };
}

/* ---------- phase 3: build CantonClient + mint credential ---------- */

function buildConfig(operatorParty: PartyId): CantonConfig {
  const raw = {
    baseUrl: BASE_URL,
    authToken: AUTH_TOKEN ?? null,
    requestTimeoutMs: 10_000,
    submitTimeoutMs: 90_000,
    maxRetries: 2,
    retryBaseDelayMs: 250,
    operatorParty,
    userId: 'canton-vc-e2e',
    packageName: '#canton-vc-credential:Canton.VC.Credential:Credential',
    network: NETWORK as 'devnet' | 'mainnet' | 'testnet',
    networkLabel: NETWORK_LABEL,
    commandIdPrefix: 'e2e',
    maxCommandBodyBytes: 65_536,
    allocateMissingParties: false,
  };
  const parsed = CantonConfigSchema.safeParse(raw);
  if (!parsed.success) {
    fail('phase 3', { reason: 'config validation', issues: parsed.error.issues });
  }
  return parsed.data;
}

async function phase3Mint(operator: PartyId, user: PartyId) {
  console.log(tag('phase 3: mint Canton.VC.Credential'));
  const config = buildConfig(operator);
  const client = new CantonClient({ config });

  const userRef = `e2e-${Date.now()}`;
  const validUntil = new Date(Date.now() + 365 * 86_400_000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');

  // Synthetic proof schema + values for the no-vendor E2E. Real
  // adapters supply both `proofHash` and `proofSchemaId` from a
  // shared `ProofSchemaSpec` declared in their adapter source.
  const syntheticSpec: ProofSchemaSpec = {
    vendor: 'synthetic-e2e',
    schemaVersion: 'v1',
    fieldsInOrder: ['vendor', 'schemaVersion', 'userRef', 'overallStatus'],
    canonicalForm: CANONICAL_FORM_DEFAULT,
  };
  const proof = computeProofHash(syntheticSpec, {
    vendor: 'synthetic-e2e',
    schemaVersion: 'v1',
    userRef,
    overallStatus: 'approved',
  });
  const result = await client.createCredential({
    userParty: user,
    userRef,
    proofHash: proof.proofHash,
    proofSchemaId: proof.proofSchemaId,
    status: 'active',
    level: 'enhanced',
    validUntil,
    humanScore: 95,
    validator: 'didit',
    identityVerified: true,
    livenessVerified: true,
    addressVerified: true,
  });
  console.log(`  contractId: ${result.contractId}`);
  console.log(`  updateId:   ${result.updateId}`);
  return { client, contractId: result.contractId, userRef };
}

/* ---------- phase 4: fetch disclosure bundle ---------- */

async function phase4Disclosure(client: CantonClient, contractId: ContractId) {
  console.log(tag('phase 4: fetch disclosure bundle'));
  const bundle = await client.fetchDisclosureBundleByContractId(contractId);
  if (bundle === null) {
    fail('phase 4', { reason: 'no disclosure bundle found', contractId });
  }
  console.log(
    `  blob length: ${bundle.blobBase64.length} chars (base64), contract id matches: ${bundle.contract.contractId === contractId}`,
  );
  return bundle;
}

/* ---------- phase 5: verifyDisclosure() ---------- */

async function phase5Verify(
  client: CantonClient,
  operator: PartyId,
  blob: string,
  contractId: ContractId,
  expectedUserRef: string,
) {
  console.log(tag('phase 5: verifyDisclosure() via DisclosedContract'));
  const view = await verifyDisclosure(
    {
      canton_vc_credential_blob: blob,
      canton_vc_contract_id: contractId,
    },
    {
      canton: client,
      fetcher: operator,
    },
  );
  console.log(
    `  view.isActive=${view.isActive} | userRef=${view.userRef} | level=${view.level} | status=${view.status}`,
  );
  if (view.isActive !== true) {
    fail('phase 5', { reason: 'view.isActive is not true', view });
  }
  if (view.userRef !== expectedUserRef) {
    fail('phase 5', {
      reason: 'userRef mismatch',
      expected: expectedUserRef,
      actual: view.userRef,
    });
  }
}

/* ---------- phase 6: mint NFT + revoke + cascade-burn check ---------- */

async function phase6NftAndRevoke(
  client: CantonClient,
  user: PartyId,
  credentialId: ContractId,
) {
  console.log(tag('phase 6a: mint KycNFT bound to credential'));
  const svgBytes = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  ).toString('base64');
  const nft = await client.createKycNft({
    customerParty: user,
    boundCredentialId: credentialId,
    level: 'enhanced',
    serialNumber: `E2E-${Date.now()}`,
    displayName: 'canton-vc E2E NFT',
    image: `data:image/svg+xml;base64,${svgBytes}`,
  });
  console.log(`  nftContractId: ${nft.contractId}`);

  console.log(tag('phase 6b: revoke credential with NFT cascade'));
  const revoke = await client.revokeCredential({
    contractId: credentialId,
    nftContractId: nft.contractId,
  });
  console.log(`  revoke updateId: ${revoke.updateId}`);

  // Active set check: NFT must be archived alongside the credential.
  const stillActive = await client.findActiveKycNftByCredentialId(credentialId);
  if (stillActive !== null) {
    fail('phase 6', {
      reason: 'NFT not cascade-archived after revoke',
      foundContractId: stillActive,
    });
  }
  console.log('  NFT cascade-archived ✓');
}

/* ---------- driver ---------- */

async function main(): Promise<void> {
  console.log(`canton-vc live E2E — base ${BASE_URL}, network ${NETWORK}`);
  await phase1Health();
  const { operator, user } = await phase2Parties();
  const { client, contractId, userRef } = await phase3Mint(operator, user);
  const bundle = await phase4Disclosure(client, contractId);
  await phase5Verify(client, operator, bundle.blobBase64, contractId, userRef);
  await phase6NftAndRevoke(client, user, contractId);
  console.log(`\n${tag('E2E PASSED — 6/6 phases green')}`);
}

main().catch((err: unknown) => {
  console.error('\nE2E FAILED — uncaught error:');
  console.error(err);
  process.exit(1);
});
