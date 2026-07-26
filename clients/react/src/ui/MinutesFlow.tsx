import NumberFlow from "@number-flow/react";

export interface MinutesFlowProps {
  /** Whole minutes. */
  minutes: number;
  /** Colour for the numerals and units. */
  color?: string;
}

/**
 * A minute count whose digits animate between values.
 *
 * The kept/removed readouts change continuously while a cut region is
 * dragged, and a hard text swap on every frame reads as flicker. Rolling
 * the digits instead makes the number feel like it's being *adjusted* by
 * the drag, which is exactly what's happening.
 *
 * Splits into hours and minutes past 60 so the unit is always explicit —
 * a bare "83" or an ambiguous "1:23" both invite the wrong reading.
 */
export function MinutesFlow({ minutes, color }: MinutesFlowProps) {
  const safe = Math.max(0, Math.round(minutes));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  const style = { color, fontVariantNumeric: "tabular-nums" as const };

  if (h === 0) {
    return (
      <span style={style}>
        <NumberFlow value={m} />m
      </span>
    );
  }
  return (
    <span style={style}>
      <NumberFlow value={h} />h{" "}
      <NumberFlow value={m} />m
    </span>
  );
}
