/**
 * `@canton-vc/credential` — high-level OAuth 2.0 / OIDC client +
 * on-chain disclosure verification helper for Canton-issued
 * verifiable credentials.
 *
 * ```ts
 * import {
 *   CantonVcClient,
 *   CantonVcOauthError,
 *   verifyDisclosure,
 * } from '@canton-vc/credential';
 * ```
 *
 * @module
 */

export type { VerifyDisclosureOptions } from './canton';
export { verifyDisclosure } from './canton';
export { CantonVcClient } from './client';
export type {
  CantonVcOauthErrorCode,
  CantonVcOauthErrorOptions,
} from './errors';
export {
  CantonVcOauthError,
  isCantonVcOauthError,
} from './errors';
export type { CodeChallengeMethod } from './pkce';
export {
  computeCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from './pkce';
export type { SdkStorage, StoredAuthorizationRequest } from './storage';
export {
  clearAuthorizationRequest,
  createDefaultStorage,
  persistAuthorizationRequest,
  readAuthorizationRequest,
} from './storage';
export type {
  AuthorizeOptions,
  AuthorizeUrl,
  CallbackResult,
  CantonVcClaims,
  CantonVcClientOptions,
  CantonVcScope,
  TokenResponse,
} from './types';
