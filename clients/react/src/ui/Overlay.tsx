import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { colors, spacing } from "./theme.js";

export interface OverlayProps {
  children: ReactNode;
  /** Accessible name for the dialog. */
  label: string;
  /** Panel width/height. Numbers are px; strings pass through, so callers
   *  can clamp against the viewport. */
  width?: number | string;
  height?: number | string;
  /** Called on backdrop click / Escape. Omit for a dialog that can only be
   *  left through its own actions. */
  onDismiss?: () => void;
}

/**
 * A centred modal panel over a backdrop.
 *
 * Rendered through a portal to `document.body` rather than in place. The
 * SDK gets dropped into pages we don't control, and `position: fixed`
 * silently resolves against the nearest transformed/filtered ancestor
 * instead of the viewport — so an embedder with a `transform` anywhere up
 * the tree would otherwise get a modal pinned inside their card.
 */
export function Overlay({
  children,
  label,
  width = "min(1100px, 94vw)",
  height,
  onDismiss,
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Move focus into the dialog so keyboard users aren't left behind it.
    panelRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    if (!onDismiss) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: colors.bg.backdrop,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: spacing.xl,
        zIndex: 9999,
      }}
      onPointerDown={(e) => {
        if (onDismiss && e.target === e.currentTarget) onDismiss();
      }}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        initial={{ opacity: 0, y: 10, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{
          y: { type: "spring", stiffness: 420, damping: 34, mass: 0.7 },
          opacity: { duration: 0.16, ease: "easeOut" },
        }}
        style={{
          width,
          height,
          maxWidth: "100%",
          maxHeight: "100%",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: colors.bg.panel,
          border: `1px solid ${colors.border.default}`,
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
          outline: "none",
          overflow: "hidden",
        }}
      >
        {children}
      </motion.div>
    </div>,
    document.body,
  );
}
