/**
 * Liens universels vers les portefeuilles mobiles.
 *
 * POURQUOI CE FICHIER EXISTE. Sur un navigateur mobile ordinaire, aucun
 * portefeuille ne s'enregistre dans la page : le Wallet Standard suppose une
 * extension, et il n'y en a pas sur téléphone. Le seul chemin praticable est
 * d'ouvrir le site depuis le navigateur intégré du portefeuille, où celui-ci
 * s'injecte comme une extension le ferait.
 *
 * Ces liens ne font que ça : rouvrir la page courante ailleurs. Ils ne
 * transportent aucune donnée, ne demandent aucune autorisation, et ne signent
 * rien.
 */

/**
 * Ouvre une URL dans le navigateur intégré de Phantom.
 *
 * Format documenté par Phantom : `https://phantom.app/ul/browse/<url>?ref=<ref>`,
 * les deux paramètres obligatoires et encodés.
 *
 * `encodeURIComponent` et non `encodeURI` : le chemin doit contenir l'URL
 * complète comme une valeur opaque. Avec `encodeURI`, les `?`, `&` et `#` de
 * l'adresse d'origine resteraient tels quels et Phantom les lirait comme sa
 * propre requête, tronquant la destination au premier `?`.
 */
export function phantomBrowseLink(href: string, ref: string): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(ref)}`;
}
