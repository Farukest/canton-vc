/**
 * Interface conformance test for `KycProvider`.
 *
 * `@canton-vc/kyc-provider` is types-only — there is no runtime code
 * to exercise. The test below builds a minimal stub conforming to the
 * interface so any drift in the interface signature (added required
 * method, changed return type, etc.) shows up here at typecheck time
 * AND as a vitest run-time assertion.
 *
 * Adapter authors can copy the stub below as a starting point.
 */

import { describe, expect, it } from 'vitest';

import type {
  KycDecision,
  KycLevel,
  KycProvider,
  KycSession,
  KycWebhookEvent,
  StartSessionOptions,
} from '../src/index';

class StubProvider implements KycProvider {
  readonly vendorName = 'Stub';

  async startSession(options: StartSessionOptions): Promise<KycSession> {
    return Object.freeze({
      sessionId: `stub_${options.userRef}`,
      redirectUrl: 'https://stub.local/widget',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  async fetchDecision(sessionId: string): Promise<KycDecision> {
    const level: KycLevel = 'enhanced';
    return Object.freeze({
      sessionId,
      userRef: 'u',
      status: 'approved',
      level,
      evidence: {
        identityVerified: true,
        livenessVerified: true,
        addressVerified: true,
        humanScore: 0.99,
      },
      proofHash: 'a'.repeat(64),
      proofSchemaId: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  }

  async verifyWebhook(): Promise<KycWebhookEvent | null> {
    return null;
  }
}

describe('KycProvider — interface conformance', () => {
  const provider: KycProvider = new StubProvider();

  it('exposes vendorName', () => {
    expect(provider.vendorName).toBe('Stub');
  });

  it('startSession returns a frozen session record', async () => {
    const session = await provider.startSession({ userRef: 'u' });
    expect(session.sessionId).toBe('stub_u');
    expect(session.redirectUrl).toMatch(/^https?:\/\//);
    expect(() => {
      (session as { sessionId: string }).sessionId = 'mutated';
    }).toThrow();
  });

  it('fetchDecision returns a normalized KycDecision', async () => {
    const decision = await provider.fetchDecision('sess_1');
    expect(decision.status).toBe('approved');
    expect(decision.level).toBe('enhanced');
    expect(decision.proofHash).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.evidence.identityVerified).toBe(true);
  });

  it('verifyWebhook returns null when the implementation has no opinion', async () => {
    expect(await provider.verifyWebhook('{}', {})).toBeNull();
  });
});
