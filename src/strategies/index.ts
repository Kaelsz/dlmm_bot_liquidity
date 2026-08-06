/**
 * Stratégies d'ouverture de position.
 *
 * POURQUOI UNE COUCHE À PART. Une stratégie ne fait qu'une chose : décider
 * **quels bins** recevoir la liquidité, et **de quel côté**. Le SDK Meteora
 * réduit ça à trois champs (`minBinId`, `maxBinId`, `strategyType`) — donc une
 * stratégie est une fonction pure, sans connexion RPC, sans compte, sans clé.
 * C'est ce qui la rend testable sans toucher à la chaîne, et c'est ce qui
 * permettra d'en ajouter d'autres (Curve, Bid-Ask, plages plus larges) sans
 * rouvrir `src/chain/openposition.ts`.
 *
 * Le nombre de bins n'est PAS une contrainte technique ici. `POSITION_MAX_LENGTH`
 * vaut 1400 dans le SDK ; 70 est simplement `DEFAULT_BIN_PER_POSITION`, qui
 * coïncide avec `MAX_BIN_ARRAY_SIZE` — une position sur 70 bins tient donc dans
 * un seul bin array. Et le plafond `MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX = 26` ne
 * s'applique qu'au chemin `ByWeight`, pas à `ByStrategy` qu'on utilise : celui-ci
 * encode la stratégie, pas les montants bin par bin, donc sa transaction ne
 * grossit pas avec le nombre de bins.
 */

/** Les trois formes de répartition connues du programme DLMM. */
export const STRATEGY_TYPE = { Spot: 0, Curve: 1, BidAsk: 2 } as const;
export type StrategyTypeId = (typeof STRATEGY_TYPE)[keyof typeof STRATEGY_TYPE];

/** Ce que la stratégie a besoin de savoir de la pool. Rien de plus. */
export interface StrategyInput {
  /** Bin où se trouve le prix maintenant. */
  activeBinId: number;
  /**
   * SOL est-il le token X de la pool ?
   *
   * Meteora ne normalise pas l'ordre des tokens : SOL est tantôt X, tantôt Y.
   * Or le sens géométrique d'un dépôt en dépend entièrement (voir plus bas),
   * donc aucune stratégie ne peut se permettre de le supposer.
   */
  solIsX: boolean;
}

/** La décision, prête à être traduite en paramètres SDK. */
export interface StrategyPlan {
  minBinId: number;
  maxBinId: number;
  strategyType: StrategyTypeId;
  /** Côté de la pool qui reçoit le dépôt. L'autre reçoit zéro. */
  depositSide: "x" | "y";
  /**
   * Dans le bin actif — le seul qui puisse contenir les deux tokens — quel
   * token privilégier. Doit suivre `depositSide`, sinon le bin actif serait
   * alimenté dans une devise qu'on ne dépose pas.
   */
  singleSidedX: boolean;
  binCount: number;
}

export interface Strategy {
  id: string;
  label: string;
  /** Une phrase, affichée avant signature : l'utilisateur engage de l'argent. */
  description: string;
  plan(input: StrategyInput): StrategyPlan;
}

/** Largeur retenue pour la première stratégie. */
export const SPOT_BINS = 70;

/**
 * Spot, 70 bins, alimentée en SOL uniquement.
 *
 * LE POINT QUI COMPTE, et la raison pour laquelle `solIsX` existe. Dans une
 * pool DLMM, les bins SOUS le bin actif ne contiennent que du Y, ceux AU-DESSUS
 * que du X. Déposer un seul token contraint donc le côté de la plage :
 *
 *   - SOL est Y (cas courant, paire TOKEN-SOL) → la plage descend :
 *     `[actif − 69, actif]`. Le prix du token baisse, le bin actif traverse la
 *     plage vers le bas, et le SOL se convertit en token.
 *   - SOL est X (paire SOL-TOKEN) → la plage monte : `[actif, actif + 69]`.
 *     Le prix de SOL exprimé en token monte, donc le token se déprécie face au
 *     SOL, et le bin actif traverse la plage vers le haut en convertissant le
 *     SOL en token.
 *
 * La géométrie s'inverse, mais l'économie est la même dans les deux cas :
 * **on accumule le token à mesure qu'il devient moins cher**. C'est une entrée
 * en accumulation, pas une position équilibrée.
 *
 * Conséquence à assumer et à afficher : tant que le prix ne vient pas dans la
 * plage, la position ne perçoit presque rien. Le bin actif est à une extrémité,
 * pas au centre.
 */
export const spot70SolSided: Strategy = {
  id: "spot70-sol",
  label: "Spot 70 bins, SOL",
  description:
    "Dépôt en SOL seul, réparti uniformément sur 70 bins du côté où le token devient moins cher. " +
    "Le SOL se convertit en token au fil de la baisse. Tant que le prix ne rentre pas dans la plage, " +
    "la position ne perçoit quasiment pas de fees.",
  plan({ activeBinId, solIsX }) {
    const span = SPOT_BINS - 1;
    return solIsX
      ? {
          minBinId: activeBinId,
          maxBinId: activeBinId + span,
          strategyType: STRATEGY_TYPE.Spot,
          depositSide: "x",
          singleSidedX: true,
          binCount: SPOT_BINS,
        }
      : {
          minBinId: activeBinId - span,
          maxBinId: activeBinId,
          strategyType: STRATEGY_TYPE.Spot,
          depositSide: "y",
          singleSidedX: false,
          binCount: SPOT_BINS,
        };
  },
};

const ALL: Strategy[] = [spot70SolSided];

export const STRATEGIES: ReadonlyArray<Strategy> = ALL;

export function strategyById(id: string): Strategy | undefined {
  return ALL.find((s) => s.id === id);
}
