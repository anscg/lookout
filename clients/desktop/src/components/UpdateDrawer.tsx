import { useState } from "react";
import { Drawer } from "vaul";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { Button, colors, spacing, fontSize, fontWeight, radii } from "@lookout/react";
import { invoke } from "../logger.js";
import { Sheet, SHEET_CLOSE_SIZE } from "./Sheet.js";
import type { LinuxUpdate } from "../hooks/useLinuxUpdate.js";

interface UpdateDrawerProps {
  update: LinuxUpdate | null;
  open: boolean;
  onClose: () => void;
}

/**
 * Tells a Linux user a new version is out and hands them the exact command for
 * however they installed. No hero and no icon — this is a chore, not an
 * announcement, and it should read as one line of instruction.
 */
export function UpdateDrawer({ update, open, onClose }: UpdateDrawerProps) {
  const [copied, setCopied] = useState(false);

  if (!update) return null;

  const copy = async () => {
    if (!update.command) return;
    try {
      await navigator.clipboard.writeText(update.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      console.error("[update] copy failed:", e);
    }
  };

  const openReleases = async () => {
    try {
      await invoke("open_external_url", { url: update.releasesUrl });
    } catch (e) {
      console.error("[update] failed to open releases:", e);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} ariaLabel={`Lookout ${update.version} is available`}>
      <Drawer.Title
        style={{
          margin: 0,
          fontSize: fontSize.xxl,
          fontWeight: fontWeight.semibold,
          letterSpacing: "-0.36px",
          color: colors.text.primary,
          lineHeight: 1.25,
          // No hero here, so the headline has to clear the X.
          paddingRight: SHEET_CLOSE_SIZE + spacing.sm,
        }}
      >
        A new version of Lookout ({update.version}) is out.
      </Drawer.Title>
      <Drawer.Description
        style={{
          margin: `${spacing.sm}px 0 0`,
          fontSize: fontSize.lg,
          color: colors.text.secondary,
          lineHeight: 1.45,
        }}
      >
        {update.command
          ? "On Linux, Lookout updates through your package manager. Run this to get it:"
          : update.fallback}
      </Drawer.Description>

      {update.command ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.sm,
            width: "100%",
            boxSizing: "border-box",
            marginTop: spacing.lg,
            padding: `${spacing.sm}px ${spacing.md}px`,
            background: colors.bg.sunken,
            border: `1px solid ${colors.border.default}`,
            borderRadius: radii.md,
          }}
        >
          <code
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: fontSize.sm,
              color: colors.text.primary,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              whiteSpace: "nowrap",
              overflowX: "auto",
            }}
          >
            {update.command}
          </code>
          <Button
            variant="secondary"
            size="sm"
            onClick={copy}
            data-vaul-no-drag=""
            style={{ flexShrink: 0, gap: 6 }}
          >
            {copied ? <CheckIcon size={13} weight="bold" /> : <CopyIcon size={13} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={openReleases}
          data-vaul-no-drag=""
          style={{ marginTop: spacing.lg }}
        >
          Open downloads
        </Button>
      )}
    </Sheet>
  );
}
