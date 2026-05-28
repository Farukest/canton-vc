// @vitest-environment node

import type { CantonClient, CredentialView, VerifyCredentialResult } from '@canton-vc/core';
import { describe, expect, it, vi } from 'vitest';
import { verifyDisclosure } from '../src/canton';
import { CantonVcOauthError } from '../src/errors';
import type { CantonVcClaims } from '../src/types';

const FIXTURE_VIEW: CredentialView = Object.freeze({
  admin: 'Admin::1220abc' as CredentialView['admin'],
  issuer: 'Issuer::1220abc' as CredentialView['issuer'],
  holder: 'Holder::1220abc' as CredentialView['holder'],
  claims: {
    values: {
      'com.example/userRef': 'Customer-19b69f4d-df6b-40f9-becc-30f3bb00cbf1',
      'com.example/level': 'Enhanced',
    },
    validFrom: null,
    validUntil: '2027-05-10T22:37:24Z',
    meta: {},
  },
  createdAt: '2026-05-10T22:37:24Z',
  expiresAt: '2027-05-10T22:37:24Z',
  meta: {},
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
  const client = { verifyCredential: verifySpy } as unknown as CantonClient;
  return { client, verifySpy };
}

const VERIFY_OPTS = {
  actor: 'AcmeFirm::1220abc',
  expectedAdmin: 'Admin::1220abc',
};

describe('verifyDisclosure', () => {
  it('returns the on-chain CredentialView when the claims carry a full bundle', async () => {
    const claims = buildClaimsWithBundle();
    const { client, verifySpy } = buildMockCantonClient();

    const view = await verifyDisclosure(claims, { canton: client, ...VERIFY_OPTS });

    expect(view).toBe(FIXTURE_VIEW);
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith({
      contractId: claims.canton_vc_contract_id,
      actor: VERIFY_OPTS.actor,
      expectedAdmin: VERIFY_OPTS.expectedAdmin,
      disclosedBlobBase64: claims.canton_vc_credential_blob,
    });
  });

  it('throws disclosure_blob_missing when canton_vc_credential_blob is absent', async () => {
    const claims = buildClaimsWithBundle();
    delete (claims as { canton_vc_credential_blob?: string }).canton_vc_credential_blob;
    const { client, verifySpy } = buildMockCantonClient();

    await expect(
      verifyDisclosure(claims, { canton: client, ...VERIFY_OPTS }),
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
      verifyDisclosure(claims, { canton: client, ...VERIFY_OPTS }),
    ).rejects.toBeInstanceOf(CantonVcOauthError);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('throws disclosure_contract_id_missing when canton_vc_contract_id is absent', async () => {
    const claims = buildClaimsWithBundle();
    delete (claims as { canton_vc_contract_id?: string | null }).canton_vc_contract_id;
    const { client, verifySpy } = buildMockCantonClient();

    await expect(
      verifyDisclosure(claims, { canton: client, ...VERIFY_OPTS }),
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
      verifyDisclosure(claims, { canton: client, ...VERIFY_OPTS }),
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

    await expect(verifyDisclosure(claims, { canton: client, ...VERIFY_OPTS })).rejects.toBe(
      cantonError,
    );
  });
});
