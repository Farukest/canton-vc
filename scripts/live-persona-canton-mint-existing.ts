/**
 * One-shot live E2E: pick up an EXISTING Persona inquiry (already
 * verified by the user in the browser), pull its decision via
 * PersonaAdapter, and mint a Canton.VC.Credential — skips the
 * browser-open + polling flow so we don't ask the user to re-do KYC.
 *
 * Used after the manual flow script (live-persona-canton-manual-e2e.ts)
 * has already brought the inquiry to `completed`/`approved`. Same
 * mint + verifyDisclosure + (level=enhanced → KycNFT mint + cascade)
 * downstream steps as the full E2E.
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

const env: Record<string, string | undefined> = process.env;
const API_KEY = env.PERSONA_API_KEY!;
const TEMPLATE_ID = env.PERSONA_IDENTITY_TEMPLATE_ID!;
const WEBHOOK_SECRET = env.PERSONA_WEBHOOK_SECRET ?? 'unused';
const INQUIRY_ID = env.PERSONA_INQUIRY_ID!;
const BASE_URL = env.CANTON_JSON_API_BASE_URL ?? 'http://localhost:17575';
const NETWORK = (env.CANTON_NETWORK ?? 'devnet') as 'devnet' | 'mainnet' | 'testnet';
const NETWORK_LABEL = env.CANTON_NETWORK_LABEL ?? 'Canton DevNet';

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

if (!API_KEY || !TEMPLATE_ID || !INQUIRY_ID) {
  console.error('Required: PERSONA_API_KEY, PERSONA_IDENTITY_TEMPLATE_ID, PERSONA_INQUIRY_ID');
  process.exit(2);
}

async function fetchJson<T>(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  const raw = await res.text();
  let body: T | null = null;
  try { body = raw.length > 0 ? JSON.parse(raw) as T : null; } catch {}
  return { status: res.status, body, raw };
}

function tag(p: string) { return `[${new Date().toISOString().slice(11, 19)}] ${p}`; }
function fail(p: string, info: unknown): never { console.error(`\n${tag(p)} FAILED`); console.error(info); process.exit(1); }

async function uploadDar() {
  const pkgList = await fetchJson<{ packageIds: string[] }>('/v2/packages');
  if (pkgList.body?.packageIds.includes(PACKAGE_ID)) {
    console.log(`  DAR already uploaded`);
    return;
  }
  const dar = readFileSync(DAR_PATH);
  await fetchJson('/v2/packages', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: dar });
}

async function allocateParty(hint: string): Promise<PartyId> {
  const r = await fetchJson<{ partyDetails: { party: string } }>('/v2/parties', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partyIdHint: hint }),
  });
  if (!r.body) fail('alloc', r);
  return r.body.partyDetails.party as PartyId;
}

function buildConfig(operator: PartyId): CantonConfig {
  const parsed = CantonConfigSchema.safeParse({
    baseUrl: BASE_URL, authToken: null, requestTimeoutMs: 10_000, submitTimeoutMs: 90_000,
    maxRetries: 2, retryBaseDelayMs: 250, operatorParty: operator, userId: 'canton-vc-persona-existing',
    packageName: '#canton-vc-credential:Canton.VC.Credential:Credential',
    network: NETWORK, networkLabel: NETWORK_LABEL, commandIdPrefix: 'e2e',
    maxCommandBodyBytes: 65_536, allocateMissingParties: false,
  });
  if (!parsed.success) fail('config', parsed.error.issues);
  return parsed.data;
}

async function main() {
  console.log(`Persona existing-inquiry → SDK → DAR  (Canton ${NETWORK_LABEL})\n`);
  const adapter = new PersonaAdapter({ apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, identityTemplateId: TEMPLATE_ID });

  console.log(tag(`phase 1: fetchDecision(${INQUIRY_ID})`));
  const decision = await adapter.fetchDecision(INQUIRY_ID);
  console.log(`  status=${decision.status}  level=${decision.level ?? '-'}  identity=${decision.evidence.identityVerified} liveness=${decision.evidence.livenessVerified} address=${decision.evidence.addressVerified}`);
  console.log(`  proofHash=${decision.proofHash.slice(0, 32)}…`);
  console.log(`  userRef=${decision.userRef}`);

  if (decision.status !== 'approved') fail('phase 1', { reason: `not approved: ${decision.status}`, decision });

  console.log(tag('phase 2: Canton bootstrap'));
  await uploadDar();
  const ts = Date.now();
  const operator = await allocateParty(`canton-vc-persona-exist-op-${ts}`);
  const user = await allocateParty(`canton-vc-persona-exist-usr-${ts}`);
  console.log(`  operator: ${operator}`);
  console.log(`  user:     ${user}`);

  console.log(tag('phase 3: mint Canton.VC.Credential (validator=PersonaValidator)'));
  const canton = new CantonClient({ config: buildConfig(operator) });
  const validator: Validator = 'persona';
  const level = decision.level ?? 'basic';
  const userRefForMint = decision.userRef.length > 0 ? decision.userRef : `cvc-persona-${ts}`;
  const mint = await canton.createCredential({
    userParty: user, userRef: userRefForMint, proofHash: decision.proofHash, proofSchemaId: decision.proofSchemaId,
    status: 'active', level, validUntil: decision.expiresAt.replace(/\.\d+Z$/, 'Z'),
    humanScore: 95, validator,
    identityVerified: decision.evidence.identityVerified,
    livenessVerified: decision.evidence.livenessVerified,
    addressVerified: decision.evidence.addressVerified,
  });
  console.log(`  contractId: ${mint.contractId}`);

  console.log(tag('phase 4: verifyDisclosure'));
  const bundle = await canton.fetchDisclosureBundleByContractId(mint.contractId);
  if (!bundle) fail('phase 4', 'no bundle');
  const view = await verifyDisclosure(
    { canton_vc_credential_blob: bundle.blobBase64, canton_vc_contract_id: mint.contractId },
    { canton, fetcher: operator },
  );
  console.log(`  view: isActive=${view.isActive} validator=${view.validator} level=${view.level} userRef=${view.userRef}`);
  if (!view.isActive) fail('phase 4', { reason: 'not active', view });
  if (view.validator !== 'PersonaValidator') fail('phase 4', { reason: 'validator mismatch', view });
  if (view.proofHash !== decision.proofHash) fail('phase 4', { reason: 'proofHash mismatch', view });

  if (level === 'enhanced') {
    console.log(tag('phase 5a: KycNFT mint'));
    const svgB64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64');
    const nft = await canton.createKycNft({
      customerParty: user, boundCredentialId: mint.contractId as ContractId, level: 'enhanced',
      serialNumber: `PERSONA-${ts}`, displayName: 'canton-vc Persona NFT',
      image: `data:image/svg+xml;base64,${svgB64}`,
    });
    console.log(`  nftContractId: ${nft.contractId}`);

    console.log(tag('phase 5b: cascade revoke'));
    await canton.revokeCredential({ contractId: mint.contractId as ContractId, nftContractId: nft.contractId });
    const stillActive = await canton.findActiveKycNftByCredentialId(mint.contractId as ContractId);
    if (stillActive !== null) fail('phase 5b', { reason: 'NFT not cascade-archived', stillActive });
    console.log('  NFT cascade-archived ✓');
  } else {
    console.log(tag(`phase 5: skipped — level=${level} (no address → NFT not eligible)`));
  }

  console.log(`\n${tag('E2E PASSED — Persona existing inquiry → SDK → DAR chain intact')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
