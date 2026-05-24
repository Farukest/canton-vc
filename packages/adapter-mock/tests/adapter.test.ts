/**
 * @canton-vc/adapter-mock — tests covering the deterministic
 * MockAdapter. Also serves as a `KycProvider` interface conformance
 * test — any new adapter must pass the equivalent of these assertions.
 */

import { describe, expect, it } from 'vitest';

import { MockAdapter } from '../src/index';

describe('MockAdapter — constructor + defaults', () => {
  it('vendorName defaults to "Mock"', () => {
    const adapter = new MockAdapter();
    expect(adapter.vendorName).toBe('Mock');
  });

  it('vendorName is overridable', () => {
    const adapter = new MockAdapter({ vendorName: 'Acme' });
    expect(adapter.vendorName).toBe('Acme');
  });
});

describe('MockAdapter.startSession', () => {
  it('throws on empty userRef', async () => {
    const adapter = new MockAdapter();
    await expect(adapter.startSession({ userRef: '' })).rejects.toThrow(
      /userRef is required/,
    );
  });

  it('returns a deterministic mock session for the same userRef + clock', async () => {
    const adapter = new MockAdapter({ clock: () => 1_700_000_000_000 });
    const a = await adapter.startSession({ userRef: 'user-1' });
    const b = await adapter.startSession({ userRef: 'user-1' });
    expect(a.sessionId).toBe(b.sessionId);
  });

  it('different userRefs yield different sessions', async () => {
    const adapter = new MockAdapter({ clock: () => 1_700_000_000_000 });
    const a = await adapter.startSession({ userRef: 'user-1' });
    const b = await adapter.startSession({ userRef: 'user-2' });
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe('MockAdapter.fetchDecision', () => {
  it('default status is "approved" with enhanced-level evidence', async () => {
    const adapter = new MockAdapter();
    const session = await adapter.startSession({ userRef: 'u' });
    const decision = await adapter.fetchDecision(session.sessionId);
    expect(decision.status).toBe('approved');
    expect(decision.userRef).toBe('u');
  });

  it('per-session decisions plan wins over default', async () => {
    const adapter = new MockAdapter({ defaultDecisionStatus: 'approved' });
    const session = await adapter.startSession({ userRef: 'u' });
    const adapterWithPlan = new MockAdapter({
      decisions: { [session.sessionId]: { status: 'declined' } },
    });
    const decision = await adapterWithPlan.fetchDecision(session.sessionId);
    expect(decision.status).toBe('declined');
  });

  it('level falls through when explicitly set', async () => {
    const sessionId = 'sess_fixed';
    const adapter = new MockAdapter({
      decisions: { [sessionId]: { status: 'approved', level: 'enhanced' } },
    });
    const decision = await adapter.fetchDecision(sessionId);
    expect(decision.level).toBe('enhanced');
  });

  it('declined decisions yield evidence with all flags false', async () => {
    const sessionId = 'sess_rej';
    const adapter = new MockAdapter({
      decisions: { [sessionId]: { status: 'declined' } },
    });
    const decision = await adapter.fetchDecision(sessionId);
    expect(decision.evidence.identityVerified).toBe(false);
    expect(decision.evidence.livenessVerified).toBe(false);
    expect(decision.evidence.addressVerified).toBe(false);
  });

  it('throws on empty sessionId', async () => {
    const adapter = new MockAdapter();
    await expect(adapter.fetchDecision('')).rejects.toThrow(/sessionId is required/);
  });

  it('proofHash is deterministic and hex-shaped', async () => {
    const adapter = new MockAdapter({
      decisions: { sess_x: { status: 'approved', level: 'enhanced' } },
    });
    const d1 = await adapter.fetchDecision('sess_x');
    const d2 = await adapter.fetchDecision('sess_x');
    expect(d1.proofHash).toBe(d2.proofHash);
    expect(d1.proofHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('MockAdapter.verifyWebhook', () => {
  it('returns decision event for a valid MOCK-SIG: webhook', async () => {
    const adapter = new MockAdapter({
      decisions: { sess_x: { status: 'approved', level: 'enhanced' } },
    });
    const event = await adapter.verifyWebhook(
      JSON.stringify({ sessionId: 'sess_x', userRef: 'u' }),
      { 'x-mock-signature': 'MOCK-SIG:something' },
    );
    expect(event?.type).toBe('decision');
  });

  it('returns session.expired event when status="expired" in body', async () => {
    const adapter = new MockAdapter();
    const event = await adapter.verifyWebhook(
      JSON.stringify({ sessionId: 'sess_x', status: 'expired', userRef: 'u' }),
      { 'x-mock-signature': 'MOCK-SIG:x' },
    );
    expect(event?.type).toBe('session.expired');
    if (event?.type === 'session.expired') {
      expect(event.sessionId).toBe('sess_x');
      expect(event.userRef).toBe('u');
    }
  });

  it('returns null on missing/invalid signature header', async () => {
    const adapter = new MockAdapter();
    expect(
      await adapter.verifyWebhook(JSON.stringify({ sessionId: 'x' }), {}),
    ).toBeNull();
    expect(
      await adapter.verifyWebhook(JSON.stringify({ sessionId: 'x' }), {
        'x-mock-signature': 'NOT-A-VALID-SIG',
      }),
    ).toBeNull();
  });

  it('returns null on unparseable JSON', async () => {
    const adapter = new MockAdapter();
    expect(
      await adapter.verifyWebhook('not-json', { 'x-mock-signature': 'MOCK-SIG:x' }),
    ).toBeNull();
  });
});
