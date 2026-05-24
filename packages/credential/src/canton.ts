/**
 * Canton-side disclosure verification helper.
 *
 * After a successful OAuth flow finishes, the firm holds a set of
 * `CantonVcClaims` from the userinfo / id_token surface. When the
 * `canton-vc` scope was granted, those claims include
 * `canton_vc_credential_blob` (Canton `createdEventBlob`, base64url)
 * and `canton_vc_contract_id`. `verifyDisclosure()` takes the firm's
 * own `CantonClient` (pointed at their participant), attaches the
 * blob as a `DisclosedContract` on the `Verify` choice exercise, and
 * returns the on-chain `CredentialView` struct.
 *
 * Why this matters for non-custodial verification:
 *
 *   * Canton's contract-authentication step on the firm's
 *     participant re-derives the contract id hash from the blob and
 *     checks the sequencer signature. A tampered or fabricated blob
 *     is rejected with `DISCLOSED_CONTRACT_AUTHENTICATION_FAILED`
 *     before the choice body runs — so the firm trusts the network,
 *     not the issuer, for the credential's authenticity.
 *   * The `CredentialView` returned by the choice is computed
 *     server-side from on-chain state (including `isActive` =
 *     `status == "Active" && now <= validUntil`). The firm reads
 *     the credential's truth entirely from this struct; the
 *     OAuth claim set is treated only as a delivery hint.
 *
 * Firm-side post-checks (NOT enforced here — policy lives in the
 * firm's domain):
 *
 *   * `view.isActive` MUST be `true` before granting access.
 *   * `view.userRef` SHOULD equal the firm's internal user id (the
 *     value the issuer bound to this credential at mint time, also
 *     mirrored in `claims.sub`).
 *   * `view.level` / `view.identityVerified` / `view.addressVerified`
 *     are compared against the firm's KYC policy.
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
   * The firm's `CantonClient` pointed at their own Canton
   * participant. Build it once on startup with the firm's base URL,
   * party namespace, and (optional) JSON Ledger auth token.
   */
  readonly canton: CantonClient;
  /**
   * The firm's own Canton party — the `Verify` choice's
   * `controller fetcher`. Format: `<Label>::<fingerprint>`
   * (e.g. `AcmeFirm::1220deadbeef…`). Allocated on the firm's
   * participant before any verify calls.
   */
  readonly fetcher: string;
}

/**
 * Verify the credential bundle that the issuer delivered via OAuth
 * userinfo against the firm's own Canton participant.
 *
 * Reads `canton_vc_credential_blob` + `canton_vc_contract_id` from
 * `claims`, attaches the blob as a `DisclosedContract` on the
 * `Verify` choice exercise, submits with `opts.fetcher` as the
 * controller, and returns the `CredentialView` struct the choice
 * body computed from on-chain state.
 *
 * Throws {@link CantonVcOauthError} with `code='disclosure_blob_missing'`
 * or `'disclosure_contract_id_missing'` when the claims don't
 * carry the on-chain bundle (typically because the `canton-vc`
 * scope was not in the consent scope, or the user's credential is
 * revoked). Throws a `CantonError` from `@canton-vc/core` on any
 * participant-side failure (network, auth, blob authentication).
 *
 * @example
 * ```ts
 * import { CantonVcClient } from '@canton-vc/credential';
 * import { CantonClient, loadCantonConfig, verifyDisclosure } from '@canton-vc/core';
 *
 * const issuer = new CantonVcClient({ clientId, redirectUri, clientSecret });
 * const canton = new CantonClient({ config: loadCantonConfig() });
 *
 * // …complete the OAuth flow up to userinfo…
 * const claims = await issuer.userinfo(accessToken);
 *
 * const view = await verifyDisclosure(claims, {
 *   canton,
 *   fetcher: 'AcmeFirm::1220abc…',
 * });
 *
 * if (!view.isActive) throw new Error('Credential not active on chain');
 * if (view.userRef !== claims.sub) throw new Error('Credential bound to a different user');
 * ```
 */
export async function verifyDisclosure(
  claims: CantonVcClaims,
  opts: VerifyDisclosureOptions,
): Promise<CredentialView> {
  // Canonical claim names only. Issuers emitting vendor-specific
  // aliases must rename them at the wire layer before consumption.
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
    fetcher: opts.fetcher as PartyId,
    disclosedBlobBase64: blob,
  });

  return result.view;
}
