import type { CredentialView } from '@canton-vc/core';

interface CredentialViewCardProps {
  readonly view: CredentialView;
  readonly title?: string;
}

function trunc(s: string, head = 12, tail = 6): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function CredentialViewCard({ view, title = 'CredentialView' }: CredentialViewCardProps) {
  return (
    <div className="view-card">
      <header className="view-card__header">
        <h3 className="view-card__title">{title}</h3>
        <span
          className={`view-card__pill view-card__pill--${view.isActive ? 'active' : 'inactive'}`}
        >
          isActive: {String(view.isActive)}
        </span>
      </header>

      <dl className="view-card__grid">
        <dt>userRef</dt>
        <dd>
          <code>{view.userRef}</code>
        </dd>

        <dt>status</dt>
        <dd>{view.status}</dd>

        <dt>level</dt>
        <dd>{view.level}</dd>

        <dt>validator</dt>
        <dd>{view.validator}</dd>

        <dt>identityVerified</dt>
        <dd>{String(view.identityVerified)}</dd>

        <dt>livenessVerified</dt>
        <dd>{String(view.livenessVerified)}</dd>

        <dt>addressVerified</dt>
        <dd>{String(view.addressVerified)}</dd>

        <dt>humanScore</dt>
        <dd>{view.humanScore}</dd>

        <dt>network</dt>
        <dd>{view.network}</dd>

        <dt>validUntil</dt>
        <dd>
          <code>{view.validUntil}</code>
        </dd>

        <dt>proofHash</dt>
        <dd>
          <code>{trunc(view.proofHash, 16, 8)}</code>
        </dd>

        <dt>proofSchemaId</dt>
        <dd>
          <code>{view.proofSchemaId === null ? 'null' : trunc(view.proofSchemaId, 16, 8)}</code>
        </dd>
      </dl>
    </div>
  );
}
