import NumberFlow from "@number-flow/react";
import { colors, fontSize, fontWeight } from "./theme.js";

export interface ProgressRingProps {
  /** 0–1. Values outside are clamped. */
  progress: number;
  size?: number;
  strokeWidth?: number;
  /** Percentage shown in the centre, with rolling digits. Omit for a
   *  bare ring. */
  showPercent?: boolean;
  color?: string;
}

/**
 * Determinate circular progress. Used where a spinner would under-inform —
 * a long wait the user is standing in front of, like a timelapse compile.
 */
export function ProgressRing({
  progress,
  size = 72,
  strokeWidth = 5,
  showPercent = false,
  color,
}: ProgressRingProps) {
  const clamped = Math.max(0, Math.min(1, progress));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped);

  return (
    <div
      style={{ position: "relative", width: size, height: size, flexShrink: 0 }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <svg width={size} height={size} style={{ display: "block", transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={colors.spinner.base}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color ?? colors.status.info}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          // Matches the ~200ms tick of the estimator so the ring glides
          // rather than stepping.
          style={{ transition: "stroke-dashoffset 0.25s linear" }}
        />
      </svg>
      {showPercent && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: fontSize.md,
            fontWeight: fontWeight.semibold,
            color: colors.text.secondary,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <NumberFlow value={Math.min(99, Math.floor(clamped * 100))} />%
        </div>
      )}
    </div>
  );
}
