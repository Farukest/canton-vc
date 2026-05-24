/**
 * In-memory Canton mock for the verifier-demo SPA.
 *
 * `@canton-vc/core`'s real `CantonClient` submits commands to a Canton
 * JSON Ledger v2 endpoint and waits for the sequencer to confirm. The
 * browser demo replaces it with an in-memory store: `createCredential`
 * records the input under a synthesized contract id, `verifyCredential`
 * looks it up and synthesizes a `CredentialView` from the stored
 * fields, and `fetchDisclosureBundleByContractId` returns the stored
 * blob.
 *
 * The mock is the only thing simulated — the demo uses the real
 * `verifyDisclosure()` from `@canton-vc/credential`, so the call site
 * the reviewer reads is unchanged. Swap `MockCantonClient` for a real
 * `CantonClient` pointed at a participant and the same flow drives an
 * on-chain mint + verify.
 *
 * @module
 */

import type {
  CantonClient,
  CommandId,
  ContractId,
  CreateCredentialInput,
  CreateCredentialResult,
  CreateKycNftInput,
  CreateKycNftResult,
  CredentialView,
  DamlCredentialStatus,
  DamlKycLevel,
  DamlValidatorType,
  DisclosureBundle,
  LedgerOffset,
  PartyId,
  RevokeCredentialInput,
  RevokeCredentialResult,
  UpdateId,
  VerifyCredentialInput,
  VerifyCredentialResult,
} from '@canton-vc/core';

import { randomHex, sha256Hex } from './sha256.js';

const VALIDATOR_TO_DAML: Readonly<Record<string, DamlValidatorType>> = Object.freeze({
  didit: 'DiditValidator',
  onfido: 'OnfidoValidator',
  persona: 'PersonaValidator',
  sumsub: 'SumsubValidator',
  veriff: 'VeriffValidator',
  au10tix: 'Au10tixValidator',
  jumio: 'JumioValidator',
  zk: 'ZkValidator',
  generic: 'Generic',
});

const STATUS_TO_DAML: Readonly<Record<string, DamlCredentialStatus>> = Object.freeze({
  pending: 'Pending',
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired',
});

const LEVEL_TO_DAML: Readonly<Record<string, DamlKycLevel>> = Object.freeze({
  basic: 'Basic',
  enhanced: 'Enhanced',
});

function base64Encode(input: string): string {
  return globalThis.btoa(input);
}

interface CredentialRecord {
  readonly input: CreateCredentialInput;
  readonly blobBase64: string;
  nftContractId: ContractId | null;
  revoked: boolean;
  readonly mintedAt: string;
}

interface NftRecord {
  readonly input: CreateKycNftInput;
  archived: boolean;
}

export class MockCantonClient {
  readonly #credentials = new Map<ContractId, CredentialRecord>();
  readonly #nfts = new Map<ContractId, NftRecord>();

  async resolveNamespace(): Promise<string> {
    return '1220mocknamespacefingerprintdeadbeefcafe00000000';
  }

  async partyExists(_partyId: PartyId): Promise<boolean> {
    return true;
  }

  async allocateParty(labelHint: string): Promise<PartyId> {
    const fingerprint = await sha256Hex(`${labelHint}-${randomHex(8)}`);
    return `${labelHint}::1220${fingerprint}` as PartyId;
  }

  async getLedgerEnd(): Promise<LedgerOffset> {
    return '0000000000000001' as LedgerOffset;
  }

