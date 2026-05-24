// @vitest-environment node


import type { CantonClient, CredentialView, VerifyCredentialResult } from '@canton-vc/core';
import { describe, expect, it, vi } from 'vitest';
import { verifyDisclosure } from '../src/canton';
import { CantonVcOauthError } from '../src/errors';
import type { CantonVcClaims } from '../src/types';

const FIXTURE_VIEW: CredentialView = Object.freeze({
  userRef: 'Customer-19b69f4d-df6b-40f9-becc-30f3bb00cbf1',
  proofHash: 'f64293282671f911d9adf6caf9320f3946abd5f51d269b49285a318f0d8871b8',
  status: 'Active',
  level: 'Enhanced',
  validUntil: '2027-05-10T22:37:24Z',
  network: 'Canton Devnet',
  humanScore: 0,
  validator: 'DiditValidator',
  identityVerified: true,
  livenessVerified: true,
  addressVerified: true,
  isActive: true,
  proofSchemaId: 'cafebabe1234567890abcdef',
});

function buildClaimsWithBundle(): CantonVcClaims {
  return {
    sub: '19b69f4d-df6b-40f9-becc-30f3bb00cbf1',
    identity_verified: true,
    liveness_verified: true,
    address_verified: true,
    canton_vc_level: 'enhanced',
    canton_vc_valid_until: '2027-05-10T22:37:24.361Z',
    canton_vc_network: 'devnet',
    canton_vc_contract_id: '007204246675279bd45dda3805532b427ead69ab9f29d1cd7c75ad90de51fb02',
    canton_vc_proof_hash: 'f64293282671f911d9adf6caf9320f3946abd5f51d269b49285a318f0d8871b8',
    canton_vc_credential_blob: 'CgMyLjESxQYKRQByBCRmdSeb1F3aOAVTK0J-rWmrnynRzXx1rZDeUfsCuMoSEi',
  };
}

function buildMockCantonClient(
  result: VerifyCredentialResult = {
    verified: true,
    view: FIXTURE_VIEW,
    contractId: 'contract-fixture' as VerifyCredentialResult['contractId'],
    commandId: 'cmd-fixture' as VerifyCredentialResult['commandId'],
    updateId: 'update-fixture' as VerifyCredentialResult['updateId'],
    recordTime: '2026-05-10T00:00:00Z',
  },
): {
  client: CantonClient;
  verifySpy: ReturnType<typeof vi.fn>;
} {
  const verifySpy = vi.fn(async () => result);
  // Type-assert through `unknown` — we only exercise `verifyCredential`.
  const client = { verifyCredential: verifySpy } as unknown as CantonClient;
  return { client, verifySpy };
}

describe('verifyDisclosure', () => {
  it('returns the on-chain CredentialView when the claims carry a full bundle', async () => {
    const claims = buildClaimsWithBundle();
    const { client, verifySpy } = buildMockCantonClient();

    const view = await verifyDisclosure(claims, {
      canton: client,
      fetcher: 'AcmeFirm::1220abc',
    });

    expect(view).toBe(FIXTURE_VIEW);
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith({
      contractId: claims.canton_vc_contract_id,
      fetcher: 'AcmeFirm::1220abc',
      disclosedBlobBase64: claims.canton_vc_credential_blob,
    });
  });

  it('throws disclosure_blob_missing when canton_vc_credential_blob is absent', async () => {
    const claims = buildClaimsWithBundle();
    delete (claims as { canton_vc_credential_blob?: string }).canton_vc_credential_blob;
    const { client, verifySpy } = buildMockCantonClient();

    await expect(
      verifyDisclosure(claims, { canton: client, fetcher: 'AcmeFirm::1220abc' }),
    ).rejects.toMatchObject({
      name: 'CantonVcOauthError',
      code: 'disclosure_blob_missing',
    });

    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('throws disclosure_blob_missing when canton_vc_credential_blob is empty', async () => {
    const claims: CantonVcClaims = { ...buildClaimsWithBundle(), canton_vc_credential_blob: '' };
    const { client, verifySpy } = buildMockCantonClient();

    await expect(
      verifyDisclosure(claims, { canton: client, fetcher: 'AcmeFirm::1220abc' }),
    ).rejects.toBeInstanceOf(CantonVcOauthError);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('throws disclosure_contract_id_missing when canton_vc_contract_id is absent', async () => {
    const claims = buildClaimsWithBundle();
    delete (claims as { canton_vc_contract_id?: string | null }).canton_vc_contract_id;
    const { client, verifySpy } = buildMockCantonClient();

    await expect(
      verifyDisclosure(claims, { canton: client, fetcher: 'AcmeFirm::1220abc' }),
    ).rejects.toMatchObject({
      name: 'CantonVcOauthError',
      code: 'disclosure_contract_id_missing',
    });

    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('throws disclosure_contract_id_missing when canton_vc_contract_id is null', async () => {
    const claims: CantonVcClaims = { ...buildClaimsWithBundle(), canton_vc_contract_id: null };
    const { client, verifySpy } = buildMockCantonClient();

    await expect(
      verifyDisclosure(claims, { canton: client, fetcher: 'AcmeFirm::1220abc' }),
    ).rejects.toMatchObject({
      name: 'CantonVcOauthError',
      code: 'disclosure_contract_id_missing',
    });
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('propagates Canton-side errors from the verifyCredential call', async () => {
    const claims = buildClaimsWithBundle();
    const cantonError = new Error('DISCLOSED_CONTRACT_AUTHENTICATION_FAILED');
    const verifySpy = vi.fn(async () => {
      throw cantonError;
    });
    const client = { verifyCredential: verifySpy } as unknown as CantonClient;

    await expect(
      verifyDisclosure(claims, { canton: client, fetcher: 'AcmeFirm::1220abc' }),
    ).rejects.toBe(cantonError);
  });

  it('does NOT post-check view.isActive — policy stays at the call site', async () => {
    const claims = buildClaimsWithBundle();
    const inactiveView: CredentialView = { ...FIXTURE_VIEW, isActive: false, status: 'Revoked' };
    const { client } = buildMockCantonClient({
      verified: true,
      view: inactiveView,
      contractId: 'contract-fixture' as VerifyCredentialResult['contractId'],
      commandId: 'cmd-fixture' as VerifyCredentialResult['commandId'],
      updateId: 'update-fixture' as VerifyCredentialResult['updateId'],
      recordTime: '2026-05-10T00:00:00Z',
    });

    const view = await verifyDisclosure(claims, {
      canton: client,
      fetcher: 'AcmeFirm::1220abc',
    });

    expect(view.isActive).toBe(false);
    expect(view.status).toBe('Revoked');
  });
});
