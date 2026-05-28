import type { CredentialView } from '@canton-vc/core';
import { getClaim, isWithinValidityWindow } from '@canton-vc/core';

interface CredentialViewCardProps {
  readonly view: CredentialView;
  readonly title?: string;
  /**
   * Application-defined reverse-DNS namespace prefix for the demo
   * claim keys (e.g. `com.example`). Defaults to `com.example`,
   * matching the issuer-demo and verifier-demo fixtures.
   */
  readonly claimNamespace?: string;
}

function trunc(s: string, head = 12, tail = 6): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function CredentialViewCard({
  view,
  title = 'CredentialView',
  claimNamespace = 'com.example',
}: CredentialViewCardProps) {
  const ns = claimNamespace;
  const userRef = getClaim(view.claims, `${ns}/userRef`);
  const status = getClaim(view.claims, `${ns}/status`);
  const level = getClaim(view.claims, `${ns}/level`);
  const validator = getClaim(view.claims, `${ns}/validator`);
  const identityVerified = getClaim(view.claims, `${ns}/identityVerified`);
  const livenessVerified = getClaim(view.claims, `${ns}/livenessVerified`);
  const addressVerified = getClaim(view.claims, `${ns}/addressVerified`);
  const humanScore = getClaim(view.claims, `${ns}/humanScore`);
  const network = getClaim(view.claims, `${ns}/network`);
  const proofHash = getClaim(view.claims, `${ns}/proofHash`);
  const proofSchemaId = getClaim(view.claims, `${ns}/proofSchemaId`);
  const inWindow = isWithinValidityWindow(view);
  const isActive = inWindow && status !== 'Revoked';

  return (
    <div className="view-card">
      <header className="view-card__header">
        <h3 className="view-card__title">{title}</h3>
        <span
          className={`view-card__pill view-card__pill--${isActive ? 'active' : 'inactive'}`}
        >
          isActive: {String(isActive)}
        </span>
      </header>

      <dl className="view-card__grid">
        <dt>issuer</dt>
        <dd>
          <code>{trunc(view.issuer, 16, 8)}</code>
        </dd>

        <dt>holder</dt>
        <dd>
          <code>{trunc(view.holder, 16, 8)}</code>
        </dd>

        <dt>admin</dt>
        <dd>
          <code>{trunc(view.admin, 16, 8)}</code>
        </dd>

        <dt>userRef</dt>
        <dd>
          <code>{userRef ?? '—'}</code>
        </dd>

        <dt>status</dt>
        <dd>{status ?? '—'}</dd>

        <dt>level</dt>
        <dd>{level ?? '—'}</dd>

        <dt>validator</dt>
        <dd>{validator ?? '—'}</dd>

        <dt>identityVerified</dt>
        <dd>{identityVerified ?? '—'}</dd>

        <dt>livenessVerified</dt>
        <dd>{livenessVerified ?? '—'}</dd>

        <dt>addressVerified</dt>
        <dd>{addressVerified ?? '—'}</dd>

        <dt>humanScore</dt>
        <dd>{humanScore ?? '—'}</dd>

        <dt>network</dt>
        <dd>{network ?? '—'}</dd>

        <dt>expiresAt</dt>
        <dd>
          <code>{view.expiresAt ?? 'null'}</code>
        </dd>

        <dt>proofHash</dt>
        <dd>
          <code>{proofHash !== undefined ? trunc(proofHash, 16, 8) : '—'}</code>
        </dd>

        <dt>proofSchemaId</dt>
        <dd>
          <code>{proofSchemaId !== undefined ? trunc(proofSchemaId, 16, 8) : '—'}</code>
        </dd>
      </dl>
    </div>
  );
}
