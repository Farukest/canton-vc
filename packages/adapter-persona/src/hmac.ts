/**
 * Persona webhook signature helpers.
 *
 * Persona ships a per-event signature in the `Persona-Signature`
 * header with the format:
 *
 *   t=<unix-ts>,v1=<hex>
 *
 * Optionally multiple space-separated pairs during key rotation:
 *
 *   t=<ts1>,v1=<hex1> t=<ts2>,v1=<hex2>
 *
 * The signed payload is `<ts>.<rawBody>`, keyed with the per-endpoint
 * webhook secret configured in the Persona console. The algorithm is
 * HMAC-SHA256, hex-encoded.
 *
 * Comparison is constant-time to avoid timing side-channels.
 *
 * @module
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PersonaSignaturePair {
  readonly timestamp: string;
  readonly signatureHex: string;
}

/**
 * Parse the `Persona-Signature` header into one or more `t=`/`v1=`
 * pairs. Returns `null` when the header is empty / unparseable.
 *
 * Per Persona's docs the header may contain multiple pairs separated
 * by a single space during webhook key rotation; both must verify so
 * we can accept the message regardless of which key Persona used.
 */
export function parsePersonaSignatureHeader(
  header: string,
): readonly PersonaSignaturePair[] | null {
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  const pairs: PersonaSignaturePair[] = [];
  for (const segment of trimmed.split(/\s+/)) {
    let timestamp: string | undefined;
    let sig: string | undefined;
    for (const kv of segment.split(',')) {
      const eq = kv.indexOf('=');
      if (eq === -1) continue;
      const k = kv.slice(0, eq).trim();
      const v = kv.slice(eq + 1).trim();
      if (k === 't') timestamp = v;
      else if (k === 'v1') sig = v;
    }
    if (
      typeof timestamp === 'string' &&
      timestamp.length > 0 &&
      typeof sig === 'string' &&
      sig.length > 0
    ) {
      pairs.push(Object.freeze({ timestamp, signatureHex: sig }));
    }
  }
  return pairs.length > 0 ? pairs : null;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Persona webhook signature pair. Computes
 * `HMAC-SHA256(secret, ts + '.' + rawBody)` and compares hex digests
 * in constant time.
 */
export function verifyPersonaSignaturePair(
  webhookSecret: string,
  rawBody: string,
  pair: PersonaSignaturePair,
): boolean {
  const expected = createHmac('sha256', webhookSecret)
    .update(`${pair.timestamp}.${rawBody}`)
    .digest('hex');
  return constantTimeHexEqual(expected, pair.signatureHex);
}

/**
 * Verify the full `Persona-Signature` header. Returns `true` if ANY
 * `(t, v1)` pair verifies against the provided secret — Persona may
 * include two pairs during key rotation and either is authoritative.
 *
 * Also enforces a freshness window (`driftSeconds`) on each timestamp
 * to reduce replay risk; pairs outside the drift window are rejected
 * even if the signature is otherwise valid. Default drift = 300s
 * (matching Stripe / Persona's own guidance).
 */
export function verifyPersonaSignatureHeader(
  webhookSecret: string,
  rawBody: string,
  header: string,
  options: { readonly driftSeconds?: number; readonly nowSeconds?: number } = {},
): boolean {
  const pairs = parsePersonaSignatureHeader(header);
  if (pairs === null) return false;
  const drift = options.driftSeconds ?? 300;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  for (const pair of pairs) {
    const tsSeconds = Number.parseInt(pair.timestamp, 10);
    if (!Number.isFinite(tsSeconds)) continue;
    if (Math.abs(now - tsSeconds) > drift) continue;
    if (verifyPersonaSignaturePair(webhookSecret, rawBody, pair)) return true;
  }
  return false;
}
