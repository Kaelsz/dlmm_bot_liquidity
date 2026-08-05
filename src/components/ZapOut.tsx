"use client";

import { useState } from "react";
import type { Wallet } from "@/components/WalletConnect";

/**
 * Bouton Zap Out : ferme une position et ressort en un seul token.
 *
 * DEUX PRINCIPES NON NÉGOCIABLES.
 *
 * 1. Rien n'est signé sans récapitulatif. Le serveur construit et simule, puis
 *    on affiche ce que l'utilisateur va recevoir, le plancher garanti par le
 *    slippage et l'impact prix. Un bouton qui vide une position ne doit jamais
 *    partir sur un seul clic.
 * 2. La signature a lieu dans le portefeuille, jamais ailleurs. Le serveur ne
 *    détient aucune clé et ne peut rien envoyer ; il rend des transactions non
 *    signées, inutilisables sans accord explicite.
 *
 * Les transactions partent SÉQUENTIELLEMENT. Si la seconde échoue, la position
 * est fermée et l'utilisateur détient les deux tokens : ce n'est pas une perte,
 * et le message le dit au lieu de laisser croire à un échec total.
 */

const SIGN_AND_SEND = "solana:signAndSendTransaction";

interface Plan {
  transactions: string[];
  inputMint: string;
  outputMint: string;
  expectedOut: number;
  minOut: number;
  priceImpactPct: number;
  claimedFees: { x: number; y: number };
  warnings: string[];
}

interface SignAndSendFeature {
  signAndSendTransaction: (input: {
    account: unknown;
    transaction: Uint8Array;
    chain: string;
  }) => Promise<ReadonlyArray<{ signature: Uint8Array }>>;
}

const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

export function ZapOut({
  owner,
  positionAddress,
  wallet,
  account,
  onDone,
}: {
  owner: string;
  positionAddress: string;
  wallet: Wallet | null;
  account: unknown;
  onDone: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);

  const canSign = wallet !== null && SIGN_AND_SEND in wallet.features;

  const prepare = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/positions/zap-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner, positionAddress, slippageBps: 100 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPlan(data as Plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "préparation impossible");
    } finally {
      setBusy(false);
    }
  };

  const send = async (): Promise<void> => {
    if (!plan || !wallet) return;
    const feature = wallet.features[SIGN_AND_SEND] as SignAndSendFeature | undefined;
    if (!feature) {
      setError("ce portefeuille ne sait pas signer");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const [i, tx] of plan.transactions.entries()) {
        setStep(`signature ${i + 1}/${plan.transactions.length}…`);
        await feature.signAndSendTransaction({
          account,
          transaction: b64ToBytes(tx),
          chain: "solana:mainnet",
        });
      }
      setStep("envoyé");
      setPlan(null);
      onDone();
    } catch (err) {
      const message = err instanceof Error ? err.message : "signature refusée";
      setError(
        plan.transactions.length > 1
          ? `${message} — si le retrait est passé, la position est fermée et tu détiens les deux tokens.`
          : message,
      );
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const sym = (mint: string): string => SYMBOLS[mint] ?? `${mint.slice(0, 4)}…`;

  if (!plan) {
    return (
      <span className="flex items-center gap-2">
        <button
          disabled={busy || !canSign}
          onClick={(e) => {
            e.stopPropagation();
            void prepare();
          }}
          title={canSign ? "Retirer, réclamer les fees et fermer" : "Connecte un portefeuille capable de signer"}
          className="min-h-[32px] shrink-0 rounded-[3px] bg-raised px-2 text-[11px] text-accent hover:bg-hover disabled:opacity-40"
        >
          {busy ? "…" : "Zap out"}
        </button>
        {error ? <span className="text-[10px] text-down">{error}</span> : null}
      </span>
    );
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="mt-1 rounded-[3px] border border-line-strong bg-raised p-2 text-[11px]"
    >
      <div className="mb-1 font-semibold text-fg">Fermer la position et sortir en {sym(plan.outputMint)}</div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <Row label="Tu recevras environ" value={`${plan.expectedOut.toFixed(6)} ${sym(plan.outputMint)}`} strong />
        <Row label="Minimum garanti" value={`${plan.minOut.toFixed(6)} ${sym(plan.outputMint)}`} />
        <Row label="Impact prix" value={`${plan.priceImpactPct.toFixed(2)} %`} warn={plan.priceImpactPct > 5} />
        <Row label="Fees réclamées" value={`${plan.claimedFees.x} / ${plan.claimedFees.y}`} />
      </dl>
      {plan.warnings.map((w) => (
        <p key={w} className="mt-1 text-warn">
          ⚠ {w}
        </p>
      ))}
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={busy}
          onClick={() => void send()}
          className="min-h-[32px] rounded-[3px] bg-[#0e3d3a] px-3 text-up hover:brightness-125 disabled:opacity-40"
        >
          {step ?? "Confirmer et signer"}
        </button>
        <button
          disabled={busy}
          onClick={() => setPlan(null)}
          className="min-h-[32px] rounded-[3px] px-2 text-fg-faint hover:text-fg"
        >
          Annuler
        </button>
        {error ? <span className="text-down">{error}</span> : null}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  warn,
}: {
  label: string;
  value: string;
  strong?: boolean;
  warn?: boolean;
}) {
  return (
    <>
      <dt className="text-fg-faint">{label}</dt>
      <dd className={`tnum text-right ${warn ? "text-warn" : strong ? "text-fg" : "text-fg-dim"}`}>
        {value}
      </dd>
    </>
  );
}
