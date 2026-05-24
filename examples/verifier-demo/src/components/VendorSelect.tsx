import type { SimulatedVendor } from '../lib/mock-provider.js';

interface VendorSelectProps {
  readonly value: SimulatedVendor;
  readonly onChange: (next: SimulatedVendor) => void;
}

const OPTIONS: ReadonlyArray<{
  readonly value: SimulatedVendor;
  readonly label: string;
}> = [
  { value: 'mock', label: 'Mock (no network)' },
  { value: 'didit', label: 'Didit sandbox (real API)' },
  { value: 'sumsub', label: 'Sumsub sandbox (real API)' },
  { value: 'persona', label: 'Persona sandbox (real API)' },
];

export function VendorSelect({ value, onChange }: VendorSelectProps) {
  return (
    <label className="vendor-select">
      <span className="vendor-select__label">Simulated vendor</span>
      <select
        className="vendor-select__input"
        value={value}
        onChange={(e) => {
          onChange(e.target.value as SimulatedVendor);
        }}
      >
        {OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
