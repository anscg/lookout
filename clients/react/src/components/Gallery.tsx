import React, { useRef, useState, useEffect, useCallback } from "react";
import { GearSixIcon, PlusIcon } from "@phosphor-icons/react";
import type { SessionSummary } from "@lookout/shared";
import { SessionCard } from "./SessionCard.js";
import { Button } from "../ui/Button.js";
import { ErrorDisplay } from "../ui/ErrorDisplay.js";
import { GallerySkeleton } from "../ui/Skeleton.js";
import { colors, spacing, fontSize, fontWeight, radii } from "../ui/theme.js";

/** Viewport-relative rect of the + button, for hosts that anchor a popup to it. */
export interface AddAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GalleryProps {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  onSessionClick?: (token: string) => void;
  onArchive?: (token: string) => void;
  /** Right-click on a session card. The host decides how to present the menu. */
  onSessionContextMenu?: (token: string, e: React.MouseEvent) => void;
  onRefresh?: () => void;
  onAdd?: (anchor: AddAnchor) => void;
  onSettings?: () => void;
  /** Optional content rendered just below the header (e.g. an update banner). */
  banner?: React.ReactNode;
  /**
   * Draw the gallery's own title-and-actions row. Hosts that already have
   * somewhere to put them — the Linux desktop build lifts them into its
   * header bar — pass false so the title isn't stated twice.
   */
  showHeader?: boolean;
  /**
   * Fade the list out at its bottom edge when there's more to scroll to.
   * The top fade is unaffected — hosts pass false when the bottom of the
   * list already sits against chrome of their own.
   */
  showBottomFade?: boolean;
}

const addButtonStyle: React.CSSProperties = {
  borderRadius: radii.md,
  fontSize: fontSize.xxl,
  width: 40,
  height: 40,
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

function GalleryHeader({ onAdd, onSettings }: { onAdd?: (anchor: AddAnchor) => void; onSettings?: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: spacing.lg, paddingBottom: 0, flexShrink: 0 }}>
      <h2 style={{ fontSize: fontSize.heading, fontWeight: fontWeight.bold, color: colors.text.primary, margin: 0 }}>Your Timelapses</h2>
      <div style={{ display: "flex", alignItems: "center", gap: spacing.xs }}>
        {onSettings && (
          <Button variant="ghost" size="sm" onClick={onSettings} title="Settings" aria-label="Settings" style={addButtonStyle}>
            <GearSixIcon size={30} weight="fill" aria-hidden="true" />
          </Button>
        )}
        {onAdd && (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onAdd({ x: r.left, y: r.top, width: r.width, height: r.height });
            }}
            title="Start"
            aria-label="Start"
            style={addButtonStyle}
          >
            <PlusIcon size={28} weight="bold" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

// Global cache for gallery scroll position
let galleryScrollPosition = 0;

export function Gallery({
  sessions,
  loading,
  error,
  onSessionClick,
  onArchive,
  onSessionContextMenu,
  onRefresh,
  onAdd,
  onSettings,
  banner,
  showHeader = true,
  showBottomFade = true,
}: GalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showTopMask, setShowTopMask] = useState(false);
  const [showBottomMask, setShowBottomMask] = useState(false);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    galleryScrollPosition = scrollTop;
    setShowTopMask(scrollTop > 0);
    setShowBottomMask(Math.ceil(scrollTop + clientHeight) < scrollHeight);
  }, []);

  // Restore scroll position when sessions load or component mounts
  useEffect(() => {
    if (scrollRef.current && sessions.length > 0 && !loading) {
      scrollRef.current.scrollTop = galleryScrollPosition;
      handleScroll();
    }
  }, [sessions.length, loading, handleScroll]);

  useEffect(() => {
    handleScroll();
    window.addEventListener('resize', handleScroll);
    return () => window.removeEventListener('resize', handleScroll);
  }, [sessions, handleScroll]);

  // One expression, used for both the standard and -webkit- properties.
  const fadeMask = `linear-gradient(to bottom, ${
    showTopMask ? "transparent 0%, black 20px" : "black 0%, black 20px"
  }, ${
    showBottomMask && showBottomFade
      ? "black calc(100% - 20px), transparent 100%"
      : "black calc(100% - 20px), black 100%"
  })`;

  if (loading && sessions.length === 0) {
    return <GallerySkeleton />;
  }

  if (error && sessions.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {showHeader && <GalleryHeader onAdd={onAdd} onSettings={onSettings} />}
      {banner && <div style={{ padding: spacing.lg, paddingBottom: 0 }}>{banner}</div>}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: spacing.xxl }}>
          <ErrorDisplay error={error} variant="inline" />
          {onRefresh && (
            <Button variant="primary" size="md" onClick={onRefresh} style={{ marginTop: spacing.md }}>
              Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {showHeader && <GalleryHeader onAdd={onAdd} onSettings={onSettings} />}
      {banner && <div style={{ padding: spacing.lg, paddingBottom: 0 }}>{banner}</div>}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: spacing.xxl }}>
          <p style={{ marginBottom: spacing.md }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={colors.text.primary} strokeWidth="1.5" style={{ opacity: 0.2 }}>
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </p>
          <p style={{ fontSize: fontSize.lg, color: colors.text.primary, opacity: 0.5, textAlign: "center" }}>No timelapses yet</p>
          <p style={{ fontSize: fontSize.sm, color: colors.text.primary, opacity: 0.3, marginTop: spacing.xs, textAlign: "center" }}>
            Start a recording session to see it here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {showHeader && <GalleryHeader onAdd={onAdd} onSettings={onSettings} />}
      {banner && <div style={{ padding: spacing.lg, paddingBottom: 0 }}>{banner}</div>}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: spacing.lg,
          maskImage: fadeMask,
          WebkitMaskImage: fadeMask,
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: spacing.md }}>
          {sessions.map((s) => (
            <SessionCard
              key={s.token}
              session={s}
              onClick={() => onSessionClick?.(s.token)}
              onArchive={onArchive ? () => onArchive(s.token) : undefined}
              onContextMenu={onSessionContextMenu ? (e) => onSessionContextMenu(s.token, e) : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