  async createCredential(input: CreateCredentialInput): Promise<CreateCredentialResult> {
    const contractIdHex = await sha256Hex(
      [
        input.userParty,
        input.userRef,
        input.proofHash,
        input.proofSchemaId,
        input.status,
        input.level,
        input.validator,
        Date.now().toString(),
      ].join('|'),
    );
    const contractId = contractIdHex as ContractId;
    const blobBase64 = base64Encode(
      JSON.stringify({ contractId, templateId: 'canton-vc-credential', payload: { ...input } }),
    );
    this.#credentials.set(contractId, {
      input,
      blobBase64,
      nftContractId: null,
      revoked: false,
      mintedAt: new Date().toISOString(),
    });
    return Object.freeze({
      contractId,
      commandId: `mock-cmd-${randomHex(8)}` as CommandId,
      updateId: `mock-upd-${randomHex(16)}` as UpdateId,
      recordTime: new Date().toISOString(),
      completionOffset: (await this.getLedgerEnd()) as LedgerOffset,
    });
  }

  async verifyCredential(input: VerifyCredentialInput): Promise<VerifyCredentialResult> {
    const record = this.#credentials.get(input.contractId);
    if (record === undefined) {
      throw new Error(
        `Mock canton: contractId ${input.contractId.slice(0, 16)}… not found. ` +
          'Issue a credential in the Issue panel before verifying.',
      );
    }
    const view = this.#synthView(record);
    return Object.freeze({
      verified: view.isActive,
      view,
      contractId: input.contractId,
      commandId: `mock-cmd-${randomHex(8)}` as CommandId,
      updateId: `mock-upd-${randomHex(16)}` as UpdateId,
      recordTime: new Date().toISOString(),
    });
  }

  async revokeCredential(input: RevokeCredentialInput): Promise<RevokeCredentialResult> {
    const record = this.#credentials.get(input.contractId);
    if (record === undefined) {
      throw new Error(`Mock canton: contractId ${input.contractId.slice(0, 16)}… not found.`);
    }
    record.revoked = true;
    if (record.nftContractId !== null) {
      const nft = this.#nfts.get(record.nftContractId);
      if (nft !== undefined) {
        nft.archived = true;
      }
    }
    return Object.freeze({
      contractId: input.contractId,
      commandId: `mock-cmd-${randomHex(8)}` as CommandId,
      updateId: `mock-upd-${randomHex(16)}` as UpdateId,
      recordTime: new Date().toISOString(),
    });
  }

  async createKycNft(
    input: CreateKycNftInput,
    _options?: { readonly commandId?: CommandId },
  ): Promise<CreateKycNftResult> {
    const cred = this.#credentials.get(input.boundCredentialId);
    if (cred === undefined) {
      throw new Error(
        `Mock canton: bound credential ${input.boundCredentialId.slice(0, 16)}… not found.`,
      );
    }
    const contractIdHex = await sha256Hex(
      ['nft', input.customerParty, input.boundCredentialId, input.serialNumber].join('|'),
    );
    const contractId = contractIdHex as ContractId;
    this.#nfts.set(contractId, { input, archived: false });
    cred.nftContractId = contractId;
    return Object.freeze({
      contractId,
      commandId: `mock-cmd-${randomHex(8)}` as CommandId,
      updateId: `mock-upd-${randomHex(16)}` as UpdateId,
      recordTime: new Date().toISOString(),
      completionOffset: (await this.getLedgerEnd()) as LedgerOffset,
    });
  }

  async fetchDisclosureBundleByContractId(
    contractId: ContractId,
  ): Promise<DisclosureBundle | null> {
    const record = this.#credentials.get(contractId);
    if (record === undefined) return null;
    return Object.freeze({
      contract: {
        contractId,
        templateId: '#canton-vc-credential:Canton.VC.Credential:Credential',
        payload: record.input as unknown as Readonly<Record<string, unknown>>,
        createdEventBlob: record.blobBase64,
        synchronizerId: 'mock-domain',
      } as unknown as DisclosureBundle['contract'],
      blobBase64: record.blobBase64,
      fetchedAt: new Date(),
    });
  }

  /** Demo-only escape hatch — list whatever's been minted to render in the UI. */
  listMinted(): ReadonlyArray<{
    readonly contractId: ContractId;
    readonly userRef: string;
    readonly mintedAt: string;
    readonly revoked: boolean;
  }> {
    return Array.from(this.#credentials.entries()).map(([contractId, record]) => ({
      contractId,
      userRef: record.input.userRef,
      mintedAt: record.mintedAt,
      revoked: record.revoked,
    }));
  }

  /** Demo-only escape hatch — fetch the blob without going through DisclosedContract. */
  getBlob(contractId: ContractId): string | null {
    const record = this.#credentials.get(contractId);
    return record?.blobBase64 ?? null;
  }

  /** Compute the on-chain view the way the participant would. */
  #synthView(record: CredentialRecord): CredentialView {
    const now = new Date();
    const validUntil = new Date(record.input.validUntil);
    const status: DamlCredentialStatus = record.revoked
      ? 'Revoked'
      : STATUS_TO_DAML[record.input.status] ?? 'Pending';
    const isActive = status === 'Active' && now <= validUntil;
    return Object.freeze({
      userRef: record.input.userRef,
      proofHash: record.input.proofHash,
      status,
      level: LEVEL_TO_DAML[record.input.level] ?? 'Basic',
      validUntil: record.input.validUntil,
      network: 'mock',
      humanScore: record.input.humanScore,
      validator: VALIDATOR_TO_DAML[record.input.validator] ?? 'Generic',
      identityVerified: record.input.identityVerified,
      livenessVerified: record.input.livenessVerified,
      addressVerified: record.input.addressVerified,
      isActive,
      proofSchemaId: record.input.proofSchemaId,
    });
  }
}

/**
 * Get a singleton mock canton client for the SPA. Shared across all
 * panels so a credential minted in one panel is visible to the
 * verifier panel.
 */
let singleton: MockCantonClient | null = null;
export function getMockCanton(): MockCantonClient {
  if (singleton === null) {
    singleton = new MockCantonClient();
  }
  return singleton;
}

/**
 * Cast the mock to the SDK's `CantonClient` shape. The SDK only
 * touches the methods we implement above; remaining methods are
 * out of the demo's code paths. Cast through `unknown` per TS norm
 * for partial-conformance test mocks.
 */
export function asCantonClient(mock: MockCantonClient): CantonClient {
  return mock as unknown as CantonClient;
}
