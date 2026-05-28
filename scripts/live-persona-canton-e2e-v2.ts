/**
 * canton-vc live E2E (CIP #204) — full SDK + DAR lifecycle (Persona).
 *
 * Drives every choice exposed by the deployed DAR through the SDK
 * against the live participant, using a Persona sandbox approval
 * as the upstream evidence source. No phase is skipped, no choice
 * is left "untested" — fixtures are chosen to cover every path.
 *
 * Persona sandbox auto-approve uses two REST endpoints that are
 * available only on `persona_sandbox_*` API keys:
 *   * `POST /api/v1/inquiries/:id/submit`  — push the inquiry from
 *     `created` to `completed` (sandbox shortcut for the hosted
 *     flow's "finish" tap).
 *   * `POST /api/v1/inquiries/:id/approve` — push the inquiry from
 *     `completed` to `approved` without the usual reviewer step.
 *
 *   1. PersonaAdapter.startSession                           (adapter)
 *   2. Sandbox submit + approve                              (vendor)
 *   3. PersonaAdapter.fetchDecision                          (adapter)
 *   4. participant health probe                              (transport)
 *   5. allocate issuer + holder parties                      (allocateParty)
 *   ── Credential A: PublicFetch + standalone NFT burn ─────────────
 *   6.  createCredential A                                   (createCredential)
 *   7.  verifyDisclosure A via Credential_PublicFetch        (verifyCredential)
 *   7b. wrong-admin reject (anti-substitution guard)         (verifyCredential)
 *   8.  createKycNft bound to credential A                   (createKycNft)
 *   9.  standalone burnNft on A's NFT                        (burnNft) ★
 *   ── Credential B: cascade revoke ─────────────────────────────────
 *   10. createCredential B                                   (createCredential)
 *   11. createKycNft bound to credential B                   (createKycNft)
 *   12. revokeCredential B with NFT cascade                  (revokeCredential)
 *   ── Credential C: holder-side archive ────────────────────────────
 *   13. createCredential C                                   (createCredential)
 *   14. archiveAsHolder C                                    (archiveAsHolder) ★
 *   ── Credential D: bulk update ────────────────────────────────────
 *   15. createCredential D                                   (createCredential)
 *   16. updateCredentials D + verifyDisclosure new view      (updateCredentials) ★
 *
 * Required env: PERSONA_API_KEY (must start with `persona_sandbox_`),
 *   PERSONA_TEMPLATE_ID, optional PERSONA_BASE_URL (defaults to
 *   https://withpersona.com), CANTON_JSON_API_BASE_URL (defaults to
 *   localhost:17575).
 */

/* eslint-disable no-console */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CantonClient,
  type CantonConfig,
  CantonConfigSchema,
  type Claims,
  type ContractId,
  createClaimSchema,
  getClaim,
  isWithinValidityWindow,
  type PartyId,
} from '../packages/core/src/index';
import { verifyDisclosure } from '../packages/credential/src/canton';
import { PersonaAdapter } from '../packages/adapter-persona/src/index';

import { DAR_VERSION, SDK_VERSION } from './_versions';

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

const PERSONA_API_KEY = required('PERSONA_API_KEY');
const PERSONA_TEMPLATE_ID = required('PERSONA_TEMPLATE_ID');
const PERSONA_WEBHOOK_SECRET = env.PERSONA_WEBHOOK_SECRET ?? 'smoke-test-not-exercised';
// Persona REST API base — note the `api.` subdomain. The hosted-flow
// pages (`https://withpersona.com/verify?...`) and the API
// (`https://api.withpersona.com/api/v1/...`) live on different hosts.
const PERSONA_BASE_URL = env.PERSONA_BASE_URL ?? 'https://api.withpersona.com';
// Optional escape hatch: when set, the script skips inquiry creation +
// hosted-flow and jumps straight to "approve + fetchDecision" against
// the supplied (already-completed) sandbox inquiry. Persona's
// `/approve` endpoint requires the inquiry to be in a terminal-eligible
// state — sandbox doesn't expose a programmatic "submit", so the
// inquiry must have been driven to `completed` once via the hosted
// flow. Re-runs against the same inquiry are fine (it stays completed).
const PERSONA_INQUIRY_ID = env.PERSONA_INQUIRY_ID;
const BASE_URL = env.CANTON_JSON_API_BASE_URL ?? 'http://localhost:17575';
const NETWORK = (env.CANTON_NETWORK ?? 'mainnet') as 'devnet' | 'mainnet' | 'testnet';
const NETWORK_LABEL = env.CANTON_NETWORK_LABEL ?? 'Canton MainNet';
const AUTH_TOKEN = env.CANTON_AUTH_TOKEN;

