/**
 * Browser-friendly mirror of `@canton-vc/adapter-mock`.
 *
 * `@canton-vc/adapter-mock` imports `node:crypto`, so it can't run in
 * the browser bundle. This shim produces the SAME `KycDecision` shape
 * (same fields, same types, same value semantics) but derives the
 * `proofHash` via `crypto.subtle.digest('SHA-256', ...)` — the
 * browser-native crypto API.
 *
 * The simulated `validator` field is swappable from the UI so the
 * demo can show the vendor-agnostic interface without depending on
 * any real vendor API. For exercising the real vendor flows
 * end-to-end (real HMAC, real webhook signatures), use the
 * issuer-demo CLI under `examples/issuer-demo`.
 *
 * @module
 */

import type {
  KycDecision,
  KycEvidence,
  KycProvider,
  KycSession,
  KycWebhookEvent,
  StartSessionOptions,
} from '@canton-vc/kyc-provider';

import { randomHex, sha256Hex } from './sha256.js';

export type SimulatedVendor = 'mock' | 'didit' | 'sumsub' | 'persona';

export class BrowserMockProvider implements KycProvider {
  readonly vendorName: string;
  readonly #vendor: SimulatedVendor;
  readonly #userRefBySession = new Map<string, string>();

  constructor(vendor: SimulatedVendor = 'mock') {
    this.#vendor = vendor;
    this.vendorName = vendor === 'mock' ? 'Mock' : vendor.charAt(0).toUpperCase() + vendor.slice(1);
  }

  async startSession(options: StartSessionOptions): Promise<KycSession> {
    if (typeof options.userRef !== 'string' || options.userRef.length === 0) {
      throw new Error('startSession: userRef is required.');
    }
    const sessionId = `${this.#vendor}_${randomHex(8)}`;
    this.#userRefBySession.set(sessionId, options.userRef);
    return Object.freeze({
      sessionId,
      redirectUrl: `https://demo.canton-vc.local/${this.#vendor}/${sessionId}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  }

  async fetchDecision(sessionId: string): Promise<KycDecision> {
    const userRef = this.#userRefBySession.get(sessionId) ?? '';
    const evidence: KycEvidence = {
      identityVerified: true,
      livenessVerified: true,
      addressVerified: false,
      humanScore: 0.95,
    };
    const proofHash = await sha256Hex(`${sessionId}|approved|basic`);
    const proofSchemaId = await sha256Hex(`canton-vc/${this.#vendor}/v1`);
    return Object.freeze({
      sessionId,
      userRef,
      status: 'approved',
      level: 'basic',
      evidence,
      proofHash,
      proofSchemaId,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      raw: { simulated: true, vendor: this.#vendor },
    });
  }

  async verifyWebhook(): Promise<KycWebhookEvent | null> {
    // Webhook verification requires server-side secret comparison;
    // not meaningful in a browser demo.
    return null;
  }
}
