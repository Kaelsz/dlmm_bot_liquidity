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
    <label className="flex items-center gap-1.5">
      <span className="uppercase tracking-wide text-fg-faint">{label}</span>
      <select
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer rounded-[2px] bg-raised px-1 py-0.5 text-fg outline-none focus:ring-1 focus:ring-accent"
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
