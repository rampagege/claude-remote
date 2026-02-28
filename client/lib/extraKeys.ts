/**
 * Extra key toolbar for mobile terminal input.
 * Provides Esc, Tab, Ctrl, Alt modifier toggles, arrow keys, and common symbols.
 */

type SendFn = (data: string) => void;

/** iOS detection — navigator.platform is deprecated but still the only reliable
 *  way to detect iPad on iPadOS 13+ (which reports as 'MacIntel'). */
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

interface KeyDef {
  label: string;
  /** The data to send. If starts with 'mod:', it's a modifier toggle. */
  action: string;
  /** Optional CSS class additions */
  cls?: string;
}

const KEYS: KeyDef[] = [
  { label: 'Paste', action: 'special:paste' },
  { label: 'Esc', action: '\x1b' },
  { label: 'Tab', action: '\t' },
  { label: 'Enter', action: '\r' },
  { label: 'Ctrl', action: 'mod:ctrl', cls: 'mod-key' },
  { label: 'Alt', action: 'mod:alt', cls: 'mod-key' },
  { label: '\u2191', action: '\x1b[A' }, // ↑
  { label: '\u2193', action: '\x1b[B' }, // ↓
  { label: '\u2190', action: '\x1b[D' }, // ←
  { label: '\u2192', action: '\x1b[C' }, // →
  { label: 'Home', action: '\x1b[H' },
  { label: 'End', action: '\x1b[F' },
  { label: 'PgUp', action: '\x1b[5~' },
  { label: 'PgDn', action: '\x1b[6~' },
  { label: '|', action: '|' },
  { label: '~', action: '~' },
  { label: '/', action: '/' },
  { label: '-', action: '-' },
  { label: '_', action: '_' },
  { label: '`', action: '`' },
];

/** Convert a character to its Ctrl+key code (e.g. 'c' → \x03) */
function ctrlKey(ch: string): string {
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return ch;
}

/** Convert a character to its Alt+key code (ESC prefix) */
function altKey(ch: string): string {
  return '\x1b' + ch;
}

/** Fallback paste modal — shown when Clipboard API is unavailable (e.g. no HTTPS). */
let pasteModalOpen = false;
function showPasteModal(sendFn: SendFn): void {
  if (pasteModalOpen) return;
  pasteModalOpen = true;
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4';
  overlay.style.touchAction = 'manipulation';
  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl p-4"
         style="touch-action:manipulation">
      <p class="text-sm font-semibold mb-2">Paste text</p>
      <textarea class="paste-input w-full h-24 p-2 rounded-lg border border-zinc-300 dark:border-zinc-600
        bg-zinc-50 dark:bg-zinc-900 text-sm font-mono text-zinc-800 dark:text-zinc-200 resize-none"
        placeholder="Long-press here to paste..." style="-webkit-user-select:text;user-select:text"></textarea>
      <div class="flex justify-end gap-2 mt-3">
        <button class="paste-cancel px-3 py-1.5 text-xs font-medium rounded-md border border-zinc-300 dark:border-zinc-600
          text-zinc-600 dark:text-zinc-300">Cancel</button>
        <button class="paste-send px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white">Send</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const ta = overlay.querySelector('.paste-input') as HTMLTextAreaElement;
  ta.focus();

  const close = () => {
    pasteModalOpen = false;
    overlay.remove();
  };

  overlay.querySelector('.paste-cancel')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('.paste-send')!.addEventListener('click', () => {
    if (ta.value) sendFn(ta.value);
    close();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') close();
    },
    { once: true },
  );
}

export function createExtraKeysBar(sendFn: SendFn): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'extra-keys-bar';

  let ctrlActive = false;
  let altActive = false;

  function clearModifiers() {
    ctrlActive = false;
    altActive = false;
    bar.querySelectorAll<HTMLButtonElement>('.mod-key').forEach((b) => {
      b.classList.remove('mod-active');
    });
  }

  /** Process a regular key with active modifiers applied */
  function sendWithModifiers(data: string) {
    let out = data;
    // Apply modifiers only to single printable characters
    if (data.length === 1 && ctrlActive) {
      out = ctrlKey(data);
    } else if (data.length === 1 && altActive) {
      out = altKey(data);
    }
    sendFn(out);
    clearModifiers();
  }

  for (const key of KEYS) {
    const btn = document.createElement('button');
    btn.className = 'extra-key' + (key.cls ? ` ${key.cls}` : '');
    btn.textContent = key.label;
    btn.setAttribute('tabindex', '-1'); // Don't steal focus from terminal

    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // Prevent focus change from terminal
    });

    btn.addEventListener('click', (e) => {
      // Skip preventDefault for Paste — the click event must be
      // "untouched" for the Clipboard API permission check on mobile.
      // pointerdown preventDefault already blocked the focus shift so
      // the keyboard won't pop up.
      if (key.action !== 'special:paste') e.preventDefault();

      if (key.action === 'special:paste') {
        // iOS Safari: Clipboard API readText() is unreliable (silently fails
        // or hangs without HTTPS / proper entitlement) — always use paste modal.
        if (!isIOS && navigator.clipboard?.readText) {
          navigator.clipboard
            .readText()
            .then((text) => {
              if (text) sendFn(text);
            })
            .catch(() => {
              showPasteModal(sendFn);
            });
        } else {
          showPasteModal(sendFn);
        }
        return;
      }

      if (key.action === 'mod:ctrl') {
        ctrlActive = !ctrlActive;
        altActive = false;
        bar.querySelectorAll<HTMLButtonElement>('.mod-key').forEach((b) => {
          b.classList.remove('mod-active');
        });
        if (ctrlActive) btn.classList.add('mod-active');
        return;
      }

      if (key.action === 'mod:alt') {
        altActive = !altActive;
        ctrlActive = false;
        bar.querySelectorAll<HTMLButtonElement>('.mod-key').forEach((b) => {
          b.classList.remove('mod-active');
        });
        if (altActive) btn.classList.add('mod-active');
        return;
      }

      // For special keys (multi-byte escape sequences), send directly
      if (key.action.length > 1 || key.action.charCodeAt(0) < 32) {
        // But if Ctrl is active and key is Esc/Tab, just send the key raw
        sendFn(key.action);
        clearModifiers();
      } else {
        sendWithModifiers(key.action);
      }
    });

    bar.appendChild(btn);
  }

  return bar;
}
