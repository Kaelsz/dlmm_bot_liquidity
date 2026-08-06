"use client";

import { useState } from "react";
import { RangeBar } from "@/components/RangeBar";
import type { Wallet } from "@/components/WalletConnect";
import { fmtPrice } from "@/lib/format";

/**
 * Ouverture d'une position en un clic.
 *
 * MÊMES DEUX PRINCIPES QUE LE ZAP OUT, et pour la même raison : ce bouton
 * engage de l'argent réel.
 *
 * 1. Rien n'est signé sans récapitulatif. Le serveur construit et simule, puis
 *    on montre la plage obtenue, le prix courant dedans, le montant engagé et
 *    le loyer immobilisé. Un clic ne doit jamais suffire à ouvrir une position.
 * 2. La signature a lieu dans le portefeuille. Le serveur ne détient aucune clé.
 *
 * CE QUI EST PROPRE À L'OUVERTURE : créer une position, c'est créer un compte,
 * et un compte neuf signe sa propre création. La paire de clés est générée ICI,
 * dans le navigateur ; le serveur n'en voit que la clé publique. Il ne peut donc
 * pas produire une transaction exécutable, même s'il le voulait.
 */

const SIGN_AND_SEND = "solana:signAndSendTransaction";

interface Plan {
  transaction: string;
  positionAddress: string;
  poolAddress: string;
  poolName: string;
  strategyId: string;
  strategyLabel: string;
  minBinId: number;
  maxBinId: number;
  activeBinId: number;
  binCount: number;
  lowerPrice: number;
  upperPrice: number;
  currentPrice: number;
  amountSol: number;
  rentSol: number;
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

/** Montants proposés. La saisie libre reste possible. */
const PRESETS = [0.1, 0.25, 0.5, 1];

export function OpenPosition({
  poolAddress,
  owner,
  wallet,
  account,
  onDone,
}: {
  poolAddress: string;
  owner: string;
  wallet: Wallet | null;
  account: unknown;
  onDone?: () => void;
}) {
  const [amount, setAmount] = useState("0.1");
  const [plan, setPlan] = useState<Plan | null>(null);
  // La paire de clés du compte de position, gardée entre la préparation et la
  // signature : le serveur a construit la transaction AUTOUR de cette clé
  // publique, en changer invaliderait tout.
  const [keypair, setKeypair] = useState<{ publicKey: string; secret: Uint8Array } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canSign = wallet !== null && SIGN_AND_SEND in wallet.features;
  const lamports = Math.round((Number(amount.replace(",", ".")) || 0) * 1e9);
  const amountValid = lamports >= 1_000_000;

  const prepare = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      // Import différé : `@solana/web3.js` pèse lourd et n'est utile qu'ici.
      // Le charger au montage alourdirait la page pour tous les visiteurs qui
      // ne prendront jamais de position.
      const { Keypair } = await import("@solana/web3.js");
      const kp = Keypair.generate();
      setKeypair({ publicKey: kp.publicKey.toBase58(), secret: kp.secretKey });

      const res = await fetch("/api/positions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner,
          poolAddress,
          positionPubKey: kp.publicKey.toBase58(),
          amountLamports: lamports,
          strategyId: "spot70-sol",
          maxBinDrift: 5,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPlan(data as Plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "préparation impossible");
      setKeypair(null);
    } finally {
      setBusy(false);
    }
  };

