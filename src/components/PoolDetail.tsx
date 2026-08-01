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
import { heatTier } from "@/data/metrics";
import { TokenLinksVerbose } from "@/components/TokenLinks";
import { fmtAge, fmtInt, fmtPct, fmtPrice, fmtRate, fmtUsd, splitPairName } from "@/lib/format";
import type { PoolDetailResponse } from "@/lib/api-types";

const WINDOWS = [
  ["1h", "1 h"],
  ["6h", "6 h"],
  ["24h", "24 h"],
  ["7d", "7 j"],
  ["30d", "30 j"],
] as const;

/**
 * Side panel for one pool.
 *
 * Two charts, deliberately stacked and sharing an x range: price on top, our
 * derived fee rate underneath. That pairing is the whole point of the panel —
 * a spike in fees that coincides with a price collapse is a very different
 * proposition from one that happens while the price holds, and no single
 * number in the table can express the difference.
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
            className="ml-auto rounded-[3px] px-2 py-0.5 text-[11px] text-fg-faint hover:bg-raised hover:text-fg"
            title="Fermer (Échap)"
          >
            ✕
          </button>
        </header>

        <div className="flex items-center gap-1 border-b border-line px-3 py-1.5">
          {WINDOWS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setWindowKey(k)}
              className={`rounded-[3px] px-2 py-0.5 text-[11px] transition-colors ${
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
                <PriceChart candles={data.candles} />
              </Section>

              <Section title="Fees dérivées ($/min)">
                <RateChart signal={data.signal} />
              </Section>

              <Section title="Marché">
                <Grid
                  items={[
                    ["Heat", fmtPct(p.heatPctHr, 2) + "/h", heatTier(p.heatPctHr) !== "inert"],
                    ["Taux de fees", fmtRate(p.feeRateUsdMin) + "/min", true],
                    ["TVL", fmtUsd(p.tvl)],
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-3 py-2">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
        {title}
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

const hhmm = (ts: number): string =>
  new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

function PriceChart({ candles }: { candles: PoolDetailResponse["candles"] }) {
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
          <XAxis dataKey="t" tickFormatter={hhmm} {...AXIS} minTickGap={40} />
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

function RateChart({ signal }: { signal: PoolDetailResponse["signal"] }) {
  if (signal.length < 2) {
    return (
      <Empty>
        Pas encore assez d&apos;échantillons. Le taux se dérive de deux lectures successives des
        fees cumulées, donc l&apos;historique commence quand le collecteur a repéré cette pool.
      </Empty>
    );
  }
  const rows = signal.map((s) => ({ t: s.ts, rate: s.rate }));
  return (
    <div className="h-[110px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#1c2027" vertical={false} />
          <XAxis dataKey="t" tickFormatter={hhmm} {...AXIS} minTickGap={40} />
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
