"use client";

import { useEffect, useId, useRef, useState } from "react";
import { fmtAmountInput, parseAmount } from "@/lib/format";

/**
 * Filtre de montant : liste de valeurs proposées **et** saisie libre.
 *
 * `<input list>` + `<datalist>` est le combo natif du navigateur — un seul
 * élément, aucune dépendance, et le clavier fonctionne comme on l'attend. Une
 * liste déroulante maison aurait coûté la gestion du focus, des flèches et de
 * l'échappement pour un résultat moins accessible.
 *
 * La valeur n'est validée qu'à la sortie du champ, sur Entrée, ou après un
 * temps d'inactivité : sans ça, taper « 50000 » déclencherait cinq requêtes,
 * dont quatre sur des montants que l'utilisateur n'a jamais voulus.
 */
export function AmountFilter({
  label,
  value,
  onCommit,
  presets,
  placeholder = "tout",
  debounceMs = 400,
}: {
  label: string;
  value: number | null;
  onCommit: (v: number | null) => void;
  /** Valeurs proposées, en clair. Le champ reste libre. */
  presets: ReadonlyArray<number>;
  placeholder?: string;
  debounceMs?: number;
}) {
  const listId = useId();
  const [text, setText] = useState(() => fmtAmountInput(value));
  const [invalid, setInvalid] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Se resynchronise quand la valeur change ailleurs (réinitialisation des
  // filtres), sans écraser ce que l'utilisateur est en train de taper.
  const committed = useRef(value);
  useEffect(() => {
    if (committed.current !== value) {
      committed.current = value;
      setText(fmtAmountInput(value));
      setInvalid(false);
    }
  }, [value]);

  const commit = (raw: string): void => {
    const parsed = parseAmount(raw);
    if (parsed === undefined) {
      setInvalid(true);
      return; // saisie invalide : on garde la valeur précédente
    }
    setInvalid(false);
    committed.current = parsed;
    onCommit(parsed);
  };

  const onType = (raw: string): void => {
    setText(raw);
    setInvalid(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(raw), debounceMs);
  };

  const flush = (): void => {
    if (timer.current) clearTimeout(timer.current);
    commit(text);
  };

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <label className="flex items-center gap-1.5">
      <span className="uppercase tracking-wide text-fg-faint">{label}</span>
      <input
        list={listId}
        value={text}
        placeholder={placeholder}
        inputMode="decimal"
        onChange={(e) => onType(e.target.value)}
        onBlur={flush}
        onKeyDown={(e) => {
          if (e.key === "Enter") flush();
        }}
        title="Liste déroulante ou saisie libre — 5k, 50 000, 1,5M"
        className={`tnum w-[72px] rounded-[2px] bg-raised px-1 py-0.5 text-fg outline-none focus:ring-1 ${
          invalid ? "ring-1 ring-down" : "focus:ring-accent"
        }`}
      />
      <datalist id={listId}>
        {presets.map((p) => (
          <option key={p} value={fmtAmountInput(p)} />
        ))}
      </datalist>
    </label>
  );
}
