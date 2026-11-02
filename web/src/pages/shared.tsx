import type { ComponentChildren } from 'preact';

export function Header({ title, children, actions, demo }: { title: string; children?: ComponentChildren; actions?: ComponentChildren; demo?: boolean }) {
  return (
    <header class="head">
      <div>
        <h1>{title}</h1>
        {(children || demo) && (
          <div class="sub">
            {demo && <span class="sample-pill" title="Started with COMPS_DEMO=1. Prices and listings are generated.">Sample data</span>}
            {children}
          </div>
        )}
      </div>
      {actions && <div class="head-actions">{actions}</div>}
    </header>
  );
}

export const SERIES_OPTIONS = [
  { value: 'all', label: 'All eras' },
  { value: 'Mega Evolution', label: 'Mega Evolution' },
  { value: 'Scarlet & Violet', label: 'Scarlet & Violet' },
  { value: 'Sword & Shield', label: 'Sword & Shield' },
  { value: 'Sun & Moon', label: 'Sun & Moon' },
  { value: 'XY', label: 'XY' },
  { value: 'Black & White', label: 'Black & White' },
  { value: 'HeartGold & SoulSilver', label: 'HGSS' },
  { value: 'Diamond & Pearl', label: 'Diamond & Pearl' },
  { value: 'EX', label: 'EX' },
  { value: 'e-Card', label: 'e-Card' },
  { value: 'Neo', label: 'Neo' },
  { value: 'Wizards of the Coast', label: 'WotC' },
];

export const RARITY_OPTIONS = [
  { value: '', label: 'Any rarity' },
  { value: 'sir', label: 'Special Illustration Rare' },
  { value: 'ir', label: 'Illustration Rare' },
  { value: 'hyper', label: 'Hyper / Secret Rare' },
  { value: 'ultra', label: 'Ultra Rare & ex/V' },
  { value: 'holo', label: 'Holo Rare' },
];

/** Era chips + rarity menu, used by Deals and Raw to Graded. */
export function PokemonFilters({ series, rarity, onSeries, onRarity }: { series: string; rarity: string; onSeries: (v: string) => void; onRarity: (v: string) => void }) {
  return (
    <>
      <div class="chips scroll-chips" role="group" aria-label="Era">
        {SERIES_OPTIONS.map((o) => (
          <button type="button" class="chip" aria-pressed={o.value === series} onClick={() => onSeries(o.value)}>{o.label}</button>
        ))}
      </div>
      <select class="select" value={rarity} onChange={(e) => onRarity((e.target as HTMLSelectElement).value)} aria-label="Rarity">
        {RARITY_OPTIONS.map((o) => <option value={o.value}>{o.label}</option>)}
      </select>
    </>
  );
}
