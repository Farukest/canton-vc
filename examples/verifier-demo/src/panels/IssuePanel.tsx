import { useState } from 'react';

import type { Claims, CreateCredentialInput } from '@canton-vc/core';
import type { KycDecision, KycProvider, KycSession } from '@canton-vc/kyc-provider';

import { getMockCanton } from '../lib/mock-canton.js';
import { BrowserMockProvider, type SimulatedVendor } from '../lib/mock-provider.js';
import { ProxyVendorProvider } from '../lib/proxy-provider.js';

interface IssuePanelProps {
  readonly vendor: SimulatedVendor;
  readonly onMinted: (mintInfo: MintInfo) => void;
}

export interface MintInfo {
  readonly contractId: string;
  readonly userRef: string;
  readonly blobBase64: string;
  readonly mintedAt: string;
}

/**
 * Demo namespace for claim keys. A real issuer would pick their own
 * reverse-DNS namespace (e.g. `io.acme/*`).
 */
const DEMO_NS = 'com.example';

const VENDOR_TO_VALIDATOR: Readonly<Record<SimulatedVendor, string>> = Object.freeze({
  mock: 'GenericValidator',
  didit: 'DiditValidator',
  sumsub: 'SumsubValidator',
  persona: 'PersonaValidator',
});

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 30 * 60 * 1000;

