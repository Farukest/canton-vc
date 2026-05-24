/**
 * `CantonClient` — public facade combining config, HTTP, ledger,
 * and query operations into one object that the route layer can
 * hold on to.
 *
 * The facade is deliberately thin: every method delegates to a
 * pure function in `ledger.ts` or `query.ts`. The only reason it
 * exists is to bundle the `CantonConfig`, the injected `fetch`
 * implementation, and a monotonic clock into a single value that
 * flows through the service layer.
 *
 * Route handlers never hold a `CantonClient` as module-level state.
 * Instead, each request builds one via `getCantonClient()` (process
 * singleton) or receives a test-specific instance via dependency
 * injection. This keeps the Canton layer fully deterministic under
 * test without special globals.
 */

import type { CantonConfig } from './config';
import { type CantonEnv, getCantonConfig, loadCantonConfig } from './config';
import type { FetchLike } from './http';
import {
  allocateParty,
  createCredential,
  createKycNft,
  getLedgerEnd,
  partyExists,
  resolveNamespace,
  revokeCredential,
  verifyCredential,
} from './ledger';
import { getCachedNamespace, resetNamespaceCacheForConfig } from './party';
import {
  fetchDisclosureBundleByContractId,
  fetchDisclosureBundleByUser,
  findActiveCredentialByContractId,
  findActiveCredentialByUser,
  findActiveKycNftByCredentialId,
  listActiveCredentials,
} from './query';
import type {
  ActiveContract,
  ContractId,
  CreateCredentialInput,
  CreateCredentialResult,
  CreateKycNftInput,
  CreateKycNftResult,
  DisclosureBundle,
  LedgerOffset,
  PartyId,
  RevokeCredentialInput,
  RevokeCredentialResult,
  VerifyCredentialInput,
  VerifyCredentialResult,
} from './types';

/* ---------- Options ---------- */

/**
 * Everything the facade needs to talk to a participant. `config`
 * carries the transport + ledger tunables; `fetchImpl` is the
 * fetch-like function used for every call (defaults to the Node 22
 * global `fetch`); `clock` is a monotonic `() => Date` used for the
 * disclosure-blob `fetchedAt` timestamp.
 */
export interface CantonClientOptions {
  readonly config: CantonConfig;
  readonly fetchImpl?: FetchLike;
  readonly clock?: () => Date;
}

/* ---------- Facade ---------- */

/**
 * Bundled Canton client. Every method is a thin wrapper around a
 * pure function in `ledger.ts` / `query.ts` that forwards the
 * `config`, `fetchImpl`, and `clock` from the facade.
 *
 * Instances are cheap to build — the only per-instance state is the
 * three options — so they can be recreated per-request without
 * performance concerns.
 */
export class CantonClient {
  readonly config: CantonConfig;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly clock: () => Date;

  constructor(options: CantonClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl;
    this.clock = options.clock ?? (() => new Date());
  }

  /* ---- Bootstrap ---- */

  /**
   * Resolve and cache the participant namespace. Safe to call many
   * times — the cache keeps subsequent calls free.
   */
  resolveNamespace(): Promise<string> {
    return resolveNamespace(this.config, this.fetchImpl);
  }

  /**
   * Check whether a party id exists on the participant. Used to
   * gate allocation when `allocateMissingParties` is true.
   */
  partyExists(partyId: PartyId): Promise<boolean> {
    return partyExists(this.config, partyId, this.fetchImpl);
  }

  /**
   * Allocate a fresh party with a label hint. Throws when
   * `config.allocateMissingParties` is `false`; the route layer
   * checks the flag first.
   */
  allocateParty(labelHint: string): Promise<PartyId> {
    return allocateParty(this.config, labelHint, this.fetchImpl);
  }

  /* ---- State ---- */

