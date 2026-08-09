"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  COLUMNS,
  STORAGE_KEY,
  defaultColumns,
  parseColumns,
  serializeColumns,
  type ColumnKey,
} from "@/lib/columns";

/**
 * Sélection des colonnes, retenue par appareil.
 *
 * Le stockage est local au navigateur, donc la vue du téléphone et celle du PC
 * sont indépendantes sans qu'aucun code n'ait à les distinguer — c'est
 * exactement ce qu'on veut : on ne consulte pas les mêmes chiffres au bureau et
 * dans la rue.
 *
 * `null` tant que l'effet n'a pas tourné : la page est rendue côté serveur, où
 * ni `localStorage` ni `matchMedia` n'existent. Lire l'un des deux au rendu
 * ferait diverger l'arbre serveur de l'arbre client et React jetterait le HTML.
 * Même motif que l'horloge de <MarketTable>.
 */
export function useColumns(): {
  visible: ReadonlySet<ColumnKey> | null;
  toggle: (k: ColumnKey) => void;
  reset: () => void;
} {
  const [visible, setVisible] = useState<Set<ColumnKey> | null>(null);
  const coarse = useRef(false);

  useEffect(() => {
    coarse.current = window.matchMedia("(pointer: coarse)").matches;
    setVisible(parseColumns(localStorage.getItem(STORAGE_KEY), coarse.current));
  }, []);

  const persist = useCallback((next: Set<ColumnKey>) => {
    setVisible(next);
    try {
      localStorage.setItem(STORAGE_KEY, serializeColumns(next));
    } catch {
      // Mode privé ou quota plein : la sélection vaut pour la session, ce qui
      // est préférable à un clic qui ne fait rien.
    }
  }, []);

  const toggle = useCallback(
    (k: ColumnKey) => {
      setVisible((cur) => {
        if (!cur) return cur;
        const next = new Set(cur);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        try {
          localStorage.setItem(STORAGE_KEY, serializeColumns(next));
        } catch {
          /* voir persist */
        }
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => persist(defaultColumns(coarse.current)), [persist]);

  return { visible, toggle, reset };
}

export function ColumnPicker({
  visible,
  onToggle,
  onReset,
}: {
  visible: ReadonlySet<ColumnKey>;
  onToggle: (k: ColumnKey) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Fermeture au clic extérieur et à Échap : un panneau qui recouvre le
  // tableau et ne se ferme qu'en recliquant sur son bouton est une gêne.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hidden = COLUMNS.filter((c) => !c.locked && !visible.has(c.key)).length;

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="min-h-[40px] rounded-[2px] bg-raised px-2.5 text-[12px] text-fg-dim hover:text-fg md:min-h-0 md:py-0.5 md:text-[11px]"
      >
        Colonnes{hidden > 0 ? ` (${hidden} masquée${hidden > 1 ? "s" : ""})` : ""}
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-[70vh] w-[220px] overflow-y-auto rounded-[3px] border border-line-strong bg-surface p-1.5 shadow-2xl">
          {COLUMNS.map((c) => (
            <label
              key={c.key}
              className={`flex min-h-[36px] items-center gap-2 rounded-[2px] px-1.5 text-[12px] md:min-h-[26px] md:text-[11px] ${
                c.locked ? "text-fg-faint" : "cursor-pointer text-fg-dim hover:bg-raised hover:text-fg"
              }`}
              title={c.locked ? "colonne indispensable" : undefined}
            >
              <input
                type="checkbox"
                checked={visible.has(c.key)}
                disabled={c.locked}
                onChange={() => onToggle(c.key)}
                className="accent-[var(--color-accent)]"
              />
              {c.label}
            </label>
          ))}
          <button
            onClick={onReset}
            className="mt-1 w-full rounded-[2px] px-1.5 py-1.5 text-left text-[11px] text-fg-faint hover:text-fg"
          >
            Tout réafficher
          </button>
        </div>
      ) : null}
    </div>
  );
}
