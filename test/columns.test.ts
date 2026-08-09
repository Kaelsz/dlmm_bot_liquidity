import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  COLUMN_KEYS,
  defaultColumns,
  parseColumns,
  serializeColumns,
  tableMinWidth,
  type ColumnKey,
} from "../src/lib/columns";

describe("colonnes de la vue Marché", () => {
  it("propose tout sur souris, un jeu allégé au doigt", () => {
    expect(defaultColumns(false).size).toBe(COLUMN_KEYS.length);
    expect(defaultColumns(true).size).toBeLessThan(COLUMN_KEYS.length);
  });

  it("garde toujours les colonnes verrouillées, quel que soit l'appareil", () => {
    const locked = COLUMNS.filter((c) => c.locked).map((c) => c.key);
    expect(locked.length).toBeGreaterThan(0);
    for (const k of locked) {
      expect(defaultColumns(true).has(k)).toBe(true);
      expect(defaultColumns(false).has(k)).toBe(true);
    }
  });

  it("fait un aller-retour fidèle par le stockage", () => {
    const chosen = new Set<ColumnKey>(["pool", "heat", "rate", "tvl"]);
    expect(parseColumns(serializeColumns(chosen), false)).toEqual(chosen);
  });

  it("sérialise dans l'ordre des colonnes, pas dans celui des clics", () => {
    const a = serializeColumns(new Set<ColumnKey>(["tvl", "heat", "pool"]));
    const b = serializeColumns(new Set<ColumnKey>(["pool", "heat", "tvl"]));
    expect(a).toBe(b);
  });

  it("ignore une clé inconnue plutôt que de tout jeter", () => {
    const v = parseColumns(JSON.stringify(["pool", "heat", "colonne-disparue", "tvl"]), false);
    expect(v.has("heat")).toBe(true);
    expect(v.has("tvl")).toBe(true);
    expect([...v]).not.toContain("colonne-disparue");
  });

  it("réinjecte une colonne verrouillée absente du stockage", () => {
    const v = parseColumns(JSON.stringify(["heat", "tvl"]), false);
    for (const c of COLUMNS.filter((c) => c.locked)) expect(v.has(c.key)).toBe(true);
  });

  it("retombe sur le défaut sur stockage vide, illisible ou tout décoché", () => {
    for (const raw of [null, "", "pas du json", "{}", "[]", JSON.stringify(["pool"])]) {
      expect(parseColumns(raw, false).size).toBe(COLUMN_KEYS.length);
    }
  });

  it("calcule la largeur minimale sur les seules colonnes visibles", () => {
    const all = tableMinWidth(defaultColumns(false));
    expect(all).toBe(COLUMNS.reduce((s, c) => s + c.width, 0));
    const few = tableMinWidth(new Set<ColumnKey>(["pool", "heat"]));
    expect(few).toBe(190 + 92);
    // Masquer des colonnes doit réduire la largeur : c'est ce qui évite au
    // tableau d'être compressé et au texte de passer sur deux lignes.
    expect(few).toBeLessThan(all);
  });

  it("n'a ni doublon ni clé orpheline", () => {
    expect(COLUMNS.map((c) => c.key).sort()).toEqual([...COLUMN_KEYS].sort());
  });
});
