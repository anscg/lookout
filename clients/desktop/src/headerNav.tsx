/**
 * How a page tells the header bar what to put in it.
 *
 * On Linux the window's chrome is the header bar, so a page's back button
 * and its heading belong up there rather than repeated inside the content —
 * that's what a GTK app does, and it's what stops the window reading as a
 * web page with a title bar glued on.
 *
 * The awkward part is that App doesn't know everything the header needs.
 * It knows each top-level route's back action, but Settings has subpages of
 * its own, and only Settings knows whether "back" currently means "to the
 * gallery" or "to the settings menu". So pages publish upward, and App
 * treats what it gets as an override on its own route-derived default.
 *
 * Ownership is tracked per publisher because the route transition keeps the
 * outgoing page mounted for a moment: without it, the old page's unmount
 * would clear the header the new page had just filled in.
 */
import React, { createContext, useContext, useEffect, useId, useRef } from "react";
import { isLinux } from "./platform.js";

export interface HeaderNav {
  /** Overrides the route's default title. */
  title?: string;
  /** Overrides the route's default subtitle. */
  subtitle?: string;
  /** What the header's back button does. Omit for no back button. */
  onBack?: () => void;
}

export type PublishHeaderNav = (owner: string, nav: HeaderNav | null) => void;

const PublishContext = createContext<PublishHeaderNav | null>(null);

export function HeaderNavProvider({
  publish,
  children,
}: {
  publish: PublishHeaderNav;
  children: React.ReactNode;
}) {
  return <PublishContext.Provider value={publish}>{children}</PublishContext.Provider>;
}

/**
 * Publish this page's header contribution for as long as it's mounted.
 *
 * `onBack` is read through a ref so a page can pass a fresh closure every
 * render without republishing on each one — only the *shape* of the
 * contribution (title, subtitle, whether there's a back action) re-fires it.
 */
export function usePublishHeaderNav(nav: HeaderNav | null): void {
  const publish = useContext(PublishContext);
  const owner = useId();
  const navRef = useRef(nav);
  navRef.current = nav;

  const title = nav?.title;
  const subtitle = nav?.subtitle;
  const hasBack = Boolean(nav?.onBack);

  useEffect(() => {
    // Every other platform keeps its in-content chrome, so there's nothing
    // to hand upward and no reason to churn App's state.
    if (!isLinux || !publish) return;
    if (!navRef.current) {
      publish(owner, null);
      return;
    }
    publish(owner, {
      title: navRef.current.title,
      subtitle: navRef.current.subtitle,
      onBack: navRef.current.onBack ? () => navRef.current?.onBack?.() : undefined,
    });
    return () => publish(owner, null);
  }, [publish, owner, title, subtitle, hasBack]);
}
