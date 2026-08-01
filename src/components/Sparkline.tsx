/**
 * Inline sparkline, hand-rolled SVG.
 *
 * A charting library is the wrong tool here: the table renders up to a hundred
 * of these at once and re-renders them on every collector tick. This is a
 * single <path> with no state, no layout measurement and no dependencies.
 *
 * The series is per-interval fee rate, oldest first. It is normalised to its
 * own min/max, so the shape shows momentum rather than absolute size — the
 * magnitude already has its own column.
 */
export function Sparkline({
  points,
  width = 64,
  height = 18,
  className = "",
}: {
  points: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height} className={className} aria-hidden>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--color-line-strong)"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      </svg>
    );
  }

  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  // 1px inset top and bottom so the stroke is never clipped.
  const y = (v: number): number => height - 1 - ((v - min) / span) * (height - 2);

  const d = points.map((v, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const rising = last >= first;
  const stroke = rising ? "var(--color-up)" : "var(--color-down)";

  return (
    <svg width={width} height={height} className={className} aria-hidden>
      <path
        d={`${d} L${width},${height} L0,${height} Z`}
        fill={stroke}
        opacity={0.1}
      />
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" />
      <circle cx={width - 1} cy={y(last)} r={1.5} fill={stroke} />
    </svg>
  );
}