  const send = async (): Promise<void> => {
    if (!plan || !wallet || !keypair) return;
    const feature = wallet.features[SIGN_AND_SEND] as SignAndSendFeature | undefined;
    if (!feature) {
      setError("ce portefeuille ne sait pas signer");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { Keypair, Transaction } = await import("@solana/web3.js");
      const tx = Transaction.from(b64ToBytes(plan.transaction));
      // Signature du compte de position AVANT de passer au portefeuille. Le
      // portefeuille ajoutera la sienne ; les deux coexistent dans la même
      // transaction.
      tx.partialSign(Keypair.fromSecretKey(keypair.secret));

      setStep("signature…");
      await feature.signAndSendTransaction({
        account,
        transaction: new Uint8Array(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ),
        chain: "solana:mainnet",
      });
      setStep(null);
      setPlan(null);
      setKeypair(null);
      setDone(true);
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "signature refusée");
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  if (done) {
    return (
      <p className="text-[11px] text-up">
        Position envoyée. Elle apparaîtra dans l&apos;onglet Positions au prochain relevé.
      </p>
    );
  }

  if (!plan) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((v) => (
            <button
              key={v}
              onClick={() => setAmount(String(v))}
              className={`min-h-[36px] rounded-[3px] px-2.5 text-[12px] md:min-h-0 md:py-1 md:text-[11px] ${
                amount === String(v)
                  ? "bg-raised text-accent"
                  : "text-fg-faint hover:bg-raised hover:text-fg-dim"
              }`}
            >
              {v} SOL
            </button>
          ))}
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            aria-label="montant en SOL"
            className="tnum min-h-[36px] w-[84px] rounded-[3px] bg-raised px-2 text-[12px] text-fg outline-none focus:ring-1 focus:ring-accent md:min-h-0 md:py-1 md:text-[11px]"
          />
          <button
            disabled={busy || !canSign || !amountValid}
            onClick={() => void prepare()}
            title={
              canSign
                ? "Prépare une position Spot sur 70 bins, alimentée en SOL"
                : "Connecte un portefeuille capable de signer"
            }
            className="min-h-[36px] rounded-[3px] bg-raised px-3 text-[12px] text-accent hover:bg-hover disabled:opacity-40 md:min-h-0 md:py-1 md:text-[11px]"
          >
            {busy ? "…" : "Ouvrir une position"}
          </button>
        </div>
        {!amountValid ? (
          <span className="text-[10px] text-fg-faint">Minimum 0,001 SOL.</span>
        ) : null}
        {error ? <span className="text-[11px] text-down">{error}</span> : null}
      </div>
    );
  }

  return (
    <div className="rounded-[3px] border border-line-strong bg-raised p-2 text-[11px]">
      <div className="mb-1.5 font-semibold text-fg">
        {plan.strategyLabel} — {plan.binCount} bins sur {plan.poolName}
      </div>

      <div className="mb-2 flex items-center gap-2">
        <RangeBar
          lowerBinId={plan.minBinId}
          upperBinId={plan.maxBinId}
          activeBinId={plan.activeBinId}
          lowerPrice={plan.lowerPrice}
          upperPrice={plan.upperPrice}
          currentPrice={plan.currentPrice}
        />
        <span className="text-fg-faint">
          {fmtPrice(plan.lowerPrice)} — {fmtPrice(plan.upperPrice)}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <Row label="Tu engages" value={`${plan.amountSol} SOL`} strong />
        <Row label="Loyer des comptes" value={`${plan.rentSol.toFixed(5)} SOL`} />
        <Row label="Prix actuel" value={fmtPrice(plan.currentPrice)} />
        <Row label="Bins" value={`${plan.minBinId} → ${plan.maxBinId}`} />
      </dl>

      <p className="mt-1 text-fg-faint">
        Le loyer revient à la fermeture de la position, il n&apos;est pas dépensé.
      </p>

      {plan.warnings.map((w) => (
        <p key={w} className="mt-1 text-warn">
          ⚠ {w}
        </p>
      ))}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          disabled={busy}
          onClick={() => void send()}
          className="min-h-[40px] rounded-[3px] bg-[#0e3d3a] px-3 text-up hover:brightness-125 disabled:opacity-40 md:min-h-[32px]"
        >
          {step ?? "Confirmer et signer"}
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setPlan(null);
            setKeypair(null);
          }}
          className="min-h-[40px] rounded-[3px] px-3 text-fg-faint hover:text-fg md:min-h-[32px] md:px-2"
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
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <>
      <dt className="text-fg-faint">{label}</dt>
      <dd className={`tnum text-right ${strong ? "text-fg" : "text-fg-dim"}`}>{value}</dd>
    </>
  );
}
