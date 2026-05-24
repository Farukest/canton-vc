import { useState } from 'react';

import { VendorSelect } from './components/VendorSelect.js';
import type { SimulatedVendor } from './lib/mock-provider.js';
import { IssuePanel, type MintInfo } from './panels/IssuePanel.js';
import { NftCascadePanel } from './panels/NftCascadePanel.js';
import { VerifyPanel } from './panels/VerifyPanel.js';

const INITIAL_VENDOR: SimulatedVendor = (() => {
  const env = import.meta.env['VITE_CANTON_VC_VENDOR'];
  if (env === 'didit' || env === 'sumsub' || env === 'persona' || env === 'mock') {
    return env;
  }
  return 'mock';
})();

export function App() {
  const [vendor, setVendor] = useState<SimulatedVendor>(INITIAL_VENDOR);
  const [lastMinted, setLastMinted] = useState<MintInfo | null>(null);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">canton-vc verifier demo</h1>
        <p className="app__sub">
          Browser SPA exercising the canton-vc SDK against an in-memory mock — no Canton
          participant, no credentials. Drives <code>verifyDisclosure()</code> end-to-end.
        </p>
        <VendorSelect value={vendor} onChange={setVendor} />
      </header>

      <main className="app__main">
        <IssuePanel vendor={vendor} onMinted={setLastMinted} />
        <VerifyPanel autoFill={lastMinted} />
        <NftCascadePanel />
      </main>

      <footer className="app__footer">
        <p>
          KYC vendor calls: <strong>mock</strong> (in-browser) by default, or any of the three
          production sandboxes via <code>.env</code> + the dev-server vendor proxy. Canton: always
          mocked in-memory. For real Canton participant mint round-trips, see{' '}
          <code>scripts/live-*.ts</code> at the repo root.
        </p>
      </footer>
    </div>
  );
}
