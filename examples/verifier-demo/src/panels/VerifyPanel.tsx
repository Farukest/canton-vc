import { useState } from 'react';

import type { ContractId, CredentialView, PartyId } from '@canton-vc/core';
import { verifyDisclosure } from '@canton-vc/credential';

import { asCantonClient, getMockCanton } from '../lib/mock-canton.js';
import { CredentialViewCard } from '../components/CredentialViewCard.js';

import type { MintInfo } from './IssuePanel.js';

interface VerifyPanelProps {
  readonly autoFill: MintInfo | null;
}

export function VerifyPanel({ autoFill }: VerifyPanelProps) {
  const [contractId, setContractId] = useState<string>('');
  const [blob, setBlob] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<CredentialView | null>(null);

  // Whenever IssuePanel mints, the parent hands us a fresh MintInfo —
  // auto-populate the inputs so the reviewer can click Verify directly.
  if (autoFill !== null && (contractId === '' || blob === '')) {
    setContractId(autoFill.contractId);
    setBlob(autoFill.blobBase64);
  }

  async function run() {
    setRunning(true);
    setError(null);
    setView(null);
    try {
      const canton = getMockCanton();
      const fetcher = (await canton.allocateParty('VerifierFirm')) as PartyId;
      const result = await verifyDisclosure(
        {
          canton_vc_credential_blob: blob,
          canton_vc_contract_id: contractId as ContractId,
        },
        { canton: asCantonClient(canton), fetcher },
      );
      setView(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">2. Verify disclosure</h2>
        <p className="panel__sub">
          Call <code>verifyDisclosure()</code> with the OAuth-userinfo claims. The mock canton
          re-derives the <code>CredentialView</code> from on-chain state — the same call site a
          firm holds against its own participant.
        </p>
      </header>

      <div className="panel__form">
        <label className="field">
          <span className="field__label">canton_vc_contract_id</span>
          <input
            className="field__input field__input--mono"
            type="text"
            value={contractId}
            onChange={(e) => {
              setContractId(e.target.value);
            }}
            placeholder="hex contract id"
          />
        </label>
        <label className="field">
          <span className="field__label">canton_vc_credential_blob</span>
          <textarea
            className="field__textarea field__input--mono"
            rows={3}
            value={blob}
            onChange={(e) => {
              setBlob(e.target.value);
            }}
            placeholder="base64-encoded disclosure blob"
          />
        </label>
        <button
          className="button button--primary"
          type="button"
          onClick={run}
          disabled={running || contractId === '' || blob === ''}
        >
          {running ? 'Verifying…' : 'Verify disclosure'}
        </button>
      </div>

      {error !== null ? <div className="panel__error">Error: {error}</div> : null}

      {view !== null ? <CredentialViewCard view={view} title="Verified CredentialView" /> : null}
    </section>
  );
}
