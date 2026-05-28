/**
 * `CantonClient` — public facade combining config, HTTP, ledger,
 * and query operations into one object that the consumer layer can
 * hold on to.
 *
 * The facade is deliberately thin: every method delegates to a pure
 * function in `ledger.ts` or `query.ts`. The only reason it exists
 * is to bundle the `CantonConfig`, the injected `fetch`
 * implementation, and a monotonic clock into a single value that
 * flows through the service layer.
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
  fetchDisclosureBundleByHolder,
  findActiveCredentialByContractId,
  findActiveCredentialByHolder,
  findActiveKycNftByCredentialId,
  listActiveCredentials,
} from './query';
import type {
  ActiveContract,
  CommandId,
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

export interface CantonClientOptions {
  readonly config: CantonConfig;
  readonly fetchImpl?: FetchLike;
  readonly clock?: () => Date;
}

/* ---------- Facade ---------- */

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

  resolveNamespace(): Promise<string> {
    return resolveNamespace(this.config, this.fetchImpl);
  }

  partyExists(partyId: PartyId): Promise<boolean> {
    return partyExists(this.config, partyId, this.fetchImpl);
  }

  allocateParty(labelHint: string): Promise<PartyId> {
    return allocateParty(this.config, labelHint, this.fetchImpl);
  }

  /* ---- State ---- */

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

  revokeCredential(
    input: RevokeCredentialInput,
    issuerParty: PartyId,
  ): Promise<RevokeCredentialResult> {
    return revokeCredential(this.config, input, issuerParty, this.fetchImpl);
  }

  createKycNft(
    input: CreateKycNftInput,
    issuerParty: PartyId,
    options?: { readonly commandId?: CommandId },
  ): Promise<CreateKycNftResult> {
    return createKycNft(this.config, input, issuerParty, this.fetchImpl, options?.commandId);
  }

  /* ---- Reads ---- */

  listActiveCredentials(options: {
    readonly includeBlob: boolean;
    readonly offset?: string;
  }): Promise<readonly ActiveContract[]> {
    return listActiveCredentials(this.config, options, this.fetchImpl);
  }

  findActiveCredentialByHolder(
    holderParty: PartyId,
    options: { readonly includeBlob: boolean } = { includeBlob: false },
  ): Promise<ActiveContract | null> {
    return findActiveCredentialByHolder(this.config, holderParty, options, this.fetchImpl);
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

  fetchDisclosureBundleByHolder(holderParty: PartyId): Promise<DisclosureBundle | null> {
    return fetchDisclosureBundleByHolder(this.config, holderParty, this.fetchImpl, this.clock);
  }

  fetchDisclosureBundleByContractId(contractId: ContractId): Promise<DisclosureBundle | null> {
    return fetchDisclosureBundleByContractId(this.config, contractId, this.fetchImpl, this.clock);
  }

  /* ---- Diagnostics ---- */

  cachedNamespace(): string | null {
    return getCachedNamespace(this.config);
  }

  resetNamespaceCacheForTests(): void {
    resetNamespaceCacheForConfig(this.config);
  }
}

/* ---------- Process singleton ---------- */

let cached: CantonClient | null = null;

export function getCantonClient(): CantonClient {
  if (cached === null) {
    cached = new CantonClient({ config: getCantonConfig() });
  }
  return cached;
}

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

export function resetCantonClientForTests(): void {
  cached = null;
}