  /**
   * Current ledger end offset. Mostly used for `activeAtOffset`
   * consistency + as a health probe.
   */
  getLedgerEnd(): Promise<LedgerOffset> {
    return getLedgerEnd(this.config, this.fetchImpl);
  }

  /* ---- Writes ---- */

  createCredential(input: CreateCredentialInput): Promise<CreateCredentialResult> {
    return createCredential(this.config, input, this.fetchImpl);
  }

  verifyCredential(input: VerifyCredentialInput): Promise<VerifyCredentialResult> {
    return verifyCredential(this.config, input, this.fetchImpl);
  }

  revokeCredential(input: RevokeCredentialInput): Promise<RevokeCredentialResult> {
    return revokeCredential(this.config, input, this.fetchImpl);
  }

  createKycNft(
    input: CreateKycNftInput,
    options?: { readonly commandId?: import('./types').CommandId },
  ): Promise<CreateKycNftResult> {
    return createKycNft(this.config, input, this.fetchImpl, options?.commandId);
  }

  /* ---- Reads ---- */

  listActiveCredentials(options: {
    readonly includeBlob: boolean;
    readonly offset?: string;
  }): Promise<readonly ActiveContract[]> {
    return listActiveCredentials(this.config, options, this.fetchImpl);
  }

  findActiveCredentialByUser(
    userParty: PartyId,
    options: { readonly includeBlob: boolean } = { includeBlob: false },
  ): Promise<ActiveContract | null> {
    return findActiveCredentialByUser(this.config, userParty, options, this.fetchImpl);
  }

  findActiveCredentialByContractId(
    contractId: ContractId,
    options: { readonly includeBlob: boolean } = { includeBlob: false },
  ): Promise<ActiveContract | null> {
    return findActiveCredentialByContractId(this.config, contractId, options, this.fetchImpl);
  }

  findActiveKycNftByCredentialId(boundCredentialId: ContractId): Promise<ContractId | null> {
    return findActiveKycNftByCredentialId(this.config, boundCredentialId, this.fetchImpl);
  }

  /* ---- Disclosure ---- */

  fetchDisclosureBundleByUser(userParty: PartyId): Promise<DisclosureBundle | null> {
    return fetchDisclosureBundleByUser(this.config, userParty, this.fetchImpl, this.clock);
  }

  fetchDisclosureBundleByContractId(contractId: ContractId): Promise<DisclosureBundle | null> {
    return fetchDisclosureBundleByContractId(this.config, contractId, this.fetchImpl, this.clock);
  }

  /* ---- Diagnostics ---- */

  /**
   * Inspect the cached namespace for this client's config. Returns
   * `null` if `resolveNamespace()` has not been called yet.
   */
  cachedNamespace(): string | null {
    return getCachedNamespace(this.config);
  }

  /**
   * Drop the namespace cache for this client's config. Test-only.
   */
  resetNamespaceCacheForTests(): void {
    resetNamespaceCacheForConfig(this.config);
  }
}

/* ---------- Process singleton ---------- */

let cached: CantonClient | null = null;

/**
 * Return the singleton client for the current process. Built lazily
 * on the first call from env-backed config. Tests can call
 * `resetCantonClientForTests()` to drop the cache between cases.
 */
export function getCantonClient(): CantonClient {
  if (cached === null) {
    cached = new CantonClient({ config: getCantonConfig() });
  }
  return cached;
}

/**
 * Build a one-off client from an explicit env record. Used by
 * worker jobs that run with a different `CANTON_*` set than the
 * web process.
 */
export function buildCantonClientFromEnv(
  env: CantonEnv,
  fetchImpl?: FetchLike,
  clock?: () => Date,
): CantonClient {
  const config = loadCantonConfig(env);
  return new CantonClient({
    config,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    ...(clock !== undefined ? { clock } : {}),
  });
}

/**
 * Drop the cached client. Test-only. Production code never needs
 * this; the client is per-process and lives as long as the process.
 */
export function resetCantonClientForTests(): void {
  cached = null;
}
