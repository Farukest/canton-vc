/**
 * Sumsub HMAC helpers.
 *
 * Sumsub authenticates **every** REST request with a per-request HMAC,
 * unlike Didit which uses a static API key. The signature is computed
 * over the concatenation of:
 *
 *   `${timestampSeconds}${HTTP_METHOD}${requestPath}${bodyString}`
 *
 * using HMAC-SHA256 keyed with the app's `secretKey`. The result is
 * hex-encoded and sent in `X-App-Access-Sig`, together with
 * `X-App-Access-Ts` (timestamp) and `X-App-Token` (the public token).
 *
 * Sumsub webhooks use a SEPARATE shared secret (configured per webhook
 * endpoint in the Sumsub console) and a different scheme: the digest
 * is HMAC over the raw request body bytes. The algorithm is selected
 * by the `X-Payload-Digest-Alg` header — Sumsub currently emits
 * `HMAC_SHA1_HEX`, `HMAC_SHA256_HEX`, or `HMAC_SHA512_HEX`.
 *
 * Both helpers run in constant time on the comparison step to avoid
 * timing side-channels.
 *
 * @module
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sign a Sumsub REST request. Returns the hex HMAC digest the caller
 * should send in `X-App-Access-Sig`.
 *
 * @param secretKey Sumsub app secret key.
 * @param tsSeconds Unix epoch seconds as a string (must equal what
 *   you'll send in `X-App-Access-Ts`).
 * @param method HTTP method, uppercase ("GET" / "POST" / ...).
 * @param path Request path **including** the leading `/` and any
 *   query string. Body should be the JSON-stringified body, or an
 *   empty string for `GET` / no-body requests.
 */
export function signSumsubRequest(
  secretKey: string,
  tsSeconds: string,
  method: string,
  path: string,
  body: string,
): string {
  const payload = `${tsSeconds}${method}${path}${body}`;
  return createHmac('sha256', secretKey).update(payload).digest('hex');
}

/**
 * Supported Sumsub webhook digest algorithms keyed by the value
 * Sumsub sends in `X-Payload-Digest-Alg`.
 */
export const SUMSUB_WEBHOOK_ALGS = {
  HMAC_SHA1_HEX: 'sha1',
  HMAC_SHA256_HEX: 'sha256',
  HMAC_SHA512_HEX: 'sha512',
} as const;

export type SumsubWebhookAlg = keyof typeof SUMSUB_WEBHOOK_ALGS;

export function isSupportedWebhookAlg(value: unknown): value is SumsubWebhookAlg {
  return typeof value === 'string' && value in SUMSUB_WEBHOOK_ALGS;
}

/**
 * Verify a Sumsub webhook digest in constant time.
 *
 * @param webhookSecret Per-endpoint secret configured in Sumsub
 *   console.
 * @param rawBody Exact request body bytes Sumsub posted.
 * @param providedHex Hex digest from `X-Payload-Digest` header.
 * @param alg Algorithm name from `X-Payload-Digest-Alg`.
 *
 * Returns `true` if the digest matches.
 */
export function verifySumsubWebhookDigest(
  webhookSecret: string,
  rawBody: string,
  providedHex: string,
  alg: SumsubWebhookAlg,
): boolean {
  const nodeAlg = SUMSUB_WEBHOOK_ALGS[alg];
  const expected = createHmac(nodeAlg, webhookSecret).update(rawBody).digest('hex');
  if (expected.length !== providedHex.length) return false;
  // Reject anything that isn't a valid hex digest before handing it to
  // `Buffer.from(..., 'hex')` — non-hex characters silently truncate the
  // buffer and would otherwise make `timingSafeEqual` throw a RangeError
  // instead of returning a clean false. We already checked the length
  // matches the expected digest length above.
  if (!/^[0-9a-f]+$/i.test(providedHex)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(providedHex, 'hex'));
}
