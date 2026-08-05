"use client";

import { useCallback, useEffect, useState } from "react";
import { Nav } from "@/components/Nav";
import { PoolDetail } from "@/components/PoolDetailLazy";
import { WalletButtons, type ConnectedWallet } from "@/components/WalletConnect";
import { fmtAge, fmtPct, fmtUsd } from "@/lib/format";

interface Roi {
  pnlUsd: number;
  roiPct: number | null;
  feeUsd: number;
  depositedUsd: number;
  since: number;
}
interface Position {
  positionAddress: string;
  poolAddress: string;
  poolName: string;
  firstSeenAt: number;
  lastSeenAt: number;
  closed: boolean;
  valued: boolean;
  inRange: boolean;
  valueUsd: number;
  claimedFeeUsd: number;
  unclaimedFeeUsd: number;
  lowerBinId: number;
  upperBinId: number;
  roi: Roi;
}

export function PositionsView() {
  const [owner, setOwner] = useState("");
  const [input, setInput] = useState("");
  const [positions, setPositions] = useState<Position[]>([]);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async (addr: string) => {
    if (!addr) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/positions?owner=${encodeURIComponent(addr)}`, {
        cache: "no-store",
      });
      const data = await res.json();
      setConfigured(data.configured !== false);
      setPositions(data.positions ?? []);
      setError(data.error ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "erreur réseau");
    } finally {
      setLoading(false);
    }
  }, []);

  // L'adresse est conservée localement : c'est une donnée publique, et ça
  // évite de la ressaisir à chaque visite.
  useEffect(() => {
    const saved = localStorage.getItem("radar.owner");
    if (saved) {
      setOwner(saved);
      setInput(saved);
      void load(saved);
    }
  }, [load]);

  useEffect(() => {
    if (!owner) return;
    const t = setInterval(() => void load(owner), 30_000);
    return () => clearInterval(t);
  }, [owner, load]);

  const use = (addr: string): void => {
    setOwner(addr);
    setInput(addr);
    localStorage.setItem("radar.owner", addr);
    void load(addr);
  };

  const open = positions.filter((p) => !p.closed);
  const closed = positions.filter((p) => p.closed);
  const sum = (ps: Position[], f: (p: Position) => number): number =>
    ps.reduce((s, p) => s + (p.valued ? f(p) : 0), 0);
  const totalValue = sum(open, (p) => p.valueUsd);
  const totalFees = sum(positions, (p) => p.claimedFeeUsd + p.unclaimedFeeUsd);
  const totalPnl = sum(positions, (p) => p.roi.pnlUsd);
  const totalDeposited = sum(positions, (p) => p.roi.depositedUsd);

  return (
    <div className="flex h-full flex-col">
      <Nav now={now} />

      <div className="flex flex-col gap-2 border-b border-line bg-app px-3 py-2 text-[12px] md:flex-row md:items-center md:gap-3 md:py-1.5 md:text-[11px]">
        <WalletButtons
          onConnected={(w) => {
            setWallet(w);
            setError(null);
            use(w.address);
          }}
          onError={setError}
        />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") use(input.trim());
          }}
          onBlur={() => input.trim() && input.trim() !== owner && use(input.trim())}
          placeholder="ou colle une adresse de wallet"
          className="tnum min-h-[40px] w-full rounded-[2px] bg-raised px-2 text-fg outline-none focus:ring-1 focus:ring-accent md:min-h-0 md:w-[380px] md:px-1.5 md:py-0.5"
        />
        {loading ? <span className="text-fg-faint">lecture de la chaîne…</span> : null}
        {error ? <span className="text-warn">⚠ {error}</span> : null}
      </div>

      {!configured ? (
        <div className="px-3 py-6 text-center text-[12px] leading-relaxed text-fg-faint">
          Aucun endpoint RPC configuré. Ajoute <code className="text-fg-dim">RPC_URL</code> dans
          <code className="text-fg-dim"> radar.env</code> puis relance
          <code className="text-fg-dim"> ./scripts/deploy.sh</code>.
          <br />
          Le reste du dashboard n&apos;en dépend pas.
        </div>
      ) : null}

      {owner && positions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-3 py-1.5 text-[11px] md:gap-6">
          <Total label="Exposition" value={fmtUsd(totalValue)} />
          <Total label="Fees perçues" value={fmtUsd(totalFees)} good />
          <Total
            label="P&L depuis suivi"
            value={fmtUsd(totalPnl)}
            good={totalPnl >= 0}
            bad={totalPnl < 0}
          />
          <Total
            label="ROI"
            value={totalDeposited > 0 ? fmtPct((totalPnl / totalDeposited) * 100, 2) : "—"}
            good={totalPnl >= 0}
            bad={totalPnl < 0}
          />
          <span className="text-fg-faint">
            {open.length} ouverte{open.length > 1 ? "s" : ""} · {closed.length} fermée
            {closed.length > 1 ? "s" : ""}
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {open.length > 0 ? (
          <Table title="Positions ouvertes" rows={open} now={now} onSelect={setSelected} />
        ) : null}
        {closed.length > 0 ? (
          <Table title="Positions fermées" rows={closed} now={now} onSelect={setSelected} />
        ) : null}
        {owner && !loading && positions.length === 0 && configured ? (
          <div className="px-3 py-8 text-center text-fg-faint">
            Aucune position DLMM pour cette adresse.
          </div>
        ) : null}
      </div>

      {selected ? <PoolDetail address={selected} onClose={() => setSelected(null)} /> : null}

      <footer className="hidden border-t border-line bg-surface px-3 py-1 text-[10px] text-fg-faint md:block">
        Le prix de revient n&apos;existe nulle part sur la chaîne : un compte de position porte sa
        valeur courante et ses fees, jamais le montant déposé. Le ROI part donc de la première
        observation par le dashboard — d&apos;où « depuis le … » sur chaque ligne. Les dépôts et
        retraits ultérieurs sont détectés par la variation des parts de liquidité, insensible aux
        rotations de bins. Positions DLMM uniquement.
      </footer>
    </div>
  );
}

function Total({
  label,
  value,
  good,
  bad,
}: {
  label: string;
  value: string;
  good?: boolean;
  bad?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="uppercase tracking-wide text-fg-faint">{label}</span>
      <span className={`tnum ${bad ? "text-down" : good ? "text-up" : "text-fg"}`}>{value}</span>
    </span>
  );
}

function Table({
  title,
  rows,
  now,
  onSelect,
}: {
  title: string;
  rows: Position[];
  now: number | null;
  onSelect: (a: string) => void;
}) {
  return (
    <>
      <h3 className="border-b border-line bg-app px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
        {title}
      </h3>
      <table className="hidden w-full border-collapse text-[12px] md:table">
        <thead className="sticky top-0 bg-app text-[10px] uppercase tracking-wide text-fg-faint">
          <tr className="border-b border-line-strong">
            <th className="w-[200px] px-2 py-1.5 text-left">Pool</th>
            <th className="w-[90px] px-2 py-1.5 text-right">Valeur</th>
            <th className="w-[90px] px-2 py-1.5 text-right">Fees</th>
            <th className="w-[90px] px-2 py-1.5 text-right">P&amp;L</th>
            <th className="w-[80px] px-2 py-1.5 text-right">ROI</th>
            <th className="w-[90px] px-2 py-1.5 text-right">Engagé</th>
            <th className="w-[80px] px-2 py-1.5 text-left">Plage</th>
            <th className="w-[90px] px-2 py-1.5 text-right">Depuis</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr
              key={p.positionAddress}
              onClick={() => onSelect(p.poolAddress)}
              className="h-row cursor-pointer border-b border-line hover:bg-hover"
            >
              <td className="truncate px-2 font-medium text-fg" title={p.poolAddress}>
                {p.poolName}
                {!p.valued ? (
                  <span className="ml-1.5 text-[9px] text-warn" title="pool absente du datapi">
                    non valorisée
                  </span>
                ) : null}
              </td>
              <td className="tnum px-2 text-right text-fg-dim">
                {p.valued ? fmtUsd(p.valueUsd) : "—"}
              </td>
              <td className="tnum px-2 text-right text-up">
                {p.valued ? fmtUsd(p.claimedFeeUsd + p.unclaimedFeeUsd) : "—"}
              </td>
              <td
                className={`tnum px-2 text-right ${p.roi.pnlUsd >= 0 ? "text-up" : "text-down"}`}
              >
                {p.valued ? fmtUsd(p.roi.pnlUsd) : "—"}
              </td>
              <td
                className={`tnum px-2 text-right ${(p.roi.roiPct ?? 0) >= 0 ? "text-up" : "text-down"}`}
              >
                {p.roi.roiPct !== null && p.valued ? fmtPct(p.roi.roiPct, 2) : "—"}
              </td>
              <td className="tnum px-2 text-right text-fg-faint">
                {p.valued ? fmtUsd(p.roi.depositedUsd) : "—"}
              </td>
              <td className="px-2">
                {p.closed ? (
                  <span className="text-fg-faint">fermée</span>
                ) : p.inRange ? (
                  <span className="text-up">dans la plage</span>
                ) : (
                  <span className="text-warn" title="hors plage : la position ne perçoit plus de fees">
                    hors plage
                  </span>
                )}
              </td>
              <td
                className="tnum px-2 text-right text-fg-faint"
                title={new Date(p.roi.since).toLocaleString("fr-FR")}
              >
                {fmtAge(p.roi.since, now ?? p.lastSeenAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Même raisonnement que la vue Marché : huit colonnes ne tiennent pas
          sur un téléphone, et la bascule est faite en CSS pour que le rendu
          desktop reste rigoureusement inchangé. */}
      <ul className="md:hidden">
        {rows.map((p) => (
          <li
            key={p.positionAddress}
            onClick={() => onSelect(p.poolAddress)}
            className="flex min-h-[64px] cursor-pointer flex-col justify-center gap-1 border-b border-line px-3 py-2 text-[13px] active:bg-hover"
          >
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-fg">{p.poolName}</span>
              {!p.valued ? <span className="text-[9px] text-warn">non valorisée</span> : null}
              <span
                className={`ml-auto shrink-0 tnum ${(p.roi.roiPct ?? 0) >= 0 ? "text-up" : "text-down"}`}
              >
                {p.roi.roiPct !== null && p.valued ? fmtPct(p.roi.roiPct, 2) : "—"}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[12px]">
              <span className="text-fg-faint">
                valeur <span className="tnum text-fg-dim">{p.valued ? fmtUsd(p.valueUsd) : "—"}</span>
              </span>
              <span className="text-fg-faint">
                fees{" "}
                <span className="tnum text-up">
                  {p.valued ? fmtUsd(p.claimedFeeUsd + p.unclaimedFeeUsd) : "—"}
                </span>
              </span>
              <span className="text-fg-faint">
                P&amp;L{" "}
                <span className={`tnum ${p.roi.pnlUsd >= 0 ? "text-up" : "text-down"}`}>
                  {p.valued ? fmtUsd(p.roi.pnlUsd) : "—"}
                </span>
              </span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-fg-faint">
              {p.closed ? (
                <span>fermée</span>
              ) : p.inRange ? (
                <span className="text-up">dans la plage</span>
              ) : (
                <span className="text-warn">hors plage</span>
              )}
              <span className="ml-auto tnum">depuis {fmtAge(p.roi.since, now ?? p.lastSeenAt)}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
