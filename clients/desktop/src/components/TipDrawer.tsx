import { useLayoutEffect, useRef, useState } from "react";
import { Drawer } from "vaul";
import { colors, spacing, fontSize, fontWeight } from "@lookout/react";
import { Sheet, SHEET_CLOSE_SIZE } from "./Sheet.js";
import type { Tip } from "../tip.js";

/**
 * The tip sheet: hero image, badge, headline, paragraph, and an X.
 *
 * Content comes from the server; this file knows the shape of a tip, never
 * the contents of one. App drives `open` and keeps the component mounted for
 * as long as a tip is published; Sheet survives the close animation.
 */

const HERO_HEIGHT = 210;

export interface TipDrawerProps {
  tip: Tip | null;
  open: boolean;
  onClose: () => void;
}

export function TipDrawer({ tip, open, onClose }: TipDrawerProps) {
  const [heroBroken, setHeroBroken] = useState(false);

  // useTip warms the hero at startup, so it usually paints with the sheet.
  // For the rest — published seconds ago, cold cache, slow host — fade it in
  // over the reserved band instead of letting it snap in late. A warm image
  // is `complete` before React can hear `load`, hence both paths.
  const rawHeroUrl = tip?.imageUrl ?? null;
  const heroRef = useRef<HTMLImageElement>(null);
  const [heroLoaded, setHeroLoaded] = useState(false);
  useLayoutEffect(() => {
    setHeroBroken(false);
    setHeroLoaded(Boolean(heroRef.current?.complete));
  }, [rawHeroUrl]);

  if (!tip) return null;

  const heroUrl = heroBroken ? null : rawHeroUrl;
  // Without a hero the X drops into the copy, so the headline must clear it.
  const titleClearance = heroUrl ? 0 : SHEET_CLOSE_SIZE + spacing.sm;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      ariaLabel={tip.title}
      hero={
        heroUrl ? (
          <div
            style={{
              height: HERO_HEIGHT,
              flexShrink: 0,
              background: colors.bg.sunken,
              position: "relative",
            }}
          >
            <img
              ref={heroRef}
              src={heroUrl}
              alt=""
              onLoad={() => setHeroLoaded(true)}
              onError={() => setHeroBroken(true)}
              style={{
                display: "block",
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: heroLoaded ? 1 : 0,
                transition: "opacity 220ms ease-out",
                // Dragging an image in a webview starts a native drag that
                // fights the sheet's own gesture.
                pointerEvents: "none",
                userSelect: "none",
              }}
            />
          </div>
        ) : undefined
      }
    >
      {tip.badge && (
        <span
          style={{
            display: "inline-block",
            padding: `3px ${spacing.sm}px`,
            marginBottom: 10,
            borderRadius: 4,
            background: colors.text.primary,
            color: colors.text.inverse,
            fontSize: fontSize.sm,
            fontWeight: fontWeight.semibold,
            letterSpacing: "-0.4px",
            lineHeight: 1.15,
          }}
        >
          {tip.badge}
        </span>
      )}
      <Drawer.Title
        style={{
          margin: 0,
          fontSize: fontSize.xxl,
          fontWeight: fontWeight.semibold,
          letterSpacing: "-0.36px",
          color: colors.text.primary,
          lineHeight: 1.25,
          paddingRight: titleClearance,
        }}
      >
        {tip.title}
      </Drawer.Title>
      <Drawer.Description
        style={{
          margin: `${spacing.sm}px 0 0`,
          fontSize: fontSize.lg,
          color: colors.text.secondary,
          lineHeight: 1.45,
        }}
      >
        {tip.body}
      </Drawer.Description>
    </Sheet>
  );
}
