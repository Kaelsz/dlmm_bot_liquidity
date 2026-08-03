"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A numeric cell that briefly tints when its underlying value changes.
 *
 * The tint is the only motion in the table: rows never reflow, so the eye can
 * stay on a column and still notice which pools just moved. The comparison is
 * on the raw number rather than the formatted string, so a change hidden by
 * rounding does not produce a phantom flash.
 */
export function Num({
  value,
  format,
  className = "",
  align = "right",
  flash = true,
  title,
}: {
  value: number | null | undefined;
  format: (v: number | null | undefined) => string;
  className?: string;
  align?: "left" | "right";
  flash?: boolean;
  title?: string;
}) {
  const prev = useRef<number | null | undefined>(value);
  const [dir, setDir] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (!flash) return;
    const before = prev.current;
    prev.current = value;
    if (before === undefined || before === null || value === undefined || value === null) return;
    if (value === before) return;
    setDir(value > before ? "up" : "down");
    const t = setTimeout(() => setDir(null), 440);
    return () => clearTimeout(t);
  }, [value, flash]);

  return (
    <span
      title={title}
      className={`tnum inline-block w-full ${align === "right" ? "text-right" : "text-left"} ${
        dir === "up" ? "flash-up" : dir === "down" ? "flash-down" : ""
      } ${className}`}
    >
      {format(value)}
    </span>
  );
}

/** Signed value coloured by direction — used for acceleration. */
export function SignedNum({
  value,
  format,
  className = "",
}: {
  value: number | null | undefined;
  format: (v: number | null | undefined) => string;
  className?: string;
}) {
  const sign = value === null || value === undefined || !Number.isFinite(value) ? 0 : Math.sign(value);
  const colour = sign > 0 ? "text-up" : sign < 0 ? "text-down" : "text-fg-faint";
  return (
    <span className={`tnum inline-block w-full text-right ${colour} ${className}`}>
      {sign > 0 ? "▲" : sign < 0 ? "▼" : "·"}
      <span className="ml-0.5">{format(value)}</span>
    </span>
  );
}

/**
 * Enrobe une valeur dérivée dont la fenêtre n'est pas encore remplie.
 *
 * Choix explicite : on affiche tôt plutôt que de masquer, mais on marque —
 * opacité réduite et infobulle disant sur quoi repose l'estimation. Un chiffre
 * fondé sur une seule mise à jour du compteur ne doit pas se lire comme un
 * chiffre étayé par cinq.
 */
export function Tentative({
  low,
  spanMs,
  updates,
  children,
}: {
  low: boolean;
  spanMs: number;
  updates: number;
  children: React.ReactNode;
}) {
  if (!low) return <>{children}</>;
  const secs = Math.round(spanMs / 1000);
  return (
    <span
      className="opacity-40"
      title={`estimation peu étayée : ${secs} s d'historique, ${updates} mise${updates > 1 ? "s" : ""} à jour du compteur`}
    >
      {children}
    </span>
  );
}
