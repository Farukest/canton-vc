/**
 * Canton-side disclosure verification helper — v2.0.0 (CIP #204).
 *
 * After a successful OAuth flow finishes, the consumer holds a set
 * of `CantonVcClaims` from the userinfo / id_token surface. When
 * the `canton-vc` scope was granted, those claims include
 * `canton_vc_credential_blob` (Canton `createdEventBlob`, base64url)
 * and `canton_vc_contract_id`. `verifyDisclosure()` takes the
 * caller's own `CantonClient` (pointed at their participant),
 * attaches the blob as a `DisclosedContract` on the standard
 * `Credential_PublicFetch` choice exercise, and returns the on-chain
 * `CredentialView`.
 *
 * Why this matters for non-custodial verification:
 *
 *   * Canton's contract-authentication step on the caller's
 *     participant re-derives the contract id hash from the blob and
 *     checks the sequencer signature. A tampered or fabricated blob
 *     is rejected with `DISCLOSED_CONTRACT_AUTHENTICATION_FAILED`
 *     before the choice body runs — so the caller trusts the
 *     network, not the issuer, for the credential's authenticity.
 *   * The `expectedAdmin` argument is asserted equal to
 *     `(view this).admin` inside the choice body per CIP #204
 *     §"Implementations MUST validate" — a substituted credential
 *     is rejected at the chain boundary, not silently returned.
 *   * The `CredentialView` returned by the choice is computed
 *     server-side from on-chain state. The caller reads the
 *     credential's truth entirely from this struct; the OAuth claim
 *     set is treated only as a delivery hint.
 *
 * @module
 */

import type { CantonClient, ContractId, CredentialView, PartyId } from '@canton-vc/core';

import { CantonVcOauthError } from './errors';
import type { CantonVcClaims } from './types';

/**
 * Options accepted by {@link verifyDisclosure}.
 */
export interface VerifyDisclosureOptions {
  /**
   * The caller's `CantonClient` pointed at their own Canton
   * participant.
   */
  readonly canton: CantonClient;
  /**
   * The caller's own Canton party — the `Credential_PublicFetch`
   * choice's `actor` (controller). Allocated on the caller's
   * participant before any verify calls.
   */
  readonly actor: string;
  /**
   * The admin party the caller expects on the credential. The
   * implementer asserts `expectedAdmin == admin` inside the choice
   * body. Typically the issuer's published admin party id (the
   * disclosure authority advertised in the issuer's OIDC discovery
   * document or out-of-band trust list).
   */
  readonly expectedAdmin: string;
}

/**
 * Verify the credential bundle that the issuer delivered via OAuth
 * userinfo against the caller's own Canton participant.
 *
 * Reads `canton_vc_credential_blob` + `canton_vc_contract_id` from
 * `claims`, attaches the blob as a `DisclosedContract`, exercises
 * the CIP #204 standard `Credential_PublicFetch` choice with
 * `opts.actor` as controller and `opts.expectedAdmin` as the
 * substitution guard, and returns the `CredentialView` struct the
 * choice body computed from on-chain state.
 *
 * Throws {@link CantonVcOauthError} with `code='disclosure_blob_missing'`
 * or `'disclosure_contract_id_missing'` when the claims don't
 * carry the on-chain bundle. Throws a `CantonError` from
 * `@canton-vc/core` on any participant-side failure (network,
 * auth, blob authentication, expected-admin mismatch).
 */
export async function verifyDisclosure(
  claims: CantonVcClaims,
  opts: VerifyDisclosureOptions,
): Promise<CredentialView> {
  const blob = claims.canton_vc_credential_blob;
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new CantonVcOauthError(
      'disclosure_blob_missing',
      'Userinfo response is missing `canton_vc_credential_blob`. Request the `canton-vc` scope on authorize so the issuer ships the on-chain disclosure bundle.',
    );
  }

  const contractId = claims.canton_vc_contract_id;
  if (typeof contractId !== 'string' || contractId.length === 0) {
    throw new CantonVcOauthError(
      'disclosure_contract_id_missing',
      'Userinfo response is missing `canton_vc_contract_id`. The `canton-vc` scope was granted but no active credential was found — check `claims.sub` against your records.',
    );
  }

  const result = await opts.canton.verifyCredential({
    contractId: contractId as ContractId,
    actor: opts.actor as PartyId,
    expectedAdmin: opts.expectedAdmin as PartyId,
    disclosedBlobBase64: blob,
  });

  return result.view;
}
