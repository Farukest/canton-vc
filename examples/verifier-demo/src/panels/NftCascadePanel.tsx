import type {
  Claims,
  ContractId,
  CreateCredentialInput,
  CredentialView,
  PartyId,
} from '@canton-vc/core';
import { verifyDisclosure } from '@canton-vc/credential';
import { useState } from 'react';
import { CredentialViewCard } from '../components/CredentialViewCard.js';
import { asCantonClient, getMockCanton } from '../lib/mock-canton.js';
import { BrowserMockProvider } from '../lib/mock-provider.js';

interface PanelState {
  readonly credentialId: ContractId;
  readonly nftId: ContractId;
  readonly viewBefore: CredentialView;
  readonly viewAfter: CredentialView | null;
}

const DEMO_NS = 'com.example';

const SVG_PLACEHOLDER =
  'data:image/svg+xml;base64,' +
  globalThis.btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="8" fill="#1f2937"/>' +
      '<text x="32" y="38" text-anchor="middle" fill="#fff" font-size="10">canton-vc</text>' +
      '</svg>',
  );

export function NftCascadePanel() {
  const [state, setState] = useState<PanelState | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mint() {
    setRunning(true);
    setError(null);
    setState(null);
    try {
      const provider = new BrowserMockProvider('mock');
      const canton = getMockCanton();

      // 1. Mint an enhanced credential (NFT-eligible at the chain boundary).
      const userRef = `nft-${Date.now().toString(36)}`;
      const session = await provider.startSession({ userRef, workflow: 'identity' });
      const decision = await provider.fetchDecision(session.sessionId);
      const issuerParty = await canton.allocateParty(`NftIssuer${Date.now().toString(36)}`);
      const holderParty = await canton.allocateParty(`NftHolder${Date.now().toString(36)}`);
      const expiresAt = decision.expiresAt.replace(/\.\d+Z$/, 'Z');
      const claims: Claims = {
        values: {
          [`${DEMO_NS}/userRef`]: decision.userRef,
          [`${DEMO_NS}/proofHash`]: decision.proofHash,
          [`${DEMO_NS}/proofSchemaId`]: decision.proofSchemaId,
          [`${DEMO_NS}/level`]: 'Enhanced',
          [`${DEMO_NS}/status`]: 'Active',
          [`${DEMO_NS}/humanScore`]: '95',
          [`${DEMO_NS}/validator`]: 'GenericValidator',
          [`${DEMO_NS}/identityVerified`]: 'true',
          [`${DEMO_NS}/livenessVerified`]: 'true',
          [`${DEMO_NS}/addressVerified`]: 'true',
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
      const credMint = await canton.createCredential(input);

      // 2. Mint the soulbound KycNFT bound to the credential.
      const nftMint = await canton.createKycNft({
        holderParty,
        boundCredentialId: credMint.contractId,
        level: 'Enhanced',
        serialNumber: `serial-${Date.now().toString(36)}`,
        displayName: `canton-vc demo NFT (${userRef})`,
        image: SVG_PLACEHOLDER,
      });

      // 3. Verify the credential to read its current view.
      const actor = (await canton.allocateParty('VerifierFirm')) as PartyId;
      const blob = canton.getBlob(credMint.contractId) ?? '';
      const viewBefore = await verifyDisclosure(
        {
          canton_vc_credential_blob: blob,
          canton_vc_contract_id: credMint.contractId,
        },
        { canton: asCantonClient(canton), actor, expectedAdmin: issuerParty },
      );

      setState({
        credentialId: credMint.contractId,
        nftId: nftMint.contractId,
        viewBefore,
        viewAfter: null,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function revoke() {
    if (state === null) return;
    setRunning(true);
    setError(null);
    try {
      const canton = getMockCanton();

      // Revoke the credential — passes nftContractId so the Daml choice
      // body archives both atomically (cascade burn).
      await canton.revokeCredential({
        contractId: state.credentialId,
        nftContractId: state.nftId,
        reason: 'compliance-policy',
      });

      const actor = (await canton.allocateParty('VerifierFirm')) as PartyId;
      const blob = canton.getBlob(state.credentialId) ?? '';
      const expectedAdmin = state.viewBefore.admin;
      const viewAfter = await verifyDisclosure(
        {
          canton_vc_credential_blob: blob,
          canton_vc_contract_id: state.credentialId,
        },
        { canton: asCantonClient(canton), actor, expectedAdmin },
      );

      setState({ ...state, viewAfter });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">3. KycNFT cascade revoke</h2>
        <p className="panel__sub">
          Mint an Enhanced credential + soulbound <code>KycNFT</code> companion. Revoke the
          credential and watch the Daml choice body cascade-archive both contracts atomically.
        </p>
      </header>

      <div className="panel__form">
        <button
          className="button button--primary"
          type="button"
          onClick={mint}
          disabled={running}
        >
          {running && state === null ? 'Minting…' : 'Mint Enhanced credential + NFT'}
        </button>
        <button
          className="button"
          type="button"
          onClick={revoke}
          disabled={running || state === null || state.viewAfter !== null}
        >
          {running && state !== null ? 'Revoking…' : 'Revoke (cascade-archive both)'}
        </button>
      </div>

      {error !== null ? <div className="panel__error">Error: {error}</div> : null}

      {state !== null ? (
        <div className="panel__result">
          <dl className="kv">
            <dt>credentialId</dt>
            <dd>
              <code>{state.credentialId}</code>
            </dd>
            <dt>nftId</dt>
            <dd>
              <code>{state.nftId}</code>
            </dd>
          </dl>
          <CredentialViewCard view={state.viewBefore} title="Before revoke" />
          {state.viewAfter !== null ? (
            <CredentialViewCard view={state.viewAfter} title="After revoke (cascade)" />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
