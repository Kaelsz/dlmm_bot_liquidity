import { describe, expect, it } from "vitest";
import { phantomBrowseLink } from "../src/lib/deeplink";

const SITE = "https://radar.exemple.fr";

describe("lien universel Phantom", () => {
  it("respecte le format documenté", () => {
    expect(phantomBrowseLink(SITE, SITE)).toBe(
      "https://phantom.app/ul/browse/https%3A%2F%2Fradar.exemple.fr?ref=https%3A%2F%2Fradar.exemple.fr",
    );
  });

  it("encode la requête, sinon Phantom tronquerait la destination", () => {
    // C'est le cas qui casse avec encodeURI : le `?` de l'adresse d'origine
    // serait lu comme le début de la requête de Phantom.
    const link = phantomBrowseLink(`${SITE}/?minTvl=5000&sort=heat`, SITE);
    expect(link).toContain("%3FminTvl%3D5000%26sort%3Dheat");
    // Un seul « ? » dans le lien final : celui de Phantom.
    expect(link.split("?")).toHaveLength(2);
  });

  it("encode le fragment", () => {
    expect(phantomBrowseLink(`${SITE}/positions#ouvertes`, SITE)).toContain("%23ouvertes");
  });

  it("n'abîme pas une adresse contenant déjà des séquences encodées", () => {
    // Le double encodage est voulu : Phantom décode une fois, et doit
    // retrouver l'adresse exacte, %20 compris.
    const link = phantomBrowseLink(`${SITE}/p?q=a%20b`, SITE);
    expect(link).toContain("a%2520b");
    expect(decodeURIComponent(link.slice("https://phantom.app/ul/browse/".length).split("?")[0]!)).toBe(
      `${SITE}/p?q=a%20b`,
    );
  });

  it("accepte une origine distincte de la page", () => {
    const link = phantomBrowseLink(`${SITE}/positions`, SITE);
    expect(link.endsWith(`?ref=${encodeURIComponent(SITE)}`)).toBe(true);
  });
});
