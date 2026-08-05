"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { heatTier, isRateReliable, signalCoverage, MIN_SIGNAL_COVERAGE } from "@/data/metrics";
import { TokenLinksVerbose } from "@/components/TokenLinks";
import {
  fmtAge,
  fmtAxisTime,
  fmtInt,
  fmtPct,
  fmtPrice,
  fmtRate,
  fmtUsd,
  splitPairName,
} from "@/lib/format";
import type { PoolDetailResponse } from "@/lib/api-types";

const WINDOWS = [
  ["1h", "1 h"],
  ["6h", "6 h"],
  ["24h", "24 h"],
  ["7d", "7 j"],
  ["30d", "30 j"],
] as const;

const WINDOW_HOURS: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720 };

/**
 * Side panel for one pool.
 *
 * Two charts, stacked: price on top, our derived fee rate underneath. That
 * pairing is the whole point of the panel — a spike in fees that coincides
 * with a price collapse is a very different proposition from one that happens
 * while the price holds, and no single number in the table can express the
 * difference.
 *
 * Because the layout invites reading the two vertically, both x axes are
 * pinned to the *same* explicit domain — the requested window — rather than
 * each auto-scaling to its own data. Without that, a 7d price chart sat above
 * 15 minutes of fee history and aligned points referred to unrelated instants.
 *
 * The fee series can never fill a long window: raw samples are retained for
 * `collector.sampleRetentionMs` (6h) and start when the collector first saw
 * the pool. When coverage gets too thin to plot honestly, the panel says what
 * it has instead of drawing a sliver.
 */
