"use client";

/** Labelled select styled for the filter bar. */
export function Select<T extends string | number>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: string) => void;
  options: ReadonlyArray<readonly [T, string]>;
}) {
  return (
    <label className="flex items-center justify-between gap-1.5 md:justify-start">
      <span className="shrink-0 whitespace-nowrap uppercase tracking-wide text-fg-faint">{label}</span>
      <select
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[36px] cursor-pointer rounded-[2px] bg-raised px-2 text-fg outline-none focus:ring-1 focus:ring-accent md:min-h-0 md:px-1 md:py-0.5"
      >
        {options.map(([v, l]) => (
          <option key={String(v)} value={String(v)}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
