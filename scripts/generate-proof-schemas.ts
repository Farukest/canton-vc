/**
 * Generate the public proof-schema registry at `docs/proof-schemas/`.
 *
 * For each adapter's `ProofSchemaSpec`, computes the content-addressed
 * id and writes the canonical spec JSON to `<id>.json`. Auditors
 * fetch these files by id (taken from the on-chain `proofSchemaId`)
 * to learn which named fields were hashed and in what order.
 *
 * Run once after any adapter schema change:
 *   pnpm exec tsx scripts/generate-proof-schemas.ts
 */

/* eslint-disable no-console */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_FORM_DEFAULT,
  canonicalJson,
  computeSchemaId,
  type ProofSchemaSpec,
} from '../packages/core/src/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'docs', 'proof-schemas');

const SCHEMAS: readonly ProofSchemaSpec[] = [
  {
    vendor: 'didit',
    schemaVersion: 'v1',
    fieldsInOrder: [
      'vendor',
      'schemaVersion',
      'sessionId',
      'vendorData',
      'overallStatus',
      'identityVerified',
      'livenessVerified',
      'addressVerified',
    ],
    canonicalForm: CANONICAL_FORM_DEFAULT,
  },
  {
    vendor: 'sumsub',
    schemaVersion: 'v1',
    fieldsInOrder: [
      'vendor',
      'schemaVersion',
      'applicantId',
      'externalUserId',
      'reviewStatus',
      'reviewAnswer',
      'appliedLevel',
      'identityVerified',
      'livenessVerified',
      'addressVerified',
    ],
    canonicalForm: CANONICAL_FORM_DEFAULT,
  },
  {
    vendor: 'persona',
    schemaVersion: 'v1',
    fieldsInOrder: [
      'vendor',
      'schemaVersion',
      'inquiryId',
      'referenceId',
      'inquiryStatus',
      'identityVerified',
      'livenessVerified',
      'addressVerified',
    ],
    canonicalForm: CANONICAL_FORM_DEFAULT,
  },
];

mkdirSync(OUT_DIR, { recursive: true });

const indexEntries: Array<{ readonly vendor: string; readonly schemaVersion: string; readonly id: string }> = [];

for (const spec of SCHEMAS) {
  const id = computeSchemaId(spec);
  const filePath = resolve(OUT_DIR, `${id}.json`);
  const body = canonicalJson({ id, spec });
  writeFileSync(filePath, `${body}\n`, 'utf8');
  console.log(`wrote ${spec.vendor}/${spec.schemaVersion} → ${id.slice(0, 16)}… (${filePath})`);
  indexEntries.push({ vendor: spec.vendor, schemaVersion: spec.schemaVersion, id });
}

// Index file for human discovery; the registry's canonical lookup is by file name.
const indexPath = resolve(OUT_DIR, 'INDEX.md');
const indexBody = [
  '# Proof Schema Registry',
  '',
  'Content-addressed proof schemas the canton-vc adapters reference at issuance.',
  'On-chain `proofSchemaId` (in `Canton.VC.Credential.proofSchemaId`) maps to the',
  '`<id>.json` file in this directory. Auditors load the spec from the file name,',
  'apply the canonical pipeline (`@canton-vc/core#canonicalJson` + SHA-256) to the',
  "firm's retained raw bytes, and compare against the on-chain `proofHash`.",
  '',
  '| Vendor | Version | Schema ID | File |',
  '|---|---|---|---|',
  ...indexEntries.map(
    (e) => `| ${e.vendor} | ${e.schemaVersion} | \`${e.id}\` | [\`${e.id.slice(0, 16)}…\`](./${e.id}.json) |`,
  ),
  '',
].join('\n');
writeFileSync(indexPath, indexBody, 'utf8');
console.log(`wrote INDEX.md`);
