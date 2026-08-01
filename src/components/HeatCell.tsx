"use client";

import { heatTier, type HeatTier } from "@/data/metrics";
import { fmtPct } from "@/lib/format";

/**
 * The hero cell. Heat is fees paid out per hour as a percentage of TVL, so it
 * is comparable across pools of any size — a $30k pool and a $3M pool sit on
 * the same scale.
 *
 * The whole cell is tinted rather than just the text: at 28px rows the block
 * of colour is what makes a hot pool findable while scrolling, and the tiers
 * are wide enough that neighbouring rows are visibly different.
 */
const TIER_CLASS: Record<HeatTier, string> = {
  inert: "bg-heat-inert-bg text-heat-inert-fg",
  cool: "bg-heat-cool-bg text-heat-cool-fg",
  warm: "bg-heat-warm-bg text-heat-warm-fg",
  hot: "bg-heat-hot-bg text-heat-hot-fg",
  blazing: "bg-heat-blazing-bg text-heat-blazing-fg",
  nuclear: "bg-heat-nuclear-bg text-heat-nuclear-fg nuclear-pulse",
};

const TIER_LABEL: Record<HeatTier, string> = {
  inert: "inerte",
  cool: "tiède",
  warm: "chaud",
  hot: "très chaud",
  blazing: "brûlant",
  nuclear: "extrême",
};

export function HeatCell({ value }: { value: number }) {
  const tier = heatTier(value);
  return (
    <div
      title={`${TIER_LABEL[tier]} — ${value.toFixed(2)} % du TVL versé en fees par heure`}
      className={`tnum flex h-[22px] items-center justify-end rounded-[3px] px-1.5 font-semibold transition-colors duration-500 ${TIER_CLASS[tier]}`}
    >
      {fmtPct(value, 1)}
    </div>
  );
}
