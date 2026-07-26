import * as Sentry from "@sentry/react";
import React, { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { invoke } from "./logger.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "motion/react";
import {
  Gallery,
  SessionDetail,
  useTokenStore,
  useGallery,
  useHashRouter,
  type AddAnchor,
} from "@lookout/react";
import { getVersion } from "@tauri-apps/api/app";
import { ArrowSquareOutIcon, PlusIcon } from "@phosphor-icons/react";
import { isValidToken, extractToken } from "./utils.js";
import {
  checkCameraPermission,
  checkScreenRecordingPermission,
} from "tauri-plugin-macos-permissions-api";
import { PermissionScreen, permCacheKey } from "./components/PermissionScreen.js";
import { RecordPage } from "./components/RecordPage.js";
import { AddSessionPage } from "./components/AddSessionPage.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { TrayApp } from "./components/TrayApp.js";
import { EditorWindow, openEditorWindow, EDITED_EVENT } from "./components/EditorWindow.js";
import { useBlacklistedApps } from "./hooks/useBlacklistedApps.js";
import { useAppUpdate } from "./hooks/useAppUpdate.js";
import { useAnnouncement } from "./hooks/useAnnouncement.js";
import { ensureNotificationPermission } from "./hooks/useSessionNotifications.js";
import { UpdatePill } from "./components/UpdatePill.js";
import { AddMenuPopup, type AddMenuPopupItem } from "./components/AddMenuPopup.js";
import { AnnouncementBanner } from "./components/AnnouncementBanner.js";
import { getApiBase } from "./serverConfig.js";

// Read once per webview load; Settings → Server reloads the view on change.
const API_BASE = getApiBase();

interface Program {
  name: string;
  displayName?: string;
  newSessionUrl: string;
  iconUrl?: string | null;
}

/** Pause a session by token. Fire-and-forget, logs errors. */
async function pauseSession(token: string): Promise<void> {
  try {
    console.log(`[app] pausing session ${token.slice(0, 8)}...`);
    await fetch(`${API_BASE}/api/sessions/${token}/pause`, { method: "POST" });
    console.log(`[app] paused session ${token.slice(0, 8)}`);
  } catch (e) {
    console.error(`[app] failed to pause session ${token.slice(0, 8)}:`, e);
  }
}

/** Fetch a session's status. Returns null on error. */
async function fetchSessionStatus(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/sessions/${token}/status`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.status ?? null;
  } catch {
    return null;
  }
}

export function App() {
  const isTray = window.location.hash.includes("tray");
  if (isTray) {
    return <TrayApp />;
  }
  // Dedicated editor window (see EditorWindow.tsx). Branches before
  // MainWindowApp so it skips the permission gates, vibrancy, deep-link
  // handlers, and the rest of the main-window machinery.
  const editorMatch = window.location.hash.match(/^#\/?editor\?token=([0-9a-fA-F]{64})/);
  if (editorMatch) {
    return <EditorWindow token={editorMatch[1]} />;
  }
  return <MainWindowApp />;
}

function MainWindowApp() {
  const isMacOS = navigator.userAgent.includes("Mac");
  // A cached grant skips the permission gate (no boot flicker); a background
  // re-check below yanks it back if the permission was revoked since.
  const [screenPermGranted, setScreenPermGranted] = useState(
    () => !isMacOS || localStorage.getItem(permCacheKey("screen")) === "1",
  );
  const [cameraPermGranted, setCameraPermGranted] = useState(
    () => !isMacOS || localStorage.getItem(permCacheKey("camera")) === "1",
  );

  useEffect(() => {
    if (!isMacOS) return;
    (async () => {
      try {
        if (localStorage.getItem(permCacheKey("screen")) === "1" && !(await checkScreenRecordingPermission())) {
          console.warn("[permissions] screen recording revoked — regating");
          localStorage.removeItem(permCacheKey("screen"));
          setScreenPermGranted(false);
        }
        if (localStorage.getItem(permCacheKey("camera")) === "1" && !(await checkCameraPermission())) {
          console.warn("[permissions] camera revoked — regating");
          localStorage.removeItem(permCacheKey("camera"));
          setCameraPermGranted(false);
        }
      } catch {
        // Plugin unavailable — leave the cached grants alone
      }
    })();
  }, [isMacOS]);
  const [isWayland, setIsWayland] = useState(false);
  const { route, navigate } = useHashRouter();
  const tokenStore = useTokenStore();
  const appUpdate = useAppUpdate();
  const gallery = useGallery({
    apiBaseUrl: API_BASE,
    tokens: tokenStore.getAllTokenValues(),
  });

  // Bumped when an editor window applies cuts — remounts the open
  // SessionDetail so it re-fetches (picks up the compiling → complete flip
  // and the recompiled video) and refreshes gallery thumbnails.
  const [editNonce, setEditNonce] = useState(0);
  const galleryRefreshRef = React.useRef(gallery.refresh);
  galleryRefreshRef.current = gallery.refresh;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen(EDITED_EVENT, () => {
      console.log("[app] editor window applied cuts — refreshing");
      setEditNonce((n) => n + 1);
      galleryRefreshRef.current();
    }).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  // Initialize blacklisted apps sync from localStorage to Rust backend
  useBlacklistedApps();

  // Boot timing: first React commit and the frame after it (≈ first paint).
  useEffect(() => {
    console.log(`[boot] app mounted at ${Math.round(performance.now())}ms`);
    requestAnimationFrame(() =>
      console.log(`[boot] first frame at ${Math.round(performance.now())}ms`),
    );
  }, []);

  // Request notification permission at launch, not deferred to recording start.
  useEffect(() => {
    void ensureNotificationPermission();
  }, []);

  // Admin-authored announcement banner; checked on open and every 15 min.
  const announcement = useAnnouncement();

  // Detect Wayland — filter apps feature is unsupported there
  useEffect(() => {
    invoke<boolean>("is_wayland").then(setIsWayland).catch(() => {});
  }, []);

  // Program registry cache for the + button's native popup menu. Warmed at
  // launch and refreshed on every open so the menu appears instantly with
  // whatever we have; the AddSessionPage stays the fallback (paste-a-link,
  // empty registry, non-macOS).
  const programsRef = React.useRef<Program[]>([]);
  const fetchPrograms = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/programs`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.programs)) {
        programsRef.current = data.programs;
        // Warm the icon cache so the menu never opens with fallback symbols
        // while images load — the Swift-side cache on macOS, the browser's
        // HTTP cache for the DOM popup elsewhere.
        const urls = programsRef.current
          .map((p) => p.iconUrl)
          .filter((u): u is string => !!u);
        if (urls.length) {
          if (isMacOS) {
            invoke("prefetch_add_menu_icons", { urls }).catch(() => {});
          } else {
            for (const url of urls) new Image().src = url;
          }
        }
      }
    } catch (e) {
      console.warn("[programs] failed to load registry:", e);
    }
  }, [isMacOS]);
  useEffect(() => {
    void fetchPrograms();
  }, [fetchPrograms]);

  // Windows/Linux add menu — a DOM replica of the macOS NSPanel popup.
  const [addMenu, setAddMenu] = useState<{ items: AddMenuPopupItem[]; anchor: AddAnchor } | null>(null);

  /** Acts on an add-menu choice, from either the native panel or the DOM popup. */
  const handleMenuChoice = useCallback(
    async (choice: string | null) => {
      if (!choice) return; // dismissed
      if (choice === "create-new") {
        navigate({ page: "add" });
        return;
      }
      const program = programsRef.current.find((p) => `program:${p.name}` === choice);
      if (!program) return;
      try {
        await invoke("open_external_url", { url: program.newSessionUrl });
      } catch (e) {
        console.error("[add-menu] failed to open program url:", e);
        navigate({ page: "add" });
      }
    },
    [navigate],
  );

  const handleAdd = useCallback(
    async (anchor: AddAnchor) => {
      // Clicking the + while the DOM popup is open toggles it closed (the
      // popup ignores pointerdowns on the anchor so this click reaches us).
      if (addMenu) {
        setAddMenu(null);
        return;
      }
      const programs = programsRef.current;
      void fetchPrograms(); // refresh behind the menu for next open
      if (programs.length === 0) {
        navigate({ page: "add" });
        return;
      }
      if (!isMacOS) {
        setAddMenu({
          items: [
            ...programs.map((p) => ({
              id: `program:${p.name}`,
              label: p.displayName || p.name,
              iconUrl: p.iconUrl ?? undefined,
              // Stays visible while the icon loads or when a program has none.
              fallbackIcon: <ArrowSquareOutIcon size={15} weight="bold" />,
            })),
            { separator: true },
            { id: "create-new", label: "Create new timelapse", fallbackIcon: <PlusIcon size={15} weight="bold" /> },
          ],
          anchor,
        });
        return;
      }
      const entries = [
        ...programs.map((p) => ({
          id: `program:${p.name}`,
          label: p.displayName || p.name,
          // The symbol stays as the fallback while the icon loads or when a
          // program has none.
          symbol: "arrow.up.forward.app",
          iconUrl: p.iconUrl ?? undefined,
        })),
        { separator: true },
        { id: "create-new", label: "Create new timelapse", symbol: "plus" },
      ];
      let choice: string | null;
      try {
        choice = await invoke<string | null>("show_add_menu", { entries, anchor });
      } catch (e) {
        console.warn("[add-menu] native menu failed, falling back to page:", e);
        navigate({ page: "add" });
        return;
      }
      await handleMenuChoice(choice);
    },
    [isMacOS, addMenu, fetchPrograms, navigate, handleMenuChoice],
  );

  // Deep link handler -- saves token and navigates appropriately.
  // If currently recording another session, pauses it first.
  // Tracks the last processed URL to deduplicate retried cold-start emits.
  const lastDeepLink = React.useRef<string | null>(null);
  const handleDeepLinkUrls = useCallback(
    async (urls: string[]) => {
      console.log("[app] deep link received:", urls);
      for (const url of urls) {
        if (url === lastDeepLink.current) return; // already handled
        const token = extractToken(url);
        if (!token) continue;

        console.log(`[app] extracted token: ${token.slice(0, 8)}...`);
        lastDeepLink.current = url;
        tokenStore.addToken(token);

        // If we're currently recording a different session, pause it first
        if (route.page === "record" && route.token && route.token !== token) {
          console.log(`[app] deep link interrupting active session ${route.token.slice(0, 8)}...`);
          await pauseSession(route.token);
        }

        // Check the incoming session's status to decide where to go
        const status = await fetchSessionStatus(token);
        console.log(`[app] incoming session status: ${status}`);

        if (status && ["stopped", "compiling", "complete", "failed"].includes(status)) {
          // Session is finished — go to detail view
          navigate({ page: "session", token });
        } else {
          // Session is recordable (pending/active/paused) or unknown — go to record
          navigate({ page: "record", token });
        }

        // Bring window to front
        getCurrentWindow().setFocus().catch(() => {});
        return;
      }
    },
    [tokenStore, navigate, route],
  );
  // Ref so effects can call the latest version without depending on it
  const handleDeepLinkRef = React.useRef(handleDeepLinkUrls);
  handleDeepLinkRef.current = handleDeepLinkUrls;

  // Listen for deep links while app is running (warm start).
  // We use our custom "lookout-deep-link" event to avoid conflicts and infinite loops
  // with the tauri-plugin-deep-link internal event loops.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string[]>("lookout-deep-link", (event) => {
      handleDeepLinkRef.current(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => { if (unlisten) unlisten(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for cold-start deep link URLs exactly once. The Rust side stashes
  // URLs from both get_current() (immediate) and on_open_url (delayed Apple
  // Event). We poll a few times to catch URLs that arrive after launch.
  const coldStartRan = React.useRef(false);
  useEffect(() => {
    if (coldStartRan.current) return;
    coldStartRan.current = true;

    let cancelled = false;
    const check = async () => {
      for (let i = 0; i < 10 && !cancelled; i++) {
        try {
          console.debug(`[app] cold-start poll attempt ${i + 1}/10`);
          const urls = await invoke<string[]>("get_cold_start_urls");
          if (urls.length > 0) {
            handleDeepLinkRef.current(urls);
            return;
          }
        } catch (e) {
          console.debug("[app] cold-start poll miss:", e);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      console.debug("[app] cold-start poll finished, no urls found");
    };
    check();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle ?token= query param (dev mode) — route through the same handler
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (token && isValidToken(token)) {
      handleDeepLinkRef.current([`lookout://session/?token=${token}`]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen to Tauri theme changes (for Linux where prefers-color-scheme might fail)
  useEffect(() => {
    const updateTheme = (theme: "light" | "dark" | null) => {
      if (theme) {
        document.documentElement.setAttribute("data-theme", theme);
      } else {
        document.documentElement.removeAttribute("data-theme");
      }
    };

    const isLinux = navigator.userAgent.toLowerCase().includes("linux");

    if (isLinux) {
      // On Linux, Tauri's window.theme() can incorrectly report "light" and override the native GTK webview behavior.
      // WebKitGTK natively supports prefers-color-scheme (via xdg-desktop-portal / org.freedesktop.appearance).
      // So we just rely on standard browser matchMedia to get the universal native standard.
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const getSystemTheme = () => mediaQuery.matches ? "dark" : "light";

      const applyTheme = () => {
        const theme = getSystemTheme();
        updateTheme(theme);
        // Force the Tauri window GTK decorations to match the media query since winit is confused
        getCurrentWindow().setTheme(theme).catch(() => {});
      };

      applyTheme();

      const listener = () => applyTheme();
      mediaQuery.addEventListener("change", listener);

      return () => mediaQuery.removeEventListener("change", listener);
    } else {
      getCurrentWindow().theme().then(updateTheme).catch(() => {});

      let unlisten: (() => void) | undefined;
      getCurrentWindow().onThemeChanged((event) => {
        updateTheme(event.payload);
      }).then((fn) => { unlisten = fn; }).catch(() => {});

      return () => { if (unlisten) unlisten(); };
    }
  }, []);

  // Listen for native menu navigation events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("lookout-navigate", (event) => {
      if (event.payload === "/add") {
        navigate({ page: "add" });
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => { if (unlisten) unlisten(); };
  }, [navigate]);

  // Set window title with version
  useEffect(() => {
    getVersion().then((v) => {
      getCurrentWindow().setTitle(`Lookout v${v}`);
    }).catch(() => {});
  }, []);

  // Enable vibrancy globally for the app
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById("root");
    const prevHtmlBg = html.style.background;
    const prevBodyBg = body.style.background;
    const prevRootBg = root?.style.background ?? "";

    let effectsApplied = false;

    const isLinux = navigator.userAgent.toLowerCase().includes("linux");
    if (!isLinux) {
      invoke("enable_vibrancy")
        .then(() => {
          effectsApplied = true;
          html.style.background = "transparent";
          body.style.background = "transparent";
          if (root) root.style.background = "transparent";
        })
        .catch((err) => {
          console.warn("Failed to enable vibrancy", err);
        });
    } else {
      console.log("[vibrancy] skipped on Linux");
      // Explicitly set opaque background on Linux to override any default transparent styling
      html.style.background = "var(--color-bg-body)";
      body.style.background = "var(--color-bg-body)";
      if (root) root.style.background = "var(--color-bg-body)";
    }

    return () => {
      if (effectsApplied) {
        invoke("disable_vibrancy").catch(() => {});
      }
      html.style.background = prevHtmlBg;
      body.style.background = prevBodyBg;
      if (root) root.style.background = prevRootBg;
    };
  }, []);

  // Step 2: Route
  const content = (() => {
    switch (route.page) {
      case "gallery":
        return (
          <Gallery
            sessions={gallery.sessions}
            loading={gallery.loading}
            error={gallery.error}
            onSessionClick={(token) => {
              const session = gallery.sessions.find((s) => s.token === token);
              if (session && ["pending", "active", "paused"].includes(session.status)) {
                navigate({ page: "record", token });
              } else {
                navigate({ page: "session", token });
              }
            }}
            onArchive={async (token) => {
              const yes = await confirm("Are you sure you want to archive this session?", { title: "Archive Session", kind: "warning" });
              if (yes) {
                tokenStore.archiveToken(token);
                gallery.refresh();
              }
            }}
            onAdd={handleAdd}
            // Always available: the Server subpage works everywhere; only the
            // Filtered Apps subpage is Wayland-restricted (it shows a notice).
            onSettings={() => navigate({ page: "settings" })}
            banner={announcement ? <AnnouncementBanner announcement={announcement} /> : undefined}
          />
        );
      case "settings":
        return (
          <SettingsPage
            onBack={() => navigate({ page: "gallery" })}
            isWayland={isWayland}
          />
        );
      case "add":
        return (
          <AddSessionPage
            onBack={() => navigate({ page: "gallery" })}
            onStart={(token) => {
              tokenStore.addToken(token);
              handleDeepLinkRef.current([`lookout://session/?token=${token}`]);
            }}
          />
        );
      case "record":
        return (
          <RecordPage
            key={route.token}
            token={route.token}
            onBack={() => {
              gallery.refresh();
              navigate({ page: "gallery" });
            }}
            onViewSession={(token) => {
              tokenStore.addToken(token);
              navigate({ page: "session", token });
            }}
          />
        );
      case "session":
        return (
          <SessionDetail
            key={`${route.token}:${editNonce}`}
            token={route.token}
            apiBaseUrl={API_BASE}
            onEdit={() => { void openEditorWindow(route.token); }}
            onComplete={({ redirectUrl }) => {
              // Redirect hook: the session's creator asked us to send the
              // user somewhere once their timelapse is ready.
              if (redirectUrl) {
                invoke("open_external_url", { url: redirectUrl }).catch(() => {});
              }
            }}
            onBack={() => {
              gallery.refresh();
              navigate({ page: "gallery" });
            }}
            onArchive={async () => {
              const yes = await confirm("Are you sure you want to archive this session?", { title: "Archive Session", kind: "warning" });
              if (yes) {
                tokenStore.archiveToken(route.token);
                gallery.refresh();
                navigate({ page: "gallery" });
              }
            }}
          />
        );
      default:
        return null;
    }
  })();

  // Sequential, independent permission gates — not else-if.
  // key= forces React to mount a fresh instance for each type (resets `requested` state).
  const mainView = !screenPermGranted ? (
    <PermissionScreen key="screen" type="screen" onGranted={() => setScreenPermGranted(true)} />
  ) : !cameraPermGranted ? (
    <PermissionScreen key="camera" type="camera" onGranted={() => setCameraPermGranted(true)} />
  ) : (
    content
  );

  const prevRouteRef = React.useRef(route);
  const routeDirection = React.useMemo(() => {
    const prev = prevRouteRef.current;
    const prevPage = prev.page;
    const nextPage = route.page;

    if (prevPage === "gallery" && nextPage !== "gallery") return 1;
    if (prevPage !== "gallery" && nextPage === "gallery") return -1;
    if (prevPage === "record" && nextPage === "session") return 1;
    if (prevPage === "session" && nextPage === "record") return -1;
    return 1;
  }, [route]);

  useEffect(() => {
    prevRouteRef.current = route;
    const token = (route as { token?: string }).token;
    Sentry.setTag("session_token", token ?? null);
  }, [route]);

  const routeKey = `${route.page}:${(route as { token?: string }).token ?? ""}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", position: "relative" }}>
      {/* Draggable Titlebar Area that dodges the traffic lights (macOS only).
          The update pill lives here, Ghostty-style — the titlebar is a
          transparent webview overlay, so it renders inside the real titlebar. */}
      {isMacOS ? (
        <div
          data-tauri-drag-region
          className="titlebar"
          style={{ height: 32, flexShrink: 0, width: "100%", zIndex: 9999, background: "transparent", cursor: "default", display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 6, boxSizing: "border-box" }}
        >
          <UpdatePill phase={appUpdate.phase} onRestart={appUpdate.restart} />
        </div>
      ) : (
        /* No overlay titlebar on Windows/Linux — float the pill bottom-left. */
        <div style={{ position: "absolute", bottom: 8, left: 8, zIndex: 9999 }}>
          <UpdatePill phase={appUpdate.phase} onRestart={appUpdate.restart} origin="bottom" />
        </div>
      )}
      {/* Windows/Linux + menu. Rendered here, outside the route transition's
          transformed wrapper, so position:fixed anchors to the viewport. */}
      <AnimatePresence>
        {addMenu && (
          <AddMenuPopup
            items={addMenu.items}
            anchor={addMenu.anchor}
            onSelect={(choice) => {
              setAddMenu(null);
              void handleMenuChoice(choice);
            }}
          />
        )}
      </AnimatePresence>
      <div style={{
        flex: 1,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}>
        <AnimatePresence mode="sync" initial={false} custom={routeDirection}>
          <motion.div
            key={routeKey}
            custom={routeDirection}
            initial="enter"
            animate="center"
            exit="exit"
            variants={{
              enter: (direction: number) => ({ opacity: 0, x: direction > 0 ? 14 : -14 }),
              center: {
                opacity: 1,
                x: 0,
                transition: {
                  x: { type: "spring", stiffness: 460, damping: 36, mass: 0.7 },
                  opacity: { duration: 0.16, delay: 0.04, ease: "easeOut" },
                },
              },
              exit: (direction: number) => ({
                opacity: 0,
                x: direction > 0 ? -14 : 14,
                transition: {
                  x: { type: "spring", stiffness: 460, damping: 36, mass: 0.7 },
                  opacity: { duration: 0.14, ease: "easeOut" },
                },
              }),
            }}
            style={{
              position: "absolute",
              inset: 0,
              height: "100%",
              overflowY: (route.page === "gallery") ? "hidden" : "auto",
            }}
          >
            {mainView}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
