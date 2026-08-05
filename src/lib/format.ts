/**
 * Formatters for a dense table. Every one of these targets a fixed, narrow
 * column: values are abbreviated aggressively and precision shrinks as
 * magnitude grows, so a column never needs to widen for an outlier.
 */

const FR = "fr-FR";

/** $1.2k, $34.5M — compact money for table cells. */
export function fmtUsd(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs < 0.01) return "$0";
  if (abs < 1_000) return `$${abs.toFixed(abs < 10 ? digits : 0)}`;
  if (abs < 1_000_000) return `$${(v / 1_000).toFixed(digits)}k`;
  if (abs < 1_000_000_000) return `$${(v / 1_000_000).toFixed(digits)}M`;
  return `$${(v / 1_000_000_000).toFixed(digits)}B`;
}

/** Fee rate, the headline number — keeps cents while it still matters. */
export function fmtRate(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return "—";
  if (v < 1) return `$${v.toFixed(2)}`;
  if (v < 100) return `$${v.toFixed(1)}`;
  if (v < 10_000) return `$${Math.round(v)}`;
  return fmtUsd(v, 1);
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000) return `${Math.round(v).toLocaleString(FR)} %`;
  if (abs >= 100) return `${v.toFixed(0)} %`;
  if (abs >= 10) return `${v.toFixed(1)} %`;
  return `${v.toFixed(digits)} %`;
}

export function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString(FR);
}

/**
 * Price, which spans wildly different magnitudes: SOL trades near 72 while a
 * fresh memecoin pair sits at 1e-9. Sub-cent values switch to significant
 * digits so the cell stays informative without becoming a wall of zeros.
 */
export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000) return v.toLocaleString(FR, { maximumFractionDigits: 0 });
  if (abs >= 1) return v.toFixed(3);
  if (abs >= 0.001) return v.toFixed(5);
  return v.toPrecision(3);
}

/** Compact age: 42s, 8min, 3h12, 5j. */
export function fmtAge(createdAtMs: number, now = Date.now()): string {
  if (!createdAtMs || createdAtMs <= 0) return "—";
  const s = Math.max(0, Math.floor((now - createdAtMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rem = m % 60;
    return rem > 0 ? `${h}h${String(rem).padStart(2, "0")}` : `${h}h`;
  }
  return `${Math.floor(h / 24)}j`;
}

/** Milliseconds since an event, for freshness indicators. */
export function fmtSince(ts: number | null, now = Date.now()): string {
  if (!ts) return "jamais";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `il y a ${s}s`;
  return `il y a ${Math.round(s / 60)}min`;
}

/**
 * Chart axis tick. Over a day or less the time of day is what locates a point;
 * past that it is ambiguous — a 7-day axis reading `10:00, 04:00, 22:00` names
 * no day at all — so the date takes over.
 */
export function fmtAxisTime(ts: number, spanMs: number): string {
  const d = new Date(ts);
  if (spanMs > 24 * 3_600_000) {
    return d.toLocaleDateString(FR, { day: "2-digit", month: "2-digit" });
  }
  return d.toLocaleTimeString(FR, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Lit un montant saisi à la main dans un filtre.
 *
 * Trois retours distincts, et la distinction compte : `null` veut dire « pas de
 * filtre » (champ vide) tandis que `undefined` veut dire « saisie invalide » —
 * les deux ne doivent pas produire le même comportement, sinon une faute de
 * frappe désactiverait silencieusement le filtre.
 *
 * Accepte ce qu'on tape réellement : `5k`, `$50 000`, `1,5M`, `2.5K`, `1B`.
 * Le suffixe milliard sert au filtre Market Cap, où SOL dépasse $40 Md.
 */
export function parseAmount(input: string): number | null | undefined {
  const raw = input.trim();
  if (raw === "") return null;

  // Retire le symbole monétaire et les séparateurs de milliers (espaces fines
  // insécables comprises : c'est ce que produit un copier-coller depuis l'UI).
  const cleaned = raw
    .replace(/[$\s\u00a0\u202f]/g, "")
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(",", ".");

  const m = /^(\d+(?:\.\d+)?)([kKmMbB]?)$/.exec(cleaned);
  if (!m) return undefined;

  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const suffix = m[2]?.toLowerCase();
  const mult =
    suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return n * mult;
}

/** Rend un montant sous la forme compacte qu'on retape ensuite sans friction. */
export function fmtAmountInput(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "";
  if (v === 0) return "0";
  if (v >= 1_000_000_000 && v % 100_000_000 === 0) return `${v / 1_000_000_000}B`;
  if (v >= 1_000_000 && v % 100_000 === 0) return `${v / 1_000_000}M`;
  if (v >= 1_000 && v % 100 === 0) return `${v / 1_000}k`;
  return String(v);
}

/** Strips the quote suffix so the base token can be emphasised on its own. */
export function splitPairName(name: string): { base: string; quote: string } {
  const i = name.lastIndexOf("-");
  if (i <= 0) return { base: name, quote: "" };
  return { base: name.slice(0, i), quote: name.slice(i + 1) };
}
