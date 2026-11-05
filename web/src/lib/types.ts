export type Game = 'pokemon' | 'mtg' | 'yugioh' | 'sports' | 'other';

export type Grades = Partial<Record<'g7' | 'g8' | 'g9' | 'g95' | 'psa10' | 'bgs10' | 'cgc10' | 'sgc10', number>>;

export interface Card {
  id: string;
  game: Game;
  name: string;
  set: string | null;
  setCode: string | null;
  number: string | null;
  total: string | null;
  rarity: string | null;
  year: number | null;
  image: string | null;
  imageLarge: string | null;
  tags?: string[];
  variant?: string;
  price?: number | null;
  priceLow?: number | null;
  confidence?: number | null;
  change7d?: number | null;
  change30d?: number | null;
  grades?: Grades | null;
  volume?: number | null;
  spark?: number[];
  series?: string | null;
  setId?: string | null;
}

type DealKind = 'listing' | 'dip' | 'momentum' | 'ask' | 'xmarket';

export interface Deal {
  id: number;
  kind: DealKind;
  kindLabel: string;
  score: number;
  price: number;
  value: number;
  upside: number;
  discount: number;
  confidence: number;
  variant: string;
  variantLabel: string;
  card: Card;
  data: Record<string, any>;
  computedAt: number;
}

export interface Outcome { grade: string; p: number; value: number; net: number }
interface Rates { p10: number; p9: number; p8: number; pLow?: number; era?: string; custom?: boolean }

export interface Spread {
  card: Card;
  variant: string;
  variantLabel: string;
  raw: number;
  g9: number | null;
  psa10: number;
  multiple: number;
  cost: number;
  ev: number;
  profit: number;
  roi: number;
  breakEven: number | null;
  volume: number | null;
  era: string;
  custom: boolean;
  rates: Rates;
  outcomes: Outcome[];
  if10: number;
  if9: number;
}

interface Job { name: string; status: string; started_at: number; finished_at: number | null; items: number | null; message: string | null }

export interface Status {
  version: string;
  demo: boolean;
  providers: Record<string, { on: boolean; key?: boolean; cards?: number }>;
  fx: { eurUsd: number; source: string };
  counts: { cards: number; valued: number; deals: number; spreads: number; listings: number; holdings: number };
  running: string | null;
  jobs: Job[];
  lanUrls?: string[];
}

export interface Holding {
  id: string;
  cardId: string;
  game: Game;
  name: string;
  setName: string | null;
  number: string | null;
  image: string | null;
  imageUrl: string | null;
  variant: string | null;
  grader: string | null;
  grade: string | null;
  condition: string;
  quantity: number;
  costBasis: number | null;
  acquiredAt: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
  value: number | null;
  basis: string | null;
  total: number | null;
  change7d: number | null;
  variantResolved: string | null;
}

export interface CollectionSummary {
  value: number;
  cost: number | null;
  gain: number | null;
  gainPct: number | null;
  change7d: number;
  change7dPct: number | null;
  count: number;
  unique: number;
  byGame: Partial<Record<Game, number>>;
  movers: Holding[];
  history: [string, number][];
}

interface Source { source: string; label: string; currency: string; metrics: Record<string, number | null>; updatedAt: number; linked?: string; linkConfidence?: number }

export interface Grading {
  raw: number; cost: number; ev: number; profit: number; roi: number; breakEven: number | null; multiple: number; if10: number; if9: number;
  rates: Rates; outcomes: Outcome[];
}

export interface VariantDetail {
  variant: string;
  label: string;
  price: number | null;
  priceLow: number | null;
  confidence: number | null;
  change7d: number | null;
  change30d: number | null;
  grades: Grades | null;
  volume: number | null;
  sources: Source[];
  grading: Grading | null;
}

export interface Listing { itemId: string; variant: string; title: string; price: number; shipping: number | null; total: number; grader: string | null; grade: string | null; url: string; image: string | null; seller: string | null; feedback: number | null; fetchedAt: number }

export interface CardDetail {
  card: Card;
  ext: Record<string, any>;
  variants: VariantDetail[];
  history: Record<string, [string, number | null, number | null, number | null][]>;
  rates: Rates & { era: string; custom: boolean };
  costs: Costs;
  fx: number;
  signals: Deal[];
  listings: Listing[];
  holdings: Holding[];
  watch: { variant: string; target: number | null }[];
  links: Record<string, string | null>;
  set?: { id: string; name: string; series: string; released?: string | null } | null;
}

export interface Costs { fee: number; shipping: number; sellFeePct: number; sellFixed: number }
