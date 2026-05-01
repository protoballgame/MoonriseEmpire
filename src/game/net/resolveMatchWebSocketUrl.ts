export const PUBLIC_MATCH_WS_FALLBACK = "wss://moonrise-match.onrender.com";

/**
 * Host segment for `ws://…:8788` when derived from `location.hostname` or the launch-screen field.
 * `0.0.0.0` is invalid as an outbound connect target (common when opening Vite’s `--host` URL).
 * Bare IPv6 literals need brackets in ws URLs.
 */
export function hostnameForMatchWebSocket(hostname: string): string {
  const h = hostname.trim();
  if (h === "" || h === "0.0.0.0") return "127.0.0.1";
  if (h.startsWith("[") && h.endsWith("]")) return h;
  if (h.includes(":")) return `[${h}]`;
  return h;
}

/**
 * Resolves the authoritative match WebSocket URL for PvP.
 *
 * Precedence: `?matchWs=` or `?ws=` (URL-encoded) → `import.meta.env.VITE_MATCH_WS` →
 * in Vite dev only, if `?match=pvp`, default `ws://<page-hostname>:8788`.
 */
export function resolveMatchWebSocketUrl(search: string): string | null {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const fromQuery = q.get("matchWs") ?? q.get("ws");
  if (fromQuery?.trim()) {
    return rewriteLoopbackWsHost(fromQuery.trim());
  }
  const env =
    typeof import.meta.env !== "undefined" && typeof import.meta.env.VITE_MATCH_WS === "string"
      ? import.meta.env.VITE_MATCH_WS.trim()
      : "";
  if (env) return rewriteLoopbackWsHost(env);
  if (typeof import.meta.env !== "undefined" && import.meta.env.DEV && q.get("match") === "pvp") {
    const raw = typeof window !== "undefined" ? window.location.hostname : "127.0.0.1";
    const host = hostnameForMatchWebSocket(raw);
    return `ws://${host}:8788`;
  }
  if (q.get("match") === "pvp") return PUBLIC_MATCH_WS_FALLBACK;
  return null;
}

/** Rewrites `ws://0.0.0.0:port` in explicit URLs (e.g. shared links copied from a bad tab). */
function rewriteLoopbackWsHost(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "0.0.0.0") {
      u.hostname = "127.0.0.1";
      return u.toString();
    }
  } catch {
    // ignore
  }
  return url;
}
