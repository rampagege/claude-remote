// ── Shared Utilities ─────────────────────────────────────────────

/** Session name validation regex — single source of truth. */
export const VALID_SESSION_NAME = /^[a-zA-Z0-9_-]+$/;

// Pre-compiled ANSI regexes (avoid recompilation per call)
// eslint-disable-next-line no-control-regex
const ANSI_CURSOR_FWD = /\x1B\[(\d+)C/g;
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1B\[[0-9;?]*[A-Za-z]/g;
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;

/** Strip ANSI escape sequences from terminal text, replacing cursor-forward with spaces. */
export function stripAnsi(text: string): string {
  let result = text.replace(ANSI_CURSOR_FWD, (_m, n) => ' '.repeat(parseInt(n, 10)));
  result = result.replace(ANSI_CSI, '');
  result = result.replace(ANSI_OSC, '');
  return result;
}

/** Escape HTML special characters (for Telegram HTML messages). */
export function escapeHtmlBasic(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
