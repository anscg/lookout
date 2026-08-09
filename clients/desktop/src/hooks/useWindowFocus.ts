import { useState, useEffect } from "react";

/**
 * Whether the app window currently has focus.
 *
 * Used to gate work that's pointless without the user's eyes on it — e.g.
 * the recorder's live preview polls native captures while focused and falls
 * back to the latest uploaded capture when not. Complements the
 * `document.hidden` parking inside useScreenPreview: `hidden` covers
 * minimized/other-desktop, focus covers "visible but behind another window".
 */
export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());

  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return focused;
}
