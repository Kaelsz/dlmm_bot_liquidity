"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getWallets } from "@wallet-standard/app";
import { phantomBrowseLink } from "@/lib/deeplink";


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
 * lire des positions n'exige aucune signature.
 *
 * Sur téléphone il n'y a pas d'extension, donc rien à détecter : <NoWallet>
 * renvoie alors vers le navigateur intégré du portefeuille, seul endroit où la
 * connexion est possible depuis un mobile.
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
 * Ce qu'on affiche quand aucun portefeuille ne s'est enregistré.
 *
 * SUR TÉLÉPHONE, CE N'EST PAS UNE ERREUR, C'EST LA NORME. Le Wallet Standard
 * suppose une extension de navigateur ; il n'y en a pas sur mobile, donc la
 * liste est vide sur Safari comme sur Chrome. Le chemin qui marche est d'ouvrir
 * le site depuis le navigateur intégré du portefeuille, où celui-ci s'injecte
 * exactement comme une extension.
 *
 * L'ancien message disait « colle ton adresse ci-dessous ». C'était vrai dans
 * la vue Positions, où coller une adresse donne la lecture seule — mais ça
 * présentait un repli comme le seul chemin, et surtout c'était faux dans le
 * panneau de détail d'une pool : il n'y a pas de champ d'adresse à cet endroit,
 * et une adresse ne permet de toute façon pas de signer. La mention disparaît
 * sans rien coûter : le champ de la vue Positions porte déjà le placeholder
 * « ou colle une adresse de wallet ».
 */
function NoWallet() {
  // `null` tant que l'effet n'a pas tourné : `PositionsView` est rendu côté
  // serveur, où `window` n'existe pas. Lire le média au rendu ferait diverger
  // l'arbre serveur de l'arbre client et React jetterait le HTML — même motif
  // que l'horloge de <MarketTable>.
  const [env, setEnv] = useState<{ touch: boolean; href: string; deeplink: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const href = window.location.href;
    setEnv({
      // `(pointer: coarse)` plutôt qu'un reniflage d'userAgent : on teste ce
      // dont dépend la réponse — un doigt, donc pas d'extension possible.
      touch: window.matchMedia("(pointer: coarse)").matches,
      href,
      deeplink: phantomBrowseLink(href, window.location.origin),
    });
  }, []);

  if (env === null) return null;

  if (!env.touch) {
    return (
      <span className="text-fg-faint">
        Aucun portefeuille détecté — installe Phantom, Jupiter ou Solflare dans ce navigateur.
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <a
        href={env.deeplink}
        className="flex min-h-[44px] items-center rounded-[3px] bg-raised px-3 text-accent active:bg-hover"
      >
        Ouvrir dans Phantom
      </a>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(env.href);
            setCopied(true);
            setTimeout(() => setCopied(false), 2_000);
          } catch {
            // Presse-papiers refusé (contexte non sécurisé, permission) : le
            // bouton ne doit pas mentir en affichant « copié ».
            setCopied(false);
          }
        }}
        className="min-h-[44px] rounded-[3px] px-3 text-fg-faint active:text-fg"
      >
        {copied ? "lien copié" : "Copier le lien"}
      </button>
      <span className="text-[10px] leading-snug text-fg-faint">
        Sur téléphone, un portefeuille ne peut se connecter que depuis son propre navigateur
        intégré. Colle le lien dans celui de Jupiter Mobile ou d&apos;un autre portefeuille.
      </span>
    </span>
  );
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

  if (wallets.length === 0) return <NoWallet />;

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

/**
 * Le portefeuille connecté, partagé par toute l'application.
 *
 * Il vivait dans l'état local de la vue Positions, ce qui suffisait tant que le
 * Zap Out était la seule action signée. Ouvrir une position se fait depuis le
 * panneau de détail d'une pool, qui s'ouvre aussi bien depuis la vue Marché :
 * sans contexte, il aurait fallu passer le portefeuille de main en main à
 * travers deux arbres de composants, ou le connecter deux fois.
 *
 * Rien n'est persisté ici. Une reconnexion au rechargement de la page serait
 * une décision à part entière — le portefeuille redemande son accord, et c'est
 * bien ainsi.
 */
const WalletContext = createContext<{
  wallet: ConnectedWallet | null;
  setWallet: (w: ConnectedWallet | null) => void;
}>({ wallet: null, setWallet: () => {} });

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const value = useMemo(() => ({ wallet, setWallet }), [wallet]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useConnectedWallet(): ConnectedWallet | null {
  return useContext(WalletContext).wallet;
}

/** Boutons de connexion branchés sur le contexte, pour les vues qui n'ont pas
 *  besoin de savoir ce qu'elles font du résultat. */
export function WalletBar({ onError }: { onError?: (m: string) => void }) {
  const { wallet, setWallet } = useContext(WalletContext);
  const handle = useCallback((w: ConnectedWallet) => setWallet(w), [setWallet]);
  if (wallet) {
    return (
      <span className="flex items-center gap-1.5 text-fg-faint">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wallet.icon} alt="" className="h-4 w-4 rounded-[2px]" />
        <span className="tnum">
          {wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}
        </span>
      </span>
    );
  }
  return <WalletButtons onConnected={handle} onError={onError ?? (() => {})} />;
}
