import React, { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  LookoutProvider,
  LookoutRecorder,
  Gallery,
  SessionDetail,
  useTokenStore,
  useGallery,
  useHashRouter,
} from "@lookout/react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "https://lookout.hackclub.com";

export function App() {
  const { route, navigate } = useHashRouter();
  const tokenStore = useTokenStore();
  const gallery = useGallery({
    apiBaseUrl: API_BASE,
    tokens: tokenStore.getAllTokenValues(),
  });

  // Handle incoming ?token= from external service
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (token && /^[a-f0-9]{64}$/i.test(token)) {
      tokenStore.addToken(token);
      // Clear query string and navigate to record
      window.history.replaceState({}, "", window.location.pathname);
      navigate({ page: "record", token });
    }
  }, []);

  const content = (() => {
    switch (route.page) {
      case "gallery":
        return (
          <Gallery
            sessions={gallery.sessions}
            loading={gallery.loading}
            error={gallery.error}
            onSessionClick={(token) => {
              navigate({ page: "session", token });
            }}
            onArchive={(token) => {
              tokenStore.archiveToken(token);
              gallery.refresh();
            }}
            onRefresh={gallery.refresh}
          />
        );

      case "record":
        return (
          <LookoutProvider token={route.token} apiBaseUrl={API_BASE}>
            <div style={{ maxWidth: 640, margin: "0 auto", padding: 16 }}>
              <button
                onClick={() => navigate({ page: "gallery" })}
                style={backBtnStyle}
              >
                &larr; Gallery
              </button>
              <LookoutRecorder />
            </div>
          </LookoutProvider>
        );

      case "session":
        return (
          <SessionDetail
            token={route.token}
            apiBaseUrl={API_BASE}
            onBack={() => navigate({ page: "gallery" })}
            onArchive={() => {
              tokenStore.archiveToken(route.token);
              navigate({ page: "gallery" });
            }}
          />
        );
    }
  })();

  const prevRouteRef = React.useRef(route);
  const routeDirection = React.useMemo(() => {
    const prevPage = prevRouteRef.current.page;
    const nextPage = route.page;
    if (prevPage === "gallery" && nextPage !== "gallery") return 1;
    if (prevPage !== "gallery" && nextPage === "gallery") return -1;
    if (prevPage === "record" && nextPage === "session") return 1;
    if (prevPage === "session" && nextPage === "record") return -1;
    return 1;
  }, [route]);

  useEffect(() => {
    prevRouteRef.current = route;
  }, [route]);

  const routeKey = `${route.page}:${("token" in route ? route.token : "")}`;

  return (
    <div style={{ position: "relative", minHeight: "100vh", overflow: "hidden" }}>
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
          style={{ position: "absolute", inset: 0, minHeight: "100vh" }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

const backBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  fontWeight: 500,
  background: "transparent",
  color: "#888",
  border: "1px solid #444",
  borderRadius: 6,
  cursor: "pointer",
  marginBottom: 12,
};
