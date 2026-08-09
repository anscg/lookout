/**
 * The dialog that comes up when a capture fails.
 *
 * Capture errors used to land in a card titled "Failed to detect displays"
 * holding a raw D-Bus string — a title that was wrong for portal failures
 * (nothing was ever detected) attached to text nobody outside the project
 * can act on. This puts the failure in front of the user as a modal, and
 * where the cause is a known one, leads with what to install rather than
 * what threw.
 *
 * The raw error never disappears — it moves below the fold, next to a Copy
 * button that puts the error, the environment probe and the log on the
 * clipboard in one go.
 */

import { useEffect, useState } from "react";
import { Button, Overlay, colors, spacing, radii, fontSize, fontWeight } from "@lookout/react";
import { invoke } from "../logger.js";
import {
  buildCaptureReport,
  diagnoseCaptureError,
  type CaptureDiagnosis,
  type CaptureEnvironment,
} from "../captureDiagnosis.js";

interface CaptureErrorDialogProps {
  /** The raw error text. Shown verbatim, always. */
  error: string;
  /** Overrides the title when nothing matched — e.g. "Couldn't list screens". */
  fallbackTitle?: string;
  /** Runs the thing that failed again, and closes on success. */
  onRetry?: () => void;
  onDismiss: () => void;
}

/** How long the Copy buttons stay in their confirmed state. */
const COPIED_MS = 1600;

function useCopyButton(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return [
    copied,
    (text: string) => {
      navigator.clipboard.writeText(text).then(
        () => setCopied(true),
        // A clipboard the webview won't give us is not worth a second error
        // dialog on top of this one.
        () => {},
      );
    },
  ];
}

export function CaptureErrorDialog({ error, fallbackTitle, onRetry, onDismiss }: CaptureErrorDialogProps) {
  const [env, setEnv] = useState<CaptureEnvironment | null>(null);
  const [probed, setProbed] = useState(false);
  const [copiedReport, copyReport] = useCopyButton();
  const [copiedCommand, copyCommand] = useCopyButton();

  // The probe talks to D-Bus, so it only runs once something has already
  // gone wrong. Until it answers, diagnosis falls back to matching the
  // error text alone — which is why the dialog renders immediately rather
  // than waiting behind a spinner.
  useEffect(() => {
    let live = true;
    invoke<CaptureEnvironment>("capture_environment")
      .then((result) => {
        if (live) setEnv(result);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setProbed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const diagnosis: CaptureDiagnosis | null = diagnoseCaptureError(error, env);
  const title = diagnosis?.title ?? fallbackTitle ?? "Screen capture failed";

  return (
    <Overlay label={title} width="min(460px, 92vw)" onDismiss={onDismiss}>
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto", padding: spacing.xxl, gap: spacing.lg }}>
        <div>
          <h2 style={{ margin: 0, fontSize: fontSize.xxl, fontWeight: fontWeight.semibold, color: colors.text.primary }}>
            {title}
          </h2>
          <p style={{ margin: `${spacing.sm}px 0 0 0`, fontSize: fontSize.lg, lineHeight: 1.5, color: colors.text.secondary }}>
            {diagnosis?.summary ??
              (probed
                ? "Something in the capture path failed and we couldn't place it. The details below are worth sending along."
                : "Checking what this system has installed…")}
          </p>
        </div>

        {diagnosis && (
          <ol style={{ margin: 0, paddingLeft: spacing.xl, display: "flex", flexDirection: "column", gap: spacing.sm }}>
            {diagnosis.steps.map((step, i) => (
              <li key={i} style={{ fontSize: fontSize.lg, lineHeight: 1.5, color: colors.text.primary }}>
                {step}
              </li>
            ))}
          </ol>
        )}

        {diagnosis?.command && (
          <div style={{
            display: "flex", alignItems: "center", gap: spacing.sm,
            background: colors.bg.sunken, border: `1px solid ${colors.border.default}`,
            borderRadius: radii.md, padding: `${spacing.sm}px ${spacing.sm}px ${spacing.sm}px ${spacing.md}px`,
          }}>
            <code style={{
              flex: 1, minWidth: 0, fontFamily: "monospace", fontSize: fontSize.md,
              color: colors.text.primary, overflowX: "auto", whiteSpace: "pre",
            }}>
              {diagnosis.command}
            </code>
            <Button variant="secondary" size="sm" onClick={() => copyCommand(diagnosis.command!)} style={{ flexShrink: 0 }}>
              {copiedCommand ? "Copied" : "Copy"}
            </Button>
          </div>
        )}

        <details>
          <summary style={{ cursor: "pointer", fontSize: fontSize.md, color: colors.text.tertiary, userSelect: "none" }}>
            Technical details
          </summary>
          <pre style={{
            margin: `${spacing.sm}px 0 0 0`, padding: spacing.md,
            background: colors.bg.sunken, borderRadius: radii.md,
            fontFamily: "monospace", fontSize: fontSize.xs, lineHeight: 1.5,
            color: colors.text.error, whiteSpace: "pre-wrap", wordBreak: "break-word",
            maxHeight: 160, overflowY: "auto",
          }}>
            {error}
          </pre>
        </details>

        <div style={{ display: "flex", gap: spacing.sm }}>
          {onRetry && (
            <Button variant="primary" size="md" onClick={onRetry} style={{ flex: 1 }}>
              Try again
            </Button>
          )}
          <Button variant="secondary" size="md" onClick={() => copyReport(buildCaptureReport(error, env, diagnosis))} style={{ flex: 1 }}>
            {copiedReport ? "Copied" : "Copy report"}
          </Button>
          <Button variant="ghost" size="md" onClick={onDismiss} style={{ flexShrink: 0 }}>
            Close
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
