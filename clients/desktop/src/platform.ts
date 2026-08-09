/**
 * Which desktop we're running on.
 *
 * Read once at module load: the webview's user agent can't change under us,
 * and scattering `navigator.userAgent.includes(...)` through the components
 * made the Linux checks easy to get subtly wrong (Android's UA also says
 * "Linux"; Windows' doesn't say "Mac" but WOW64 strings mention plenty else).
 */
const ua = navigator.userAgent;

export const isMacOS = ua.includes("Mac");
export const isWindows = ua.includes("Windows");
export const isLinux = !isMacOS && !isWindows && /\bLinux\b/.test(ua) && !/Android/i.test(ua);