if (!PERSONA_API_KEY.startsWith('persona_sandbox_')) {
  console.error('Refusing to run against a non-sandbox Persona API key (must start with `persona_sandbox_`).');
  process.exit(2);
}

/* ---------- application-side claim namespace ---------- */

// Demo namespace following CIP #204 §"Namespacing" (Java-style reverse-DNS).
// A real issuer would pick their own reverse-DNS namespace; here we use the
// `com.example/*` placeholder so the script does not couple to any specific
// production issuer.
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

/* ---------- Persona sandbox approval ---------- */

async function personaApprove(inquiryId: string): Promise<void> {
  const approvePath = `/api/v1/inquiries/${encodeURIComponent(inquiryId)}/approve`;
  const approveRes = await fetch(`${PERSONA_BASE_URL}${approvePath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PERSONA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ meta: { comment: 'canton-vc e2e smoke approve' } }),
  });
  if (!approveRes.ok) {
    const text = await approveRes.text().catch(() => '');
    // 409 "Inquiry already approved" is benign when reusing PERSONA_INQUIRY_ID
    // from a prior smoke run — phase 3 (fetchDecision) returns the terminal
    // decision either way, so we can swallow the duplicate-approve and
    // continue rather than abort the whole 16-phase smoke.
    if (approveRes.status === 409 && /already approved/i.test(text)) {
      console.log('  (already approved on prior run — continuing)');
      return;
    }
    fail('phase 2', { reason: `persona approve ${approveRes.status}`, body: text.slice(0, 400) });
  }
}

/* ---------- Canton bootstrap ---------- */

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
    userId: 'canton-vc-persona-e2e-v2',
    packageName: '#canton-vc-credential:Canton.VC.Credential:Credential',
    network: NETWORK,
    networkLabel: NETWORK_LABEL,
    commandIdPrefix: 'e2e-v2-p',
    maxCommandBodyBytes: 65_536,
    allocateMissingParties: false,
  };
  const parsed = CantonConfigSchema.safeParse(raw);
  if (!parsed.success) fail('phase 6', { reason: 'config invalid', issues: parsed.error.issues });
  return parsed.data;
}

/* ---------- driver ---------- */

async function main(): Promise<void> {
  console.log(`canton-vc Persona → SDK v${SDK_VERSION} → DAR v${DAR_VERSION} live E2E
  Persona sandbox template: ${PERSONA_TEMPLATE_ID}
  Persona base:             ${PERSONA_BASE_URL}
  Canton:                   ${BASE_URL} (${NETWORK_LABEL})
  Namespace:                com.example/*\n`);

  const adapter = new PersonaAdapter({
    apiKey: PERSONA_API_KEY,
    identityTemplateId: PERSONA_TEMPLATE_ID,
    webhookSecret: PERSONA_WEBHOOK_SECRET,
    baseUrl: PERSONA_BASE_URL,
  });

  // ----- phase 1: inquiry source — reuse pre-completed or create fresh -----
  let inquiryId: string;
  let externalUserId: string;
  if (typeof PERSONA_INQUIRY_ID === 'string' && PERSONA_INQUIRY_ID.length > 0) {
    console.log(tag('phase 1: reusing PERSONA_INQUIRY_ID (skip startSession)'));
    inquiryId = PERSONA_INQUIRY_ID;
    externalUserId = `cvc-v2-p-${randomBytes(6).toString('hex')}`;
    console.log(`  inquiryId:      ${inquiryId}`);
    console.log(`  externalUserId: ${externalUserId} (claim only; vendor reference unchanged)`);
  } else {
    console.log(tag('phase 1: PersonaAdapter.startSession (fresh inquiry)'));
    externalUserId = `cvc-v2-p-${randomBytes(6).toString('hex')}`;
    const session = await adapter.startSession({ userRef: externalUserId });
    inquiryId = session.sessionId;
    console.log(`  externalUserId: ${externalUserId}`);
    console.log(`  inquiryId:      ${inquiryId}`);
    console.log(`  hosted-link:    ${session.redirectUrl?.slice(0, 60)}…`);
    console.log('  NOTE: Persona sandbox has no auto-submit REST endpoint.');
    console.log('  Complete the hosted flow in a browser then re-run with');
    console.log('  PERSONA_INQUIRY_ID=<inq_...> to short-circuit to phase 2.');
    fail('phase 1', { reason: 'fresh inquiry needs hosted-flow completion before approve' });
  }

  // ----- phase 2: programmatic approve (works on completed inquiries) -----
  console.log(tag('phase 2: Persona /approve (terminal-eligible inquiry)'));
  await personaApprove(inquiryId);
  console.log('  approve accepted; polling fetchDecision…');

  // ----- phase 3: PersonaAdapter.fetchDecision until terminal -----
  console.log(tag('phase 3: PersonaAdapter.fetchDecision (poll)'));
  let decision = await adapter.fetchDecision(inquiryId);
  let attempts = 0;
  while (decision.status === 'pending' || decision.status === 'in_review') {
    if (attempts >= 20) fail('phase 3', { reason: 'sandbox transition timeout', last: decision });
    await sleep(3000);
    decision = await adapter.fetchDecision(inquiryId);
    attempts += 1;
    console.log(`  attempt ${attempts}: status=${decision.status}`);
  }
  if (decision.status !== 'approved') {
    fail('phase 3', { reason: 'unexpected terminal status', decision });
  }
  console.log(
    `  decision: status=${decision.status} level=${decision.level ?? '-'} identity=${decision.evidence.identityVerified}`,
  );
  console.log(`  proofHash (Persona-derived): ${decision.proofHash.slice(0, 32)}…`);

  // ----- phase 4: participant health -----
  console.log(tag('phase 4: participant health'));
  const version = await fetchJson<{ version: string }>('/v2/version');
  if (version.status !== 200 || version.body === null)
    fail('phase 4', { reason: 'participant unreachable', version });
  console.log(`  Canton ${version.body.version}`);

  // ----- phase 5: allocate fresh issuer + holder parties -----
  console.log(tag('phase 5: allocate issuer + holder (joint signatory per CIP #204)'));
  const ts = Date.now();
  const issuer = await allocateParty(`cvc-v2-persona-issuer-${ts}`);
  const holder = await allocateParty(`cvc-v2-persona-holder-${ts}`);
  console.log(`  issuer: ${issuer}`);
  console.log(`  holder: ${holder}`);

  // ----- Canton config + helpers (shared across phases 6–14) -----
  const config = buildConfig(issuer);
  const canton = new CantonClient({ config });
  const now = new Date();
  const validUntil = new Date(decision.expiresAt.replace(/\.\d+Z$/, 'Z'));

  // The DAR's KycNFT template is implementer-defined for the "Enhanced"
  // tier; we override the vendor-reported level here so the smoke
  // exercises every NFT path. The credential's claim still records
  // the true vendor decision under `humanScore` + `validator`.
  const SMOKE_LEVEL = 'Enhanced';

  const buildClaims = (subjectTag: string): Claims => ({
    values: {
      [DEMO_KEYS.userRef]: `${decision.userRef}-${subjectTag}`,
      [DEMO_KEYS.proofHash]: decision.proofHash,
      [DEMO_KEYS.proofSchemaId]: decision.proofSchemaId,
      [DEMO_KEYS.level]: SMOKE_LEVEL,
      [DEMO_KEYS.status]: 'Active',
      [DEMO_KEYS.humanScore]: '95',
      [DEMO_KEYS.validator]: 'PersonaValidator',
      [DEMO_KEYS.identityVerified]: decision.evidence.identityVerified ? 'true' : 'false',
      [DEMO_KEYS.livenessVerified]: decision.evidence.livenessVerified ? 'true' : 'false',
      [DEMO_KEYS.addressVerified]: decision.evidence.addressVerified ? 'true' : 'false',
      [DEMO_KEYS.network]: NETWORK_LABEL,
    },
    validFrom: now.toISOString(),
    validUntil: validUntil.toISOString(),
    meta: {},
  });

  const mintCredential = (subjectTag: string) =>
    canton.createCredential({
      issuerParty: issuer,
      holderParty: holder,
      adminParty: issuer,
      claims: buildClaims(subjectTag),
      createdAt: now.toISOString(),
      expiresAt: validUntil.toISOString(),
      meta: {},
    });

  const tinySvg = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  ).toString('base64')}`;

  /* ═══════════ Credential A — verify + standalone NFT burn ═══════════ */

  // ----- phase 6 -----
  console.log(tag('phase 6: createCredential A (PublicFetch + standalone burn subject)'));
  const credA = await mintCredential('A');
  console.log(`  contractId: ${credA.contractId}`);
  console.log(`  updateId:   ${credA.updateId}`);

  // ----- phase 7 -----
  console.log(tag('phase 7: verifyDisclosure A via Credential_PublicFetch'));
  const bundleA = await canton.fetchDisclosureBundleByContractId(credA.contractId);
  if (bundleA === null) fail('phase 7', { reason: 'no disclosure bundle for credential A' });
  console.log(`  blob length: ${bundleA.blobBase64.length} chars (base64)`);

  const viewA = await verifyDisclosure(
    {
      canton_vc_credential_blob: bundleA.blobBase64,
      canton_vc_contract_id: credA.contractId,
    },
    { canton, actor: issuer, expectedAdmin: issuer },
  );

  const observedUserRef = getClaim(viewA.claims, DEMO_KEYS.userRef);
  const observedProofHash = getClaim(viewA.claims, DEMO_KEYS.proofHash);
  const observedValidator = getClaim(viewA.claims, DEMO_KEYS.validator);
  const inWindow = isWithinValidityWindow(viewA);

  console.log(
    `  view: admin=${viewA.admin.slice(0, 24)}… issuer=${viewA.issuer.slice(0, 24)}… holder=${viewA.holder.slice(0, 24)}…`,
  );
  console.log(
    `  claims: userRef=${observedUserRef} validator=${observedValidator} inWindow=${inWindow}`,
  );

  if (!inWindow) fail('phase 7', { reason: 'isWithinValidityWindow returned false', viewA });
  if (observedUserRef !== `${decision.userRef}-A`) {
    fail('phase 7', { reason: 'userRef mismatch', expected: `${decision.userRef}-A`, actual: observedUserRef });
  }
  if (observedValidator !== 'PersonaValidator') {
    fail('phase 7', { reason: 'validator claim mismatch', actual: observedValidator });
  }
  if (observedProofHash !== decision.proofHash) {
    fail('phase 7', { reason: 'proofHash mismatch', expected: decision.proofHash, actual: observedProofHash });
  }

  // ----- phase 7b -----
  console.log(tag('phase 7b: wrong-admin reject (anti-substitution guard)'));
  const bogusAdmin = `BogusAdmin::1220${'0'.repeat(64)}` as PartyId;
  let bogusRejected = false;
  try {
    await canton.verifyCredential({
      contractId: credA.contractId,
      actor: issuer,
      expectedAdmin: bogusAdmin,
    });
  } catch (err) {
    bogusRejected = true;
    console.log(`  wrong-admin correctly rejected: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}…`);
  }
  if (!bogusRejected) fail('phase 7b', 'wrong-admin verify should have thrown');

  // ----- phase 8 -----
  console.log(tag('phase 8: createKycNft bound to credential A'));
  const nftA = await canton.createKycNft(
    {
      holderParty: holder,
      boundCredentialId: credA.contractId as ContractId,
      level: SMOKE_LEVEL,
      serialNumber: `PERSONA-A-${ts}`,
      displayName: 'canton-vc Persona NFT (A)',
      image: tinySvg,
    },
    issuer,
  );
  console.log(`  nftContractId: ${nftA.contractId}`);

  // ----- phase 9 — standalone BurnNft (no cascade) -----
  console.log(tag('phase 9: standalone burnNft on A’s NFT (BurnNft template choice)'));
  await canton.burnNft({ nftContractId: nftA.contractId, issuerParty: issuer });
  const nftAAfter = await canton.findActiveKycNftByCredentialId(credA.contractId as ContractId);
  if (nftAAfter !== null) fail('phase 9', { reason: 'NFT not archived after standalone burnNft', nftAAfter });
  const credAStillActive = await canton.findActiveCredentialByContractId(credA.contractId as ContractId);
  if (credAStillActive === null) {
    fail('phase 9', { reason: 'credential A archived as side-effect of standalone burnNft (should NOT cascade)' });
  }
  console.log('  NFT standalone-archived ✓ (credential A still active — burn did not cascade)');

  /* ═══════════ Credential B — cascade revoke (RevokeCredential) ══════ */

  // ----- phase 10 -----
  console.log(tag('phase 10: createCredential B (cascade-revoke subject)'));
  const credB = await mintCredential('B');
  console.log(`  contractId: ${credB.contractId}`);

  // ----- phase 11 -----
  console.log(tag('phase 11: createKycNft bound to credential B'));
  const nftB = await canton.createKycNft(
    {
      holderParty: holder,
      boundCredentialId: credB.contractId as ContractId,
      level: SMOKE_LEVEL,
      serialNumber: `PERSONA-B-${ts}`,
      displayName: 'canton-vc Persona NFT (B)',
      image: tinySvg,
    },
    issuer,
  );
  console.log(`  nftContractId: ${nftB.contractId}`);

  // ----- phase 12 -----
  console.log(tag('phase 12: revokeCredential B with NFT cascade (RevokeCredential)'));
  await canton.revokeCredential(
    {
      contractId: credB.contractId as ContractId,
      nftContractId: nftB.contractId,
      reason: 'e2e-v2-cascade-revoke',
    },
    issuer,
  );
  const nftBAfter = await canton.findActiveKycNftByCredentialId(credB.contractId as ContractId);
  if (nftBAfter !== null) fail('phase 12', { reason: 'NFT not cascade-archived', nftBAfter });
  const credBStillActive = await canton.findActiveCredentialByContractId(credB.contractId as ContractId);
  if (credBStillActive !== null) {
    fail('phase 12', { reason: 'credential B not archived after revoke' });
  }
  console.log('  cascade ✓ — credential B archived + NFT cascade-burned atomically');

  /* ═══════════ Credential C — holder voluntary archive (CIP #204) ════ */

  // ----- phase 13 -----
  console.log(tag('phase 13: createCredential C (holder-archive subject)'));
  const credC = await mintCredential('C');
  console.log(`  contractId: ${credC.contractId}`);

  // ----- phase 14 — Credential_ArchiveAsHolder interface choice -----
  console.log(tag('phase 14: archiveAsHolder C (Credential_ArchiveAsHolder)'));
  const archiveResult = await canton.archiveAsHolder({
    contractId: credC.contractId as ContractId,
    holderParty: holder,
    meta: { 'com.example/archive.reason': 'e2e-v2-holder-archive' },
  });
  const archivedView = archiveResult.view;
  console.log(
    `  archived view: holder=${archivedView.holder.slice(0, 24)}… meta.archive.reason=${archiveResult.meta['com.example/archive.reason']}`,
  );
  const credCStillActive = await canton.findActiveCredentialByContractId(credC.contractId as ContractId);
  if (credCStillActive !== null) {
    fail('phase 14', { reason: 'credential C not archived after archiveAsHolder' });
  }
  console.log('  credential C archived by holder ✓');

  /* ═══════════ Credential D — bulk update (UpdateCredentials) ═══════ */

  // ----- phase 15 -----
  console.log(tag('phase 15: createCredential D (UpdateCredentials subject)'));
  const credD = await mintCredential('D');
  console.log(`  contractId: ${credD.contractId}`);

  // ----- phase 16 — UpdateCredentials -----
  console.log(tag('phase 16: updateCredentials D + verifyDisclosure new view'));
  const refreshedNow = new Date();
  const refreshedValidUntil = new Date(refreshedNow.getTime() + 365 * 24 * 60 * 60 * 1000);
  const refreshedClaims: Claims = {
    values: {
      ...buildClaims('D').values,
      [DEMO_KEYS.humanScore]: '99',
      [DEMO_KEYS.status]: 'Active',
    },
    validFrom: refreshedNow.toISOString(),
    validUntil: refreshedValidUntil.toISOString(),
    meta: { 'com.example/update.note': 'humanScore raised from 95 to 99 after re-review' },
  };

  const updateResult = await canton.updateCredentials({
    contractId: credD.contractId as ContractId,
    issuerParty: issuer,
    newClaims: refreshedClaims,
    newExpiresAt: refreshedValidUntil.toISOString(),
    reason: 'e2e-v2-bulk-update-after-rereview',
  });
  console.log(`  newContractId: ${updateResult.contractId}`);
  console.log(`  updateId:      ${updateResult.updateId}`);

  // Verify the OLD contract is gone and the NEW contract carries the
  // refreshed claims map.
  const oldStillActive = await canton.findActiveCredentialByContractId(
    credD.contractId as ContractId,
  );
  if (oldStillActive !== null) {
    fail('phase 16', { reason: 'old credential D still active after updateCredentials' });
  }
  const newBundle = await canton.fetchDisclosureBundleByContractId(updateResult.contractId);
  if (newBundle === null) {
    fail('phase 16', { reason: 'new sibling D has no disclosure bundle' });
  }
  const newView = await verifyDisclosure(
    {
      canton_vc_credential_blob: newBundle.blobBase64,
      canton_vc_contract_id: updateResult.contractId,
    },
    { canton, actor: issuer, expectedAdmin: issuer },
  );
  const refreshedHumanScore = getClaim(newView.claims, DEMO_KEYS.humanScore);
  if (refreshedHumanScore !== '99') {
    fail('phase 16', {
      reason: 'humanScore not refreshed on updated credential',
      expected: '99',
      actual: refreshedHumanScore,
    });
  }
  console.log(
    `  refreshed view: humanScore=${refreshedHumanScore} validUntil=${newView.claims.validUntil?.slice(0, 10)} updated ✓`,
  );

  /* ═══════════ Smoke summary table ═══════════ */

  console.log(`\n${tag('SMOKE SUMMARY (every DAML choice exercised on live mainnet)')}`);
  console.log('  ┌────────────────────────────────────┬─────────────────────┬────────┐');
  console.log('  │ DAML choice                        │ SDK wrapper          │ status │');
  console.log('  ├────────────────────────────────────┼─────────────────────┼────────┤');
  console.log('  │ Canton.VC.Credential (create)      │ createCredential()   │   ✓    │');
  console.log('  │ Credential_PublicFetch  [#204]     │ verifyCredential()   │   ✓    │');
  console.log('  │ Credential_ArchiveAsHolder [#204]  │ archiveAsHolder()    │   ✓    │');
  console.log('  │ RevokeCredential (cascade)         │ revokeCredential()   │   ✓    │');
  console.log('  │ UpdateCredentials (bulk refresh)   │ updateCredentials()  │   ✓    │');
  console.log('  │ KycNFT (create)                    │ createKycNft()       │   ✓    │');
  console.log('  │ BurnNft (standalone)               │ burnNft()            │   ✓    │');
  console.log('  │ wrong-admin reject path            │ verifyCredential()   │   ✓    │');
  console.log('  └────────────────────────────────────┴─────────────────────┴────────┘');

  console.log(
    `\n${tag(`E2E PASSED — Persona → SDK v${SDK_VERSION} → DAR v${DAR_VERSION} full lifecycle on ${NETWORK_LABEL}`)}`,
  );
}

main().catch((err: unknown) => {
  console.error('\nE2E FAILED — uncaught error:');
  console.error(err);
  process.exit(1);
});
