import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { colors, spacing, fontSize, fontWeight, radii } from "@lookout/react";
import { invoke } from "../logger.js";

/**
 * "Open in Lapse ↗" — a link out to the program's own page for this session.
 *
 * A timelapse recorded through Lookout usually has a home somewhere else: the
 * program that asked for it. Without this, getting back there means finding
 * the program's site and hunting for the right entry. The link only appears
 * when the program has actually published one (`viewUrl` on the session), so
 * nothing here implies a destination that doesn't exist.
 *
 * Opens in the real browser, deliberately — this is the program's whole site,
 * not the single-purpose form a panel renders in-app.
 */
export function OpenInProgram({
  programLabel,
  url,
}: {
  programLabel: string;
  url: string;
}) {
  return (
    <button
      type="button"
      title={`Open in ${programLabel}`}
      onClick={() => {
        invoke("open_external_url", { url }).catch((e) =>
          console.error("[session] open-in-program failed:", e),
        );
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: spacing.xs,
        maxWidth: 180,
        padding: `4px ${spacing.sm}px`,
        borderRadius: radii.md,
        border: `1px solid ${colors.border.default}`,
        background: "transparent",
        color: colors.text.secondary,
        fontFamily: "inherit",
        fontSize: fontSize.xs,
        fontWeight: fontWeight.medium,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        Open in {programLabel}
      </span>
      <ArrowSquareOutIcon size={12} weight="bold" aria-hidden="true" style={{ flexShrink: 0 }} />
    </button>
  );
}
