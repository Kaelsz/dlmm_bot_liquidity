/**
 * Suivi de la performance d'une position de liquidité.
 *
 * CE QUE LA CHAÎNE NE DIT PAS : un compte de position porte sa valeur courante
 * et les fees déjà réclamées, mais **jamais le montant déposé**. Le prix de
 * revient n'existe nulle part on-chain. Un ROI de vie entière est donc
 * impossible à reconstituer sans relire l'historique des transactions, ce qui
 * exige un RPC archivistique.
 *
 * D'où ce modèle : on photographie la position à chaque relevé et on calcule à
 * partir de la PREMIÈRE observation. Le résultat est exact pour tout ce qui se
 * passe ensuite, et doit toujours être présenté comme « depuis le … » — le
 * présenter comme un ROI total serait un mensonge.
 *
 * LE PIÈGE, et la raison d'être de `totalShares` : dans une pool DLMM, les
 * montants de tokens changent tout seuls quand le prix traverse les bins — X se
 * convertit en Y sans que personne n'ait rien fait. Comparer les montants pour
 * détecter un dépôt donnerait donc n'importe quoi. Les PARTS de liquidité, en
 * revanche, ne bougent que sur un dépôt ou un retrait réel. C'est elles qu'on
 * suit.
 */

/** Relevé d'une position à un instant donné, déjà valorisé. */
export interface PositionSnapshot {
  ts: number;
  /** Valeur des tokens détenus, hors fees. */
  valueUsd: number;
  /** Fees jamais réclamées, encore dans la position. */
  unclaimedFeeUsd: number;
  /** Cumul des fees déjà retirées de la position. */
  claimedFeeUsd: number;
  /** Somme des parts de liquidité. Ne varie que sur un dépôt/retrait. */
  totalShares: number;
}

/** État accumulé d'une position entre deux relevés. */
export interface PositionTracking {
  firstSeenAt: number;
  /** Capital engagé : première observation, plus les apports ultérieurs. */
  depositedUsd: number;
  /** Valeur retirée en cours de route. */
  withdrawnUsd: number;
  totalShares: number;
}

/** Une variation de parts sous ce seuil relatif est du bruit d'arrondi. */
const SHARE_EPSILON = 1e-6;

/** Première observation : elle fixe le prix de revient. */
export function beginTracking(s: PositionSnapshot): PositionTracking {
  return {
    firstSeenAt: s.ts,
    depositedUsd: s.valueUsd,
    withdrawnUsd: 0,
    totalShares: s.totalShares,
  };
}

/**
 * Intègre un nouveau relevé.
 *
 * Une hausse des parts est un apport, une baisse un retrait. Le montant est
 * estimé au prorata : la valeur par part au moment du relevé multipliée par la
 * variation de parts. C'est exact tant que le relevé suit de près l'opération,
 * ce que garantit une collecte à la minute.
 */
export function applySnapshot(
  t: PositionTracking,
  s: PositionSnapshot,
): PositionTracking {
  const prevShares = t.totalShares;
  if (prevShares <= 0 || s.totalShares <= 0) {
    return { ...t, totalShares: s.totalShares };
  }

  const delta = s.totalShares - prevShares;
  if (Math.abs(delta) / prevShares < SHARE_EPSILON) {
    return { ...t, totalShares: s.totalShares };
  }

  // Valeur par part APRÈS l'opération : c'est la seule que le relevé observe.
  const perShare = s.valueUsd / s.totalShares;
  const moved = Math.abs(delta) * perShare;

  return delta > 0
    ? { ...t, depositedUsd: t.depositedUsd + moved, totalShares: s.totalShares }
    : { ...t, withdrawnUsd: t.withdrawnUsd + moved, totalShares: s.totalShares };
}

export interface PositionRoi {
  /** Gain net en dollars depuis la première observation. */
  pnlUsd: number;
  /** Rapporté au capital engagé. `null` si aucun capital n'a été engagé. */
  roiPct: number | null;
  /** Part du gain qui vient des fees — le reste est mouvement de prix. */
  feeUsd: number;
  depositedUsd: number;
  since: number;
}

/**
 * Performance depuis la première observation.
 *
 * Tout ce qui est sorti (retraits, fees réclamées) plus tout ce qui reste
 * (valeur courante, fees dues), moins ce qui est entré.
 */
export function computeRoi(t: PositionTracking, s: PositionSnapshot): PositionRoi {
  const feeUsd = s.claimedFeeUsd + s.unclaimedFeeUsd;
  const out = s.valueUsd + feeUsd + t.withdrawnUsd;
  const pnlUsd = out - t.depositedUsd;
  return {
    pnlUsd,
    roiPct: t.depositedUsd > 0 ? (pnlUsd / t.depositedUsd) * 100 : null,
    feeUsd,
    depositedUsd: t.depositedUsd,
    since: t.firstSeenAt,
  };
}

/** Où se trouve le prix à l'intérieur de la plage d'une position. */
export interface RangeCursor {
  /** 0 = borne basse, 1 = borne haute. Toujours dans [0, 1], même hors plage. */
  ratio: number;
  /** Côté par lequel le prix est sorti. `null` tant qu'il est dans la plage. */
  outside: "below" | "above" | null;
  /** Encore dedans, mais assez près d'un bord pour que la sortie soit imminente. */
  nearEdge: boolean;
}

/**
 * Sous cette fraction de la largeur de la plage, un bord est « proche ».
 *
 * C'est l'avertissement qui manquait : « dans la plage » se disait de la même
 * façon au centre et à un bin de la sortie, alors que ce sont deux situations
 * opposées.
 */
export const NEAR_EDGE_FRACTION = 0.1;

/**
 * Place le bin actif dans la plage `[lower, upper]`.
 *
 * Le calcul est fait en **identifiants de bin**, pas en prix : la liquidité est
 * répartie bin par bin, donc une barre linéaire en bins est fidèle, alors que le
 * prix est géométrique et déplacerait le curseur.
 *
 * La plage d'un seul bin (`upper === lower`) n'a pas de largeur : le curseur va
 * au centre, et le bord est déclaré proche — ce qui est exact, puisque le
 * moindre mouvement fait sortir.
 */
export function rangeCursor(lower: number, upper: number, active: number): RangeCursor {
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(active)) {
    return { ratio: 0.5, outside: null, nearEdge: false };
  }
  const lo = Math.min(lower, upper);
  const hi = Math.max(lower, upper);
  const width = hi - lo;

  if (active < lo) return { ratio: 0, outside: "below", nearEdge: false };
  if (active > hi) return { ratio: 1, outside: "above", nearEdge: false };
  if (width <= 0) return { ratio: 0.5, outside: null, nearEdge: true };

  const ratio = (active - lo) / width;
  return {
    ratio,
    outside: null,
    nearEdge: Math.min(ratio, 1 - ratio) < NEAR_EDGE_FRACTION,
  };
}

/**
 * Position disparue du relevé : elle a été fermée.
 *
 * La valeur restante bascule en retrait, ce qui fige le ROI sur son dernier
 * état connu au lieu de le faire tomber à −100 % parce que la position ne vaut
 * plus rien.
 */
export function closeTracking(
  t: PositionTracking,
  last: PositionSnapshot,
): PositionTracking {
  return {
    ...t,
    withdrawnUsd: t.withdrawnUsd + last.valueUsd,
    totalShares: 0,
  };
}
