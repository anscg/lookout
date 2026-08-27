/**
 * What a modal dim is filled with.
 *
 * Windows ramps it rather than laying it flat: transparent at the top so the
 * window's chrome stays clear, full weight down where the dialog or sheet
 * actually sits. macOS and Linux get the flat token.
 *
 * Its own module because platform.ts is deliberately dependency-free —
 * importing the design system there would pull the theme sheet's injection
 * into every module that only wanted `isLinux`.
 */
import { colors } from "@lookout/react";
import { isWindows } from "./platform.js";

export const backdropFill = isWindows
  ? `linear-gradient(to bottom, transparent 0%, ${colors.bg.backdrop} 100%)`
  : colors.bg.backdrop;
