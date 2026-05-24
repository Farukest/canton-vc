/**
 * `@canton-vc/adapter-mock` — deterministic mock `KycProvider` for
 * testing and local development.
 *
 * Drop-in replacement for real adapters when you need to exercise
 * the issuer pipeline without hitting a vendor API. Configurable
 * decision per session id, so tests can drive specific branches
 * (approve, decline, in_review, pending, expired) without timing
 * dependencies.
 *
 * Webhook verification accepts any payload prefixed with the shared
 * `MOCK-SIG:` token — sufficient to pin happy-path wiring without
 * cryptography. Do not use in production.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type {
  KycDecision,
  KycEvidence,
  KycLevel,
  KycProvider,
  KycSession,
  KycWebhookEvent,
  StartSessionOptions,
} from '@canton-vc/kyc-provider';

export interface MockAdapterConfig {
  /**
   * Per-session-id decisions the mock will return on
   * `fetchDecision()`. Sessions not in this map default to
   * `defaultDecisionStatus`.
   */
  readonly decisions?: Readonly<Record<string, MockDecisionPlan>>;
  /**
   * Status returned for sessions not in the `decisions` map.
   * Defaults to `'approved'`.
   */
  readonly defaultDecisionStatus?: KycDecision['status'];
  /**
   * Override `vendorName` (defaults to `"Mock"`). Useful in tests
   * that assert which adapter is wired.
   */
  readonly vendorName?: string;
  /**
   * Override wall clock (defaults to `Date.now`).
   */
  readonly clock?: () => number;
}

export interface MockDecisionPlan {
  readonly status: KycDecision['status'];
  readonly level?: KycLevel;
  readonly evidence?: KycEvidence;
}

export class MockAdapter implements KycProvider {
  readonly vendorName: string;
  readonly #decisions: Readonly<Record<string, MockDecisionPlan>>;
  readonly #defaultDecisionStatus: KycDecision['status'];
  readonly #clock: () => number;
  readonly #userRefBySession = new Map<string, string>();

  constructor(config: MockAdapterConfig = {}) {
    this.vendorName = config.vendorName ?? 'Mock';
    this.#decisions = config.decisions ?? {};
    this.#defaultDecisionStatus = config.defaultDecisionStatus ?? 'approved';
    this.#clock = config.clock ?? Date.now;
  }

  /** {@inheritDoc KycProvider.startSession} */
  async startSession(options: StartSessionOptions): Promise<KycSession> {
    if (typeof options.userRef !== 'string' || options.userRef.length === 0) {
      throw new Error('MockAdapter.startSession: userRef is required.');
    }
    const sessionId = `mock_${createHash('sha256')
      .update(`${options.userRef}-${this.#clock()}`)
      .digest('hex')
      .slice(0, 16)}`;
    this.#userRefBySession.set(sessionId, options.userRef);
    return Object.freeze({
      sessionId,
      redirectUrl: `https://mock.canton-vc.local/widget/${sessionId}`,
      expiresAt: new Date(this.#clock() + 60 * 60 * 1000).toISOString(),
    });
  }

  /** {@inheritDoc KycProvider.fetchDecision} */
  async fetchDecision(sessionId: string): Promise<KycDecision> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('MockAdapter.fetchDecision: sessionId is required.');
    }
    const plan = this.#decisions[sessionId] ?? { status: this.#defaultDecisionStatus };
    const userRef = this.#userRefBySession.get(sessionId) ?? '';

    const evidence: KycEvidence =
      plan.evidence ??
      (plan.status === 'approved'
        ? {
            identityVerified: true,
            livenessVerified: true,
            addressVerified: plan.level === 'enhanced',
            humanScore: 0.95,
          }
        : {
            identityVerified: false,
            livenessVerified: false,
            addressVerified: false,
          });

    const proofHash = createHash('sha256')
      .update(`${sessionId}|${plan.status}|${plan.level ?? ''}`)
      .digest('hex');
    // Synthetic schema id — mock adapter is for tests and local dev
    // only, so a deterministic placeholder is fine. Real adapters use
    // `@canton-vc/core#computeProofHash` to derive both fields together.
    const proofSchemaId = createHash('sha256').update('canton-vc/mock/v1').digest('hex');

    return Object.freeze({
      sessionId,
      userRef,
      status: plan.status,
      ...(plan.level !== undefined && { level: plan.level }),
      evidence,
      proofHash,
      proofSchemaId,
      expiresAt: new Date(this.#clock() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      raw: { mock: true, plan },
    });
  }

  /** {@inheritDoc KycProvider.verifyWebhook} */
  async verifyWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<KycWebhookEvent | null> {
    const signature = headers['x-mock-signature'];
    const sig = Array.isArray(signature) ? signature[0] : signature;
    if (typeof sig !== 'string' || !sig.startsWith('MOCK-SIG:')) {
      return null;
    }
    let body: { sessionId?: string; status?: KycDecision['status']; userRef?: string };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
      return null;
    }
    if (body.status === 'expired') {
      return Object.freeze({
        type: 'session.expired',
        sessionId: body.sessionId,
        userRef: body.userRef ?? '',
      });
    }
    const decision = await this.fetchDecision(body.sessionId);
    return Object.freeze({ type: 'decision', decision });
  }
}
