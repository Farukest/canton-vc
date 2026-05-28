/**
 * Single source of truth for the version strings the live-smoke scripts
 * print. Reading them at runtime keeps the log header in lock-step with
 * the real artifacts whenever DAR or SDK bumps land, so the proposal /
 * evidence trail can quote any smoke log without spot-checking against
 * `daml.yaml` and `packages/core/package.json` by hand.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function readSdkVersion(): string {
  const pkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'packages/core/package.json'), 'utf8'),
  ) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('packages/core/package.json: version missing or non-string');
  }
  return pkg.version;
}

function readDarVersion(): string {
  const yaml = readFileSync(
    resolve(REPO_ROOT, 'daml/canton-vc-credential/daml.yaml'),
    'utf8',
  );
  const match = yaml.match(/^version:\s*(\S+)\s*$/m);
  if (match === null || match[1] === undefined) {
    throw new Error('daml/canton-vc-credential/daml.yaml: version line not found');
  }
  return match[1];
}

export const SDK_VERSION: string = readSdkVersion();
export const DAR_VERSION: string = readDarVersion();
