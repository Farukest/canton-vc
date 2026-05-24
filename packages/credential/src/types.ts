/**
 * Public types for `@canton-vc/credential` — the OAuth/OIDC client +
 * disclosure verifier helper for Canton-issued verifiable credentials.
 *
 * # Wire field naming
 *
 * The canonical claim names are `canton_vc_*` (e.g.
 * `canton_vc_credential_blob`, `canton_vc_contract_id`). This SDK
 * accepts only the canonical names — issuers emitting vendor-specific
 * aliases must rename them at the wire layer before consumption.
 *
 * The fields and OAuth scopes are stable and mirror the spec drafted
 * in the canton-vc CIP proposal. They are re-declared here (instead
 * of imported) so consumers can install just `@canton-vc/credential`
 * without an extra type dependency.
 *
 * @module
 */

/**
 * OAuth scope strings the issuer's authorize endpoint accepts.
 *
 * Canonical:
 *  - `openid` — issue an `id_token` with `sub`.
 *  - `kyc` — emit identity / liveness / address verification flags.
 *  - `kyc:address` — emit address-line attributes.
 *  - `kyc:scores` — emit humanity / risk scores.
 *  - `canton-vc` — emit the on-chain disclosure bundle
 *    (`canton_vc_credential_blob` + `canton_vc_contract_id`),
 *    enabling trustless verification via {@link verifyDisclosure}.
 *
 * Legacy aliases (accepted by the reference issuer):
 *  - `kyc:canton` — equivalent to `canton-vc`.
 */
export type CantonVcScope =
  | 'openid'
  | 'kyc'
  | 'kyc:address'
  | 'kyc:scores'
  | 'canton-vc'
  | 'kyc:canton';

/**
 * Userinfo / id_token claim shape emitted by a canton-vc-compatible
 * issuer. Every field is optional — a firm only sees the claims its
 * scope list covered. `sub` is present whenever `openid` was requested.
 *
 * The `canton_vc_*` family (proof_hash / level / valid_until /
 * network / contract_id / credential_blob) is gated by the
 * `canton-vc` scope; request that scope to receive the on-chain
 * proof bundle and feed it into {@link verifyDisclosure} for
 * trustless verification against your own Canton participant.
 */
export interface CantonVcClaims {
  readonly sub?: string;
  readonly identity_verified?: boolean;
  readonly liveness_verified?: boolean;
  readonly address_verified?: boolean;
  readonly humanity_score?: number;

  /* Canonical canton-vc claims */
  readonly canton_vc_proof_hash?: string;
  readonly canton_vc_level?: 'basic' | 'enhanced';
  readonly canton_vc_valid_until?: string;
  readonly canton_vc_network?: string;
  readonly canton_vc_contract_id?: string | null;
  /**
   * Canton `createdEventBlob` (base64url) for the credential's
   * on-chain contract. Present only when the `canton-vc` scope is
   * granted and a credential is active. Pass to
   * {@link verifyDisclosure} along with a `CantonClient` pointed at
   * your participant to verify the credential on-chain without
   * trusting the issuer's off-chain claim set.
   */
  readonly canton_vc_credential_blob?: string;
}

export interface CantonVcClientOptions {
  /**
   * Full origin of the issuer deployment, no trailing slash.
   * Optional; defaults to the placeholder `https://issuer.example`
   * so the type is callable without a value, but callers should
   * always set this to the real issuer origin.
   */
  readonly issuer?: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /**
   * Confidential clients only. MUST NOT be set in the browser —
   * pass only from server code when calling {@link CantonVcClient.exchangeCode}.
   */
  readonly clientSecret?: string;
  /**
   * Fetch implementation. Defaults to the global `fetch`. Override
   * for tests, Node <18, or edge runtimes that expose a custom
   * implementation.
   */
  readonly fetch?: typeof fetch;
}

export interface AuthorizeOptions {
  readonly scope: readonly CantonVcScope[];
  /**
   * Optional OIDC nonce. When omitted, the SDK generates one and
   * stashes it in storage so the callback can verify the id_token.
   */
  readonly nonce?: string;
  /**
   * Override the redirect_uri for this particular authorize call.
   * Defaults to the client-level value. Useful when a single client
   * serves multiple pages with distinct callbacks.
   */
  readonly redirectUri?: string;
  /**
   * BCP 47 tag ordering the consent page should follow (e.g. `"tr en"`).
   * Ignored silently if the issuer doesn't support any of them.
   */
  readonly uiLocales?: string;
}

export interface AuthorizeUrl {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce?: string;
}

export interface CallbackResult {
  /** Raw authorization code returned by the issuer. */
  readonly code: string;
  /**
   * The `state` value the server echoed. Already validated against
   * storage — present as a convenience only.
   */
  readonly state: string;
  /**
   * PKCE `code_verifier` the code was bound to. Pass this to
   * {@link CantonVcClient.exchangeCode} along with the code.
   */
  readonly codeVerifier: string;
  /** The exact redirect_uri the authorize step used. */
  readonly redirectUri: string;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly scope: string;
  readonly id_token?: string;
  readonly refresh_token?: string;
}
