/**
 * Définition des colonnes de la vue Marché.
 *
 * SOURCE UNIQUE, partagée par le tableau desktop, les cartes mobiles et le
 * sélecteur. Les trois divergeaient sinon dès la première colonne ajoutée.
 *
 * Les largeurs sont des NOMBRES et non des classes Tailwind, pour deux raisons
 * qui se rejoignent : la largeur minimale du tableau est leur somme, et cette
 * somme change quand l'utilisateur masque des colonnes. Une classe `w-[92px]`
 * ne se somme pas.
 */

export const COLUMN_KEYS = [
  "pool",
  "heat",
  "rate",
  "volumeRate",
  "spark",
  "accel",
  "tvl",
  "mcap",
  "volume",
  "fees",
  "fee",
  "price",
  "age",
  "safety",
  "links",
] as const;

export type ColumnKey = (typeof COLUMN_KEYS)[number];

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  /** Largeur en pixels, padding compris (`box-sizing: border-box`). */
  width: number;
  align: "left" | "right";
  sortable?: boolean;
  /** Une colonne sans laquelle la ligne ne veut plus rien dire. */
  locked?: boolean;
  /** Libellé court pour les cartes mobiles, où la place manque. */
  short?: string;
}

export const COLUMNS: readonly ColumnDef[] = [
  { key: "pool", label: "Pool", width: 190, align: "left", locked: true },
  { key: "heat", label: "Heat %/h", width: 92, align: "right", sortable: true, short: "heat" },
  { key: "rate", label: "Fees/min", width: 78, align: "right", sortable: true, short: "fees/min" },
  { key: "volumeRate", label: "Vol tok/min", width: 88, align: "right", sortable: true, short: "vol tok/min" },
  { key: "spark", label: "Tendance", width: 72, align: "left", short: "tendance" },
  { key: "accel", label: "Accél.", width: 76, align: "right", sortable: true, short: "accél." },
  { key: "tvl", label: "TVL", width: 74, align: "right", sortable: true, short: "TVL" },
  { key: "mcap", label: "MCap", width: 78, align: "right", sortable: true, short: "MCAP" },
  { key: "volume", label: "Vol 30m", width: 74, align: "right", sortable: true, short: "vol 30m" },
  { key: "fees", label: "Fees 30m", width: 74, align: "right", short: "fees 30m" },
  { key: "fee", label: "Frais", width: 74, align: "right", short: "frais" },
  { key: "price", label: "Prix", width: 84, align: "right", short: "prix" },
  { key: "age", label: "Âge", width: 56, align: "right", sortable: true, short: "âge" },
  { key: "safety", label: "Sécu", width: 64, align: "left", short: "sécu" },
  { key: "links", label: "Liens", width: 86, align: "left", short: "liens" },
];

const ALL = new Set<ColumnKey>(COLUMN_KEYS);

/**
 * Jeu par défaut sur téléphone : exactement ce que la carte montrait avant
 * d'être configurable.
 *
 * Un défaut distinct n'est pas un caprice. Le stockage étant local à
 * l'appareil, hériter du jeu desktop ferait apparaître quatre métriques de plus
 * sur une carte déjà dense, et l'utilisateur découvrirait la fonctionnalité par
 * une régression.
 */
const MOBILE_DEFAULT: ColumnKey[] = [
  "pool",
  "heat",
  "rate",
  "volumeRate",
  "spark",
  "tvl",
  "mcap",
  "fee",
  "age",
  "safety",
  "links",
];

export function defaultColumns(coarsePointer: boolean): Set<ColumnKey> {
  return coarsePointer ? new Set(MOBILE_DEFAULT) : new Set(ALL);
}

/**
 * Relit une sélection stockée.
 *
 * Tolérante par construction : une clé inconnue (colonne supprimée depuis) est
 * ignorée, et les colonnes verrouillées sont réinjectées. Une sélection vide ou
 * illisible retombe sur le défaut plutôt que d'afficher un tableau sans
 * colonnes.
 */
export function parseColumns(raw: string | null, coarsePointer: boolean): Set<ColumnKey> {
  if (!raw) return defaultColumns(coarsePointer);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultColumns(coarsePointer);
  }
  if (!Array.isArray(parsed)) return defaultColumns(coarsePointer);
  const kept = new Set<ColumnKey>(
    parsed.filter((k): k is ColumnKey => typeof k === "string" && ALL.has(k as ColumnKey)),
  );
  for (const c of COLUMNS) if (c.locked) kept.add(c.key);
  // Une seule colonne verrouillée restante = l'utilisateur a tout décoché, ou
  // les données sont corrompues. Dans les deux cas le tableau serait inutile.
  return kept.size <= COLUMNS.filter((c) => c.locked).length ? defaultColumns(coarsePointer) : kept;
}

export function serializeColumns(visible: ReadonlySet<ColumnKey>): string {
  return JSON.stringify(COLUMN_KEYS.filter((k) => visible.has(k)));
}

/** Largeur minimale du tableau : la somme des colonnes réellement affichées. */
export function tableMinWidth(visible: ReadonlySet<ColumnKey>): number {
  return COLUMNS.reduce((sum, c) => (visible.has(c.key) ? sum + c.width : sum), 0);
}

export const STORAGE_KEY = "radar.columns";