export function PoolDetail({ address, onClose }: { address: string; onClose: () => void }) {
  const [data, setData] = useState<PoolDetailResponse | null>(null);
  const [windowKey, setWindowKey] = useState<string>("6h");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/pool/${address}?window=${windowKey}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 404 ? "pool inconnue" : `HTTP ${res.status}`);
      setData((await res.json()) as PoolDetailResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "erreur réseau");
    } finally {
      setLoading(false);
    }
  }, [address, windowKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // Escape closes, which is what anyone expects from a panel like this.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const p = data?.pool;
  const { base, quote } = p ? splitPairName(p.name) : { base: "", quote: "" };

  // Both charts are pinned to this range. `generatedAt` rather than Date.now()
  // so the axis matches the data the server actually assembled.
  const windowMs = (data?.windowHours ?? 0) * 3_600_000;
  const end = data?.generatedAt ?? Date.now();
  const start = end - windowMs;
  const coverage = signalCoverage(data?.signal ?? [], windowMs);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/50"
        onClick={onClose}
        aria-hidden
      />
      <aside className="panel-in fixed right-0 top-0 z-50 flex h-dvh w-full max-w-[620px] flex-col border-l border-line-strong bg-surface shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line-strong px-3 py-2">
          {p ? (
            <>
              <span
                className={`shrink-0 rounded-[2px] px-1 text-[9px] font-semibold uppercase leading-[14px] ${
                  p.protocol === "dlmm" ? "bg-[#1a2c3d] text-[#63b3ed]" : "bg-[#2d2439] text-[#b794f4]"
                }`}
              >
                {p.protocol === "dlmm" ? "DLMM" : "DAMM v2"}
              </span>
              <span className="truncate text-[14px] font-semibold text-fg">{base}</span>
              <span className="text-fg-faint">/{quote}</span>
              {p.binStep ? (
                <span className="tnum text-[10px] text-fg-faint" title="bin step">
                  bin {p.binStep}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-fg-faint">chargement…</span>
          )}
          <button
            onClick={onClose}
            className="ml-auto min-h-[36px] min-w-[36px] rounded-[3px] px-2 text-[14px] text-fg-faint hover:bg-raised hover:text-fg md:min-h-0 md:min-w-0 md:py-0.5 md:text-[11px]"
            title="Fermer (Échap)"
          >
            ✕
          </button>
        </header>

        <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-3 py-1.5">
          {WINDOWS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setWindowKey(k)}
              className={`shrink-0 rounded-[3px] px-2.5 py-1.5 text-[12px] transition-colors md:px-2 md:py-0.5 md:text-[11px] ${
                windowKey === k
                  ? "bg-raised text-accent"
                  : "text-fg-faint hover:bg-raised hover:text-fg-dim"
              }`}
            >
              {label}
            </button>
          ))}
          {data?.timeframe ? (
            <span className="ml-auto text-[10px] text-fg-faint">
              bougies {data.timeframe} · {data.candles.length}
            </span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? <div className="px-3 py-6 text-center text-down">⚠ {error}</div> : null}
          {!error && loading && !data ? (
            <div className="px-3 py-6 text-center text-fg-faint">chargement…</div>
          ) : null}

          {p && data ? (
            <>
              <Section title="Prix">
                <PriceChart candles={data.candles} start={start} end={end} />
              </Section>

              <Section
                title="Fees dérivées ($/min)"
                aside={
                  coverage.spanMs > 0
                    ? `couvre ${fmtAge(end - coverage.spanMs, end)} · ${data.signal.length} pts`
                    : undefined
                }
              >
                <RateChart
                  signal={data.signal}
                  start={start}
                  end={end}
                  coverage={coverage}
                  onPickWindow={setWindowKey}
                />
              </Section>

              <Section title="Marché">
                <Grid
                  items={[
                    ["Heat", fmtPct(p.heatPctHr, 2) + "/h", heatTier(p.heatPctHr) !== "inert"],
                    [
                      "Taux de fees",
                      fmtRate(p.feeRateUsdMin) + "/min",
                      isRateReliable(p),
                    ],
                    [
                      "Fenêtre du taux",
                      p.rateSpanMs > 0
                        ? `${Math.round(p.rateSpanMs / 1000)} s · ${p.rateUpdates} maj`
                        : "—",
                      false,
                    ],
                    ["Volume", fmtRate(p.volumeRateUsdMin) + "/min", p.volumeRateUsdMin > 0],
                    ["TVL", fmtUsd(p.tvl)],
                    ["Market cap", p.marketCap > 0 ? fmtUsd(p.marketCap) : "—"],
                    ["Prix", fmtPrice(p.price)],
                    ["Volume 30 m", fmtUsd(p.volume30m)],
                    ["Fees 30 m", fmtUsd(p.fees30m)],
                    ["Fees/TVL 24 h", fmtPct(p.feeTvl24hPct, 3)],
                    ["Frais de base", fmtPct(p.baseFeePct, 2)],
                    [
                      "Frais dynamiques",
                      p.dynamicFeePct !== null ? fmtPct(p.dynamicFeePct, 2) : "—",
                      p.dynamicFeePct !== null && p.dynamicFeePct !== p.baseFeePct,
                    ],
                    ["Âge", fmtAge(p.createdAt)],
                    ["Échantillons", fmtInt(p.sampleCount)],
                    ["Launchpad", p.launchpad ?? "—"],
                  ]}
                />
              </Section>

              <Section title="Sécurité">
                <Safety pool={p} />
              </Section>

              <Section title="Liens">
                <TokenLinksVerbose mint={p.riskyMint} poolAddress={p.address} />
                <div className="mt-2 space-y-1">
                  <Addr label="Pool" value={p.address} />
                  <Addr label="Token" value={p.riskyMint} />
                </div>
              </Section>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-line px-3 py-2">
      <h3 className="mb-1.5 flex items-baseline gap-2 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
        {title}
        {aside ? <span className="tnum font-normal normal-case tracking-normal">{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

const AXIS = { stroke: "#5c636e", fontSize: 9 };
const TOOLTIP_STYLE = {
  backgroundColor: "#14171c",
  border: "1px solid #262c35",
  borderRadius: 3,
  fontSize: 11,
  padding: "4px 8px",
};

/**
 * Shared by both charts so a given instant lands on the same x in each.
 * `allowDataOverflow` clips rather than stretches when a series runs past the
 * window edge.
 */
function timeAxisProps(start: number, end: number) {
  const span = end - start;
  // Ticks are spaced over the window, not over the data. Left to itself
  // Recharts derives them from the points, so a series bunched at one end
  // labels only that end and the axis stops conveying the window at all.
  const count = 5;
  const ticks = Array.from({ length: count }, (_, i) =>
    Math.round(start + (span * i) / (count - 1)),
  );
  return {
    dataKey: "t",
    type: "number" as const,
    scale: "time" as const,
    domain: [start, end],
    ticks,
    allowDataOverflow: true,
    tickFormatter: (v: number) => fmtAxisTime(v, span),
    minTickGap: 20,
    ...AXIS,
  };
}

function PriceChart({
  candles,
  start,
  end,
}: {
  candles: PoolDetailResponse["candles"];
  start: number;
  end: number;
}) {
  if (candles.length === 0) {
    return (
      <Empty>
        Pas de bougies sur cette fenêtre — soit la pool n&apos;a pas tradé, soit son historique
        est plus court.
      </Empty>
    );
  }
  const rows = candles.map((c) => ({ t: c.timestamp * 1000, close: c.close }));
  const first = rows[0]!.close;
  const last = rows[rows.length - 1]!.close;
  const up = last >= first;
  const colour = up ? "#2bd97c" : "#ff4d5e";

  return (
    <div className="h-[130px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colour} stopOpacity={0.28} />
              <stop offset="100%" stopColor={colour} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1c2027" vertical={false} />
          <XAxis {...timeAxisProps(start, end)} />
          <YAxis
            {...AXIS}
            // Memecoin prices run to ten characters (0.00000245); anything
            // narrower silently clips the leading digit off every tick.
            width={78}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => fmtPrice(v)}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(v) => new Date(Number(v)).toLocaleString("fr-FR")}
            formatter={(v) => [fmtPrice(Number(v)), "prix"]}
          />
          <Area
            type="monotone"
            dataKey="close"
            stroke={colour}
            strokeWidth={1.4}
            fill="url(#priceFill)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Narrowest listed window that the covered span would fill respectably. */
function suggestWindow(spanMs: number): (typeof WINDOWS)[number] {
  return WINDOWS.find(([k]) => (WINDOW_HOURS[k] ?? 0) * 3_600_000 >= spanMs) ?? WINDOWS[0];
}

function RateChart({
  signal,
  start,
  end,
  coverage,
  onPickWindow,
}: {
  signal: PoolDetailResponse["signal"];
  start: number;
  end: number;
  coverage: { spanMs: number; ratio: number };
  onPickWindow: (key: string) => void;
}) {
  if (signal.length < 2) {
    return (
      <Empty>
        Pas encore assez d&apos;échantillons. Le taux se dérive de deux lectures successives des
        fees cumulées, donc l&apos;historique commence quand le collecteur a repéré cette pool.
      </Empty>
    );
  }

  // Pinned to the window, a thin series collapses against the right edge. Say
  // what we have and offer the zoom where it is actually legible.
  if (coverage.ratio < MIN_SIGNAL_COVERAGE) {
    const [key, label] = suggestWindow(coverage.spanMs);
    return (
      <Empty>
        Historique de fees limité à {fmtAge(end - coverage.spanMs, end)} — les échantillons bruts
        sont conservés 6 h et démarrent à la découverte de la pool.{" "}
        <button
          onClick={() => onPickWindow(key)}
          className="whitespace-nowrap text-accent underline underline-offset-2 hover:text-fg"
        >
          Voir sur {label}
        </button>
      </Empty>
    );
  }

  const rows = signal.map((s) => ({ t: s.ts, rate: s.rate }));
  return (
    <div className="h-[110px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#1c2027" vertical={false} />
          <XAxis {...timeAxisProps(start, end)} />
          {/* Same width as the price axis so both plot areas start at the same x. */}
          <YAxis {...AXIS} width={78} tickFormatter={(v: number) => fmtRate(v)} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(v) => new Date(Number(v)).toLocaleString("fr-FR")}
            formatter={(v) => [`${fmtRate(Number(v))}/min`, "fees"]}
          />
          <Line
            type="monotone"
            dataKey="rate"
            stroke="#00d9ff"
            strokeWidth={1.4}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[110px] items-center justify-center px-6 text-center text-[11px] leading-relaxed text-fg-faint">
      {children}
    </div>
  );
}

function Grid({ items }: { items: Array<[string, string] | [string, string, boolean]> }) {
  return (
    <dl className="grid grid-cols-3 gap-x-3 gap-y-1">
      {items.map(([label, value, highlight]) => (
        <div key={label} className="min-w-0">
          <dt className="truncate text-[9px] uppercase tracking-wide text-fg-faint">{label}</dt>
          <dd className={`tnum truncate text-[12px] ${highlight ? "text-fg" : "text-fg-dim"}`}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Safety({ pool }: { pool: PoolDetailResponse["pool"] }) {
  const verdictLabel = {
    safe: "aucun risque majeur détecté",
    caution: "risques mineurs",
    danger: "RISQUE ÉLEVÉ",
    unknown: "non analysé par RugCheck",
  }[pool.safety];
  const verdictCls = {
    safe: "text-up",
    caution: "text-warn",
    danger: "text-down",
    unknown: "text-fg-faint",
  }[pool.safety];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-[12px] font-semibold ${verdictCls}`}>{verdictLabel}</span>
        {pool.rugcheckScore !== null ? (
          <span className="tnum text-[11px] text-fg-dim" title="échelle RugCheck : plus haut = plus risqué">
            score {pool.rugcheckScore}/100
          </span>
        ) : null}
      </div>

      <Grid
        items={[
          [
            "LP verrouillée",
            pool.lpLockedPct !== null ? fmtPct(pool.lpLockedPct, 1) : "inconnu",
            (pool.lpLockedPct ?? 0) >= 80,
          ],
          ["Holders", fmtInt(pool.holders)],
          ["Freeze authority", pool.freezeDisabled ? "désactivée" : "ACTIVE", !pool.freezeDisabled],
          ["Token vérifié", pool.verified ? "oui" : "non"],
          ["Blacklist Meteora", pool.isBlacklisted ? "OUI" : "non", pool.isBlacklisted],
        ]}
      />

      {pool.rugcheckRisks.length > 0 ? (
        <ul className="space-y-0.5">
          {pool.rugcheckRisks.slice(0, 8).map((r, i) => (
            <li key={i} className="flex gap-1.5 text-[11px]">
              <span
                className={
                  r.level.toLowerCase() === "danger"
                    ? "text-down"
                    : r.level.toLowerCase() === "warn"
                      ? "text-warn"
                      : "text-fg-faint"
                }
              >
                •
              </span>
              <span className="text-fg-dim" title={r.description}>
                {r.name}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Addr({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="flex w-full items-center gap-2 rounded-[3px] px-1 py-0.5 text-left hover:bg-raised"
      title="Copier"
    >
      <span className="w-[46px] shrink-0 text-[9px] uppercase tracking-wide text-fg-faint">
        {label}
      </span>
      <span className="tnum truncate text-[10px] text-fg-dim">{value}</span>
      <span className="ml-auto shrink-0 text-[10px] text-fg-faint">{copied ? "copié" : "⧉"}</span>
    </button>
  );
}
