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

export const GAME_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'pokemon', label: 'Pokémon', color: 'var(--c-pokemon)' },
  { value: 'mtg', label: 'Magic', color: 'var(--c-mtg)' },
  { value: 'yugioh', label: 'Yu-Gi-Oh!', color: 'var(--c-yugioh)' },
  { value: 'sports', label: 'Sports', color: 'var(--c-sports)' },
];
