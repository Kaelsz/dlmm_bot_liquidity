import { rangeCursor } from "@/data/positions";
import { fmtPrice } from "@/lib/format";

/**
 * Où en est le prix à l'intérieur de la plage d'une position.
 *
 * Remplace le « dans la plage / hors plage » binaire, qui disait la même chose
 * d'une position confortablement au centre et d'une position à un bin de cesser
 * de percevoir des fees.
 *
 * SVG fait main, dans l'idiome de <Sparkline> : une poignée de formes, aucun
 * état, aucune mesure de mise en page, aucune dépendance.
 *
 * L'axe est linéaire en **identifiants de bin** — la liquidité est répartie bin
 * par bin, et c'est aussi la représentation de l'interface Meteora. Le prix,
 * lui, est géométrique : un axe linéaire en prix décalerait le curseur. Les
 * étiquettes de l'infobulle sont en revanche des prix, puisque c'est en prix
 * qu'on raisonne.
 */
export function RangeBar({
  lowerBinId,
  upperBinId,
  activeBinId,
  lowerPrice,
  upperPrice,
  currentPrice,
  width = 104,
  height = 14,
}: {
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  lowerPrice: number;
  upperPrice: number;
  currentPrice: number;
  width?: number;
  height?: number;
}) {
  const { ratio, outside, nearEdge } = rangeCursor(lowerBinId, upperBinId, activeBinId);

  // Marge latérale : le chevron de sortie se dessine en dehors du rail, il lui
  // faut la place, sinon il serait rogné par la boîte du SVG.
  const pad = 6;
  const x0 = pad;
  const x1 = width - pad;
  const cx = x0 + ratio * (x1 - x0);

  const color = outside || nearEdge ? "var(--color-warn)" : "var(--color-up)";
  const railY = (height - 6) / 2;

  return (
    <span title={tooltip({ lowerPrice, upperPrice, currentPrice, ratio, outside, nearEdge })}>
      <svg width={width} height={height} className="block" role="img" aria-label={label(outside, nearEdge)}>
        {/* Le rail = la plage entière. Teinté de la couleur d'état, mais très
            légèrement : à pleine opacité le rail devient un pavé de couleur qui
            pèse plus que toute la ligne du tableau, alors qu'il n'est qu'un
            décor. C'est le curseur qui porte le signal. */}
        <rect x={x0} y={railY} width={x1 - x0} height={6} rx={3} fill="var(--color-line)" />
        <rect x={x0} y={railY} width={x1 - x0} height={6} rx={3} fill={color} opacity={0.14} />

        {/* Bornes marquées : sans elles, un curseur collé au bord se confond
            avec un curseur sorti. */}
        <line x1={x0} y1={railY - 2} x2={x0} y2={railY + 8} stroke="var(--color-line-strong)" strokeWidth={1} />
        <line x1={x1} y1={railY - 2} x2={x1} y2={railY + 8} stroke="var(--color-line-strong)" strokeWidth={1} />

        <rect x={cx - 1} y={1} width={2} height={height - 2} rx={1} fill={color} />

        {/* Hors plage : le curseur est plaqué sur le bord franchi et ne dit plus
            de quel côté le prix est parti. Le chevron le dit — pointe tournée
            vers l'extérieur, dans le sens où le prix s'en est allé. */}
        {outside ? (
          <path
            d={
              outside === "below"
                ? `M${x0 - 6},${height / 2} L${x0 - 2},${height / 2 - 3} L${x0 - 2},${height / 2 + 3} Z`
                : `M${x1 + 6},${height / 2} L${x1 + 2},${height / 2 - 3} L${x1 + 2},${height / 2 + 3} Z`
            }
            fill="var(--color-warn)"
          />
        ) : null}
      </svg>
    </span>
  );
}

function label(outside: "below" | "above" | null, nearEdge: boolean): string {
  if (outside) return `hors plage, prix sorti par le ${outside === "below" ? "bas" : "haut"}`;
  return nearEdge ? "dans la plage, proche du bord" : "dans la plage";
}

function tooltip({
  lowerPrice,
  upperPrice,
  currentPrice,
  ratio,
  outside,
  nearEdge,
}: {
  lowerPrice: number;
  upperPrice: number;
  currentPrice: number;
  ratio: number;
  outside: "below" | "above" | null;
  nearEdge: boolean;
}): string {
  const lines: string[] = [];

  // Prix à 0 = non calculable (bin step absent). Mieux vaut une infobulle
  // courte qu'une ligne « $0 — $0 », qui se lirait comme une mesure.
  if (lowerPrice > 0 && upperPrice > 0) {
    lines.push(`plage ${fmtPrice(lowerPrice)} — ${fmtPrice(upperPrice)}`);
  }
  if (currentPrice > 0) lines.push(`prix ${fmtPrice(currentPrice)}`);

  if (outside) {
    lines.push(
      outside === "below"
        ? "hors plage par le bas : la position ne perçoit plus de fees"
        : "hors plage par le haut : la position ne perçoit plus de fees",
    );
  } else {
    const toEdge = Math.min(ratio, 1 - ratio) * 100;
    lines.push(`dans la plage, à ${toEdge.toFixed(0)} % du bord le plus proche`);
    if (nearEdge) lines.push("⚠ sortie imminente");
  }
  return lines.join("\n");
}
