"use client";

import { useEffect, useState } from "react";
import { getWallets } from "@wallet-standard/app";


/**
 * Connexion de portefeuille par le Wallet Standard.
 *
 * La version précédente lisait `window.phantom.solana` en dur : elle ne voyait
 * donc que Phantom, et rien d'autre. Le Wallet Standard est le registre que
 * tous les portefeuilles Solana modernes alimentent eux-mêmes — Phantom,
 * Jupiter, Solflare, Backpack — ce qui les fait apparaître sans qu'aucun nom
 * soit codé ici.
 *
 * Rien n'est signé à cette étape : `connect` ne rend qu'une clé publique, et
 * lire des positions n'exige aucune signature. La saisie manuelle d'adresse
 * reste disponible en repli — sur un navigateur sans extension, c'est le seul
 * chemin.
 */

const CONNECT = "standard:connect";
const SOLANA_SIGN = "solana:signAndSendTransaction";

export interface ConnectedWallet {
  name: string;
  icon: string;
  address: string;
  /** Le portefeuille sait-il signer ? Sans ça, le Zap Out est impossible. */
  canSign: boolean;
  /** Conservés pour la signature : le Wallet Standard exige de repasser le
   *  portefeuille ET le compte exact à `signAndSendTransaction`. */
  wallet: Wallet;
  account: unknown;
}

interface StandardConnectFeature {
  connect: () => Promise<{ accounts: ReadonlyArray<{ address: string }> }>;
}

/**
 * Type minimal du Wallet Standard.
 *
 * Le paquet `@wallet-standard/base` n'est pas une dépendance directe ; plutôt
 * que de l'ajouter pour deux champs, on décrit ici ce qu'on consomme
 * réellement. Cela documente aussi la surface exacte utilisée.
 */
export interface Wallet {
  name: string;
  icon: string;
  chains: readonly string[];
  features: Record<string, unknown>;
}

/** Portefeuilles capables de nous donner une adresse Solana. */
function solanaWallets(all: readonly Wallet[]): Wallet[] {
  return all.filter(
    (w) => CONNECT in w.features && w.chains.some((c: string) => c.startsWith("solana:")),
  );
}

export function useWallets(): Wallet[] {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  useEffect(() => {
    const api = getWallets();
    setWallets(solanaWallets(api.get() as unknown as readonly Wallet[]));
    // Un portefeuille peut s'enregistrer après le chargement de la page : sans
    // ces écoutes, une extension lente n'apparaîtrait jamais.
    const un1 = api.on("register", () => setWallets(solanaWallets(api.get() as unknown as readonly Wallet[])));
    const un2 = api.on("unregister", () => setWallets(solanaWallets(api.get() as unknown as readonly Wallet[])));
    return () => {
      un1();
      un2();
    };
  }, []);
  return wallets;
}

export async function connectWallet(w: Wallet): Promise<ConnectedWallet> {
  const feature = w.features[CONNECT] as StandardConnectFeature | undefined;
  if (!feature) throw new Error(`${w.name} ne sait pas se connecter`);
  const { accounts } = await feature.connect();
  const account = accounts[0];
  if (!account?.address) throw new Error(`${w.name} n'a renvoyé aucun compte`);
  return {
    name: w.name,
    icon: w.icon,
    address: account.address,
    canSign: SOLANA_SIGN in w.features,
    wallet: w,
    account,
  };
}

/**
 * Boutons de connexion, un par portefeuille détecté.
 *
 * Aucune liste codée en dur : ce qui s'affiche est ce qui est réellement
 * installé. Quand rien n'est détecté, on le dit plutôt que de montrer un bouton
 * qui échouerait.
 */
export function WalletButtons({
  onConnected,
  onError,
}: {
  onConnected: (w: ConnectedWallet) => void;
  onError: (message: string) => void;
}) {
  const wallets = useWallets();
  const [busy, setBusy] = useState<string | null>(null);

  if (wallets.length === 0) {
    return (
      <span className="text-fg-faint">
        Aucun portefeuille détecté — colle ton adresse ci-dessous.
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      {wallets.map((w) => (
        <button
          key={w.name}
          disabled={busy !== null}
          onClick={async () => {
            setBusy(w.name);
            try {
              onConnected(await connectWallet(w));
            } catch (err) {
              onError(err instanceof Error ? err.message : `connexion à ${w.name} refusée`);
            } finally {
              setBusy(null);
            }
          }}
          className="flex min-h-[44px] items-center gap-1.5 rounded-[3px] bg-raised px-3 text-accent active:bg-hover disabled:opacity-50 md:min-h-0 md:px-2 md:py-1"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={w.icon} alt="" className="h-4 w-4 rounded-[2px]" />
          {busy === w.name ? "…" : w.name}
        </button>
      ))}
    </span>
  );
}
