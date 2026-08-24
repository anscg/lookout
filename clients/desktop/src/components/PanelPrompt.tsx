import { InfoIcon } from "@phosphor-icons/react";
import { Button, colors, spacing, fontSize, fontWeight, radii } from "@lookout/react";

/**
 * Shown under the video when a program's panel was closed without finishing.
 *
 * Dismissing the sheet has to be free — nobody should feel trapped by a form
 * mid-recording-review. But a program that asked for information usually
 * needs it (a title, a project to credit), and silently dropping the request
 * means the user finds out later that their time went nowhere. So the ask
 * persists here, quietly, until they deal with it.
 */
export function PanelPrompt({
  programLabel,
  onOpen,
}: {
  programLabel: string;
  onOpen: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: spacing.md,
        padding: spacing.md,
        marginBottom: spacing.lg,
        borderRadius: radii.lg,
        border: `1px solid ${colors.border.default}`,
        background: colors.bg.surface,
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: radii.md,
          background: colors.bg.selected,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          color: colors.text.secondary,
        }}
      >
        <InfoIcon size={16} weight="fill" aria-hidden="true" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: fontSize.md,
            fontWeight: fontWeight.medium,
            color: colors.text.primary,
          }}
        >
          {programLabel} needs a few details
        </div>
        <div
          style={{
            fontSize: fontSize.sm,
            color: colors.text.tertiary,
            lineHeight: 1.5,
            marginTop: 2,
          }}
        >
          You closed this earlier. Your timelapse is saved either way, but{" "}
          {programLabel} asked for some information before it can finish up.
        </div>
        <div style={{ marginTop: spacing.md }}>
          <Button variant="secondary" size="sm" onClick={onOpen}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