function buildProvider(vendor: SimulatedVendor): KycProvider {
  if (vendor === 'mock') {
    return new BrowserMockProvider('mock');
  }
  return new ProxyVendorProvider(vendor);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function IssuePanel({ vendor, onMinted }: IssuePanelProps) {
  const [userRef, setUserRef] = useState<string>(() => `demo-${Date.now().toString(36)}`);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<KycSession | null>(null);
  const [pollStatus, setPollStatus] = useState<string | null>(null);
  const [result, setResult] = useState<MintInfo | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    setSession(null);
    setPollStatus(null);
    try {
      const provider = buildProvider(vendor);
      const canton = getMockCanton();
      const isReal = vendor !== 'mock';

      // 1. startSession
      const sess = await provider.startSession({ userRef, workflow: 'identity' });
      setSession(sess);

      // 2. fetchDecision — instant for mock, polled for real vendor
      let decision: KycDecision;
      if (isReal) {
        decision = await pollUntilTerminal(provider, sess.sessionId, setPollStatus);
      } else {
        decision = await provider.fetchDecision(sess.sessionId);
      }

      if (decision.status === 'declined') {
        throw new Error(`Vendor declined: ${decision.declineReason ?? 'unspecified'}`);
      }
      if (decision.status === 'expired') {
        throw new Error('Vendor session expired before completion');
      }
      if (decision.status !== 'approved') {
        throw new Error(`Unexpected terminal status: ${decision.status}`);
      }

      // 3. allocate issuer + holder parties + createCredential against the
      //    in-memory mock canton. Joint signatory per CIP #204 — the mock
      //    accepts both parties under actAs.
      const issuerParty = await canton.allocateParty(`Issuer${Date.now().toString(36)}`);
      const holderParty = await canton.allocateParty(`Holder${Date.now().toString(36)}`);
      const expiresAt = decision.expiresAt.replace(/\.\d+Z$/, 'Z');
      const level = decision.level ?? 'basic';
      const claims: Claims = {
        values: {
          [`${DEMO_NS}/userRef`]: decision.userRef,
          [`${DEMO_NS}/proofHash`]: decision.proofHash,
          [`${DEMO_NS}/proofSchemaId`]: decision.proofSchemaId,
          [`${DEMO_NS}/level`]: level === 'enhanced' ? 'Enhanced' : 'Basic',
          [`${DEMO_NS}/status`]: 'Active',
          [`${DEMO_NS}/humanScore`]: '95',
          [`${DEMO_NS}/validator`]: VENDOR_TO_VALIDATOR[vendor],
          [`${DEMO_NS}/identityVerified`]: (decision.evidence.identityVerified ?? false) ? 'true' : 'false',
          [`${DEMO_NS}/livenessVerified`]: (decision.evidence.livenessVerified ?? false) ? 'true' : 'false',
          [`${DEMO_NS}/addressVerified`]: (decision.evidence.addressVerified ?? false) ? 'true' : 'false',
          [`${DEMO_NS}/network`]: 'mock',
        },
        validFrom: null,
        validUntil: expiresAt,
        meta: {},
      };
      const input: CreateCredentialInput = {
        issuerParty,
        holderParty,
        adminParty: issuerParty,
        claims,
        expiresAt,
        meta: {},
      };
      const mint = await canton.createCredential(input);
      const blob = canton.getBlob(mint.contractId) ?? '';

      const info: MintInfo = {
        contractId: mint.contractId,
        userRef: decision.userRef,
        blobBase64: blob,
        mintedAt: mint.recordTime,
      };
      setResult(info);
      onMinted(info);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setPollStatus(null);
    }
  }

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">1. Issue credential</h2>
        <p className="panel__sub">
          Run <code>startSession</code> → <code>fetchDecision</code> →{' '}
          <code>createCredential</code>. Mock vendor returns instantly; real vendor sandbox flows
          poll <code>fetchDecision</code> every 5s after you complete the hosted flow.
        </p>
      </header>

      <div className="panel__form">
        <label className="field">
          <span className="field__label">userRef</span>
          <input
            className="field__input"
            type="text"
            value={userRef}
            onChange={(e) => {
              setUserRef(e.target.value);
            }}
            placeholder="opaque firm-side identifier"
          />
        </label>
        <button className="button button--primary" type="button" onClick={run} disabled={running}>
          {running ? 'Issuing…' : 'Issue credential'}
        </button>
      </div>

      {session !== null && vendor !== 'mock' ? (
        <div className="panel__hint">
          <p>
            <strong>Open the vendor flow:</strong>{' '}
            <a href={session.redirectUrl} target="_blank" rel="noopener noreferrer">
              {session.redirectUrl}
            </a>
          </p>
          {pollStatus !== null ? (
            <p>
              Polling <code>fetchDecision</code> — last status: <code>{pollStatus}</code>
            </p>
          ) : null}
        </div>
      ) : null}

      {error !== null ? <div className="panel__error">Error: {error}</div> : null}

      {result !== null ? (
        <div className="panel__result">
          <h3 className="panel__result-title">Minted</h3>
          <dl className="kv">
            <dt>contractId</dt>
            <dd>
              <code>{result.contractId}</code>
            </dd>
            <dt>userRef</dt>
            <dd>
              <code>{result.userRef}</code>
            </dd>
            <dt>blob (base64, head)</dt>
            <dd>
              <code>{result.blobBase64.slice(0, 64)}…</code>
            </dd>
            <dt>mintedAt</dt>
            <dd>{result.mintedAt}</dd>
          </dl>
          <p className="panel__hint">
            ✓ Auto-loaded into the Verify panel below — click <em>Verify disclosure</em>.
          </p>
        </div>
      ) : null}
    </section>
  );
}

async function pollUntilTerminal(
  provider: KycProvider,
  sessionId: string,
  onStatus: (status: string) => void,
): Promise<KycDecision> {
  const started = Date.now();
  let decision = await provider.fetchDecision(sessionId);
  let last = '';
  while (decision.status === 'pending' || decision.status === 'in_review') {
    if (decision.status !== last) {
      onStatus(decision.status);
      last = decision.status;
    }
    if (Date.now() - started > MAX_POLL_MS) {
      throw new Error('Polling cap (30 minutes) hit. Aborting.');
    }
    await sleep(POLL_INTERVAL_MS);
    decision = await provider.fetchDecision(sessionId);
  }
  onStatus(decision.status);
  return decision;
}
