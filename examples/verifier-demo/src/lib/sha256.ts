/**
 * Browser-friendly SHA-256 with a pure-JS fallback.
 *
 * `crypto.subtle` is only available in secure contexts (https or
 * localhost). When the demo is served over a plain-http origin
 * (typical for MCP / docker bridges / LAN inspection), `crypto.subtle`
 * is `undefined`. This helper detects that and falls back to a
 * compact pure-JS implementation of SHA-256.
 *
 * The crypto strength of the demo's hash output does not matter —
 * `proofHash` and `proofSchemaId` in the mock pipeline are deterministic
 * identifiers, not security primitives. Production issuers derive the
 * same fields through `@canton-vc/core#computeProofHash` (Node /
 * Web Worker context with full `node:crypto` or secure-context
 * `crypto.subtle`).
 *
 * @module
 */

const ENCODER = new TextEncoder();

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256Pure(bytes: Uint8Array): string {
  const l = bytes.length;
  const padLen = (l % 64 < 56 ? 56 : 120) - (l % 64);
  const buf = new Uint8Array(l + padLen + 8);
  buf.set(bytes);
  buf[l] = 0x80;
  const bits = BigInt(l) * 8n;
  for (let i = 0; i < 8; i += 1) {
    buf[buf.length - 1 - i] = Number((bits >> BigInt(i * 8)) & 0xffn);
  }

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  const w = new Uint32Array(64);
  for (let offset = 0; offset < buf.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] =
        ((buf[j] ?? 0) << 24) |
        ((buf[j + 1] ?? 0) << 16) |
        ((buf[j + 2] ?? 0) << 8) |
        (buf[j + 3] ?? 0);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15] ?? 0, 7) ^ rotr(w[i - 15] ?? 0, 18) ^ ((w[i - 15] ?? 0) >>> 3);
      const s1 = rotr(w[i - 2] ?? 0, 17) ^ rotr(w[i - 2] ?? 0, 19) ^ ((w[i - 2] ?? 0) >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + mj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + b) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
    h[5] = ((h[5] ?? 0) + f) >>> 0;
    h[6] = ((h[6] ?? 0) + g) >>> 0;
    h[7] = ((h[7] ?? 0) + hh) >>> 0;
  }
  return h.map((n) => n.toString(16).padStart(8, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = ENCODER.encode(input);
  // Prefer the platform-native impl when available (secure context).
  if (typeof crypto !== 'undefined' && crypto.subtle !== undefined) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fall back to the pure-JS implementation for non-secure contexts.
  return sha256Pure(bytes);
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
