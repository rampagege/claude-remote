import { createTerminal, type TerminalInstance } from './terminal';
import { send, onMessage, isConnected } from './ws';
import { store, type TmuxSessionInfo } from './store';
import { showToast } from './toast';
import { createExtraKeysBar } from './extraKeys';

let tmuxTerm: TerminalInstance | null = null;

/** Track which sessions have their thumbnail collapsed */
const collapsedThumbs = new Set<string>();

/** Whether the tmux session list has been freshly fetched */
let listFresh = false;

/** Whether we're currently in the tmux terminal (attached) view */
let inTerminalView = false;

/** Auto-refresh interval for thumbnail list */
let refreshInterval: ReturnType<typeof setInterval> | null = null;

function stopAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  const secs = store.get('thumbRefresh');
  if (secs > 0) {
    refreshInterval = setInterval(() => {
      if (isConnected() && !inTerminalView) {
        send({ type: 'tmuxList' });
      }
    }, secs * 1000);
  }
}

/** Check if the tmux terminal view is active (tab bar should stay hidden). */
export function isTmuxAttached(): boolean {
  return inTerminalView;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openModal(overlay: HTMLElement): void {
  document.body.appendChild(overlay);
  // Trigger transition on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => overlay.classList.add('open'));
  });
}

function closeModal(overlay: HTMLElement): void {
  overlay.classList.remove('open');
  overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  // Safety fallback — remove after 300ms even if transitionend doesn't fire
  setTimeout(() => {
    if (overlay.parentNode) overlay.remove();
  }, 300);
}

// ── ANSI → HTML color converter ──────────────────────────────────

const ANSI_16 = [
  '#000',
  '#c00',
  '#0a0',
  '#c50',
  '#00d',
  '#c0c',
  '#0cc',
  '#ccc', // 0-7
  '#555',
  '#f55',
  '#5f5',
  '#ff5',
  '#55f',
  '#f5f',
  '#5ff',
  '#fff', // 8-15 (bright)
];

function ansi256(n: number): string {
  if (n < 16) return ANSI_16[n];
  if (n >= 232) {
    const g = 8 + (n - 232) * 10;
    return `rgb(${g},${g},${g})`;
  }
  const i = n - 16;
  const r = Math.floor(i / 36) * 51;
  const g = Math.floor((i % 36) / 6) * 51;
  const b = (i % 6) * 51;
  return `rgb(${r},${g},${b})`;
}

/** Convert ANSI-escaped text to HTML with color spans. */
function ansiToHtml(raw: string): string {
  let fg = '';
  let bg = '';
  let bold = false;
  let out = '';
  let spanOpen = false;

  // eslint-disable-next-line no-control-regex
  const parts = raw.split(/(\x1b\[[0-9;]*m)/);

  for (const part of parts) {
    if (part.startsWith('\x1b[')) {
      const codes = part.slice(2, -1).split(';').map(Number);
      let i = 0;
      while (i < codes.length) {
        const c = codes[i];
        if (c === 0) {
          fg = '';
          bg = '';
          bold = false;
        } else if (c === 1) {
          bold = true;
        } else if (c === 22) {
          bold = false;
        } else if (c >= 30 && c <= 37) {
          fg = ANSI_16[c - 30 + (bold ? 8 : 0)];
        } else if (c >= 90 && c <= 97) {
          fg = ANSI_16[c - 90 + 8];
        } else if (c === 39) {
          fg = '';
        } else if (c >= 40 && c <= 47) {
          bg = ANSI_16[c - 40];
        } else if (c >= 100 && c <= 107) {
          bg = ANSI_16[c - 100 + 8];
        } else if (c === 49) {
          bg = '';
        } else if (c === 38 && codes[i + 1] === 5) {
          fg = ansi256(codes[i + 2] ?? 0);
          i += 2;
        } else if (c === 48 && codes[i + 1] === 5) {
          bg = ansi256(codes[i + 2] ?? 0);
          i += 2;
        } else if (c === 38 && codes[i + 1] === 2) {
          fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
          i += 4;
        } else if (c === 48 && codes[i + 1] === 2) {
          bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
          i += 4;
        }
        i++;
      }
      // Close previous span and open new one if needed
      if (spanOpen) {
        out += '</span>';
        spanOpen = false;
      }
    } else {
      const text = escapeHtml(part);
      if (!text) continue;
      if (fg || bg) {
        const style = (fg ? `color:${fg};` : '') + (bg ? `background:${bg};` : '');
        out += `<span style="${style}">${text}</span>`;
        spanOpen = false; // inline spans, no state carry
      } else {
        out += text;
      }
    }
  }
  if (spanOpen) out += '</span>';
  return out;
}

const listView = () => document.getElementById('tmux-list-view') as HTMLElement;
const termView = () => document.getElementById('tmux-terminal-view') as HTMLElement;
const sessionsEl = () => document.getElementById('tmux-sessions') as HTMLElement;
const nameInput = () => document.getElementById('tmux-new-name') as HTMLInputElement;
const createBtn = () => document.getElementById('btn-new-tmux') as HTMLButtonElement;
const refreshBtn = () => document.getElementById('btn-refresh-tmux') as HTMLButtonElement;
const addBtn = () => document.getElementById('btn-add-tmux') as HTMLButtonElement;
const cancelBtn = () => document.getElementById('btn-cancel-tmux') as HTMLButtonElement;
const newBar = () => document.getElementById('tmux-new-bar') as HTMLElement;
const detachBtn = () => document.getElementById('btn-detach-tmux') as HTMLButtonElement;
const attachedName = () => document.getElementById('tmux-attached-name') as HTMLElement;
const termContainer = () => document.getElementById('tmux-terminal-container') as HTMLElement;
const statusDot = () => document.getElementById('tmux-status-dot') as HTMLElement;
const copyBtn = () => document.getElementById('btn-tmux-copy') as HTMLButtonElement;
const commandsBtn = () => document.getElementById('btn-tmux-commands') as HTMLButtonElement;
const windowTabsEl = () => document.getElementById('tmux-window-tabs') as HTMLElement;
const supervisorLogPanel = () => document.getElementById('supervisor-log-panel') as HTMLElement;
const supervisorLogEntries = () => document.getElementById('supervisor-log-entries') as HTMLElement;
const supervisorLogToggle = () =>
  document.getElementById('btn-toggle-supervisor-log') as HTMLButtonElement;

const supervisorLogs: Array<{ text: string; level: string; sessionName: string }> = [];
const MAX_SUPERVISOR_LOGS = 50;

function appendSupervisorLog(sessionName: string, text: string, level: string) {
  supervisorLogs.push({ sessionName, text, level });
  if (supervisorLogs.length > MAX_SUPERVISOR_LOGS) supervisorLogs.shift();
  renderSupervisorLog();
}

function renderSupervisorLog() {
  const panel = supervisorLogPanel();
  const sups = store.get('supervisedSessions');
  const hasActive = Object.keys(sups).length > 0;

  // Show panel when supervisor is enabled AND there are active supervisors or logs
  const enabled = store.get('supervisorEnabled');
  panel.classList.toggle('hidden', !enabled || (!hasActive && supervisorLogs.length === 0));

  const el = supervisorLogEntries();
  el.innerHTML = supervisorLogs
    .map((log) => {
      const color =
        log.level === 'error'
          ? 'text-red-500'
          : log.level === 'warn'
            ? 'text-amber-500'
            : 'text-zinc-500 dark:text-zinc-400';
      return `<div class="${color}"><span class="text-zinc-400 dark:text-zinc-600">[${escapeHtml(log.sessionName)}]</span> ${escapeHtml(log.text)}</div>`;
    })
    .join('');

  // Auto-scroll to bottom
  el.scrollTop = el.scrollHeight;
}

function renderSessions() {
  const sessions = store.get('tmuxSessions');
  const el = sessionsEl();

  if (sessions.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <svg class="w-10 h-10 mb-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 12h18M12 3v18" />
        </svg>
        <p>No tmux sessions</p>
        <p class="text-xs mt-1 opacity-60">Create one below to get started</p>
      </div>`;
    return;
  }

  const thumbPct = store.get('thumbHeight');
  // max height at 100% = 320px
  const thumbPx = Math.round((320 * thumbPct) / 100);
  const thumbEnabled = thumbPct > 0;

  el.innerHTML = sessions
    .map((s: TmuxSessionInfo) => {
      const hasThumb = thumbEnabled && !!s.preview;
      const isCollapsed = collapsedThumbs.has(s.name);
      const previewHtml =
        hasThumb && !isCollapsed
          ? `<div class="tmux-thumb-wrap" style="height:${thumbPx}px"><pre class="tmux-thumb">${ansiToHtml(s.preview)}</pre></div>`
          : '';
      // Chevron: down = expanded, right = collapsed
      const toggleBtn = hasThumb
        ? `<button class="tmux-toggle p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors" data-name="${s.name}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="transition-transform ${isCollapsed ? '-rotate-90' : ''}"><path d="M6 9l6 6 6-6"/></svg>
            </button>`
        : '';
      return `
      <div class="tmux-card" data-name="${s.name}">
        <div class="flex items-center justify-between w-full">
          <div class="flex items-center gap-2 min-w-0">
            ${s.attached ? '<span class="shrink-0 w-1.5 h-1.5 rounded-full bg-accent"></span>' : ''}
            <span class="text-sm font-medium truncate">${escapeHtml(s.name)}</span>
            <span class="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">${s.windows}w</span>
          </div>
          <div class="flex items-center gap-1 shrink-0 ml-2">
            ${
              store.get('supervisorEnabled')
                ? store.get('supervisedSessions')[s.name]
                  ? `<button class="tmux-unsupervise p-1.5 rounded-md text-amber-500 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/10 transition-colors" data-name="${s.name}" title="Stop AI Supervisor">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="2.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="19" cy="12" r="2.5"/><circle cx="5" cy="5" r="2.5"/><circle cx="12" cy="5" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="12" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/></svg>
                  </button>`
                  : `<button class="tmux-supervise p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors" data-name="${s.name}" title="AI Supervisor">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                  </button>`
                : ''
            }
            <button class="btn-accent tmux-attach" data-name="${s.name}">Attach</button>
            <button class="tmux-more relative p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors" data-name="${s.name}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
            </button>
            ${toggleBtn}
          </div>
        </div>
        ${previewHtml}
      </div>`;
    })
    .join('');

  // Attach
  el.querySelectorAll<HTMLButtonElement>('.tmux-attach').forEach((btn) => {
    btn.addEventListener('click', () => {
      attachToSession(btn.dataset.name!);
    });
  });

  // More menu (⋮)
  el.querySelectorAll<HTMLButtonElement>('.tmux-more').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.name!;
      showContextMenu(btn, name);
    });
  });

  // Thumbnail collapse toggle
  el.querySelectorAll<HTMLButtonElement>('.tmux-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.name!;
      if (collapsedThumbs.has(name)) {
        collapsedThumbs.delete(name);
      } else {
        collapsedThumbs.add(name);
      }
      renderSessions();
    });
  });

  // Supervise button
  el.querySelectorAll<HTMLButtonElement>('.tmux-supervise').forEach((btn) => {
    btn.addEventListener('click', () => {
      showSupervisorModal(btn.dataset.name!);
    });
  });

  // Unsupervise button
  el.querySelectorAll<HTMLButtonElement>('.tmux-unsupervise').forEach((btn) => {
    btn.addEventListener('click', () => {
      send({ type: 'supervisorStop', sessionName: btn.dataset.name! });
    });
  });
}

// ── Context Menu ──────────────────────────────────────────────────

let activeMenu: HTMLElement | null = null;

function closeContextMenu() {
  if (activeMenu) {
    const menu = activeMenu;
    activeMenu = null;
    menu.classList.remove('open');
    menu.addEventListener('transitionend', () => menu.remove(), { once: true });
    setTimeout(() => {
      if (menu.parentNode) menu.remove();
    }, 200);
  }
  document.removeEventListener('click', closeContextMenu);
}

function showContextMenu(anchor: HTMLElement, sessionName: string) {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className =
    'ctx-menu fixed z-50 min-w-[140px] py-1 rounded-lg shadow-lg border ' +
    'bg-white/85 dark:bg-zinc-800/85 border-zinc-200 dark:border-zinc-700 backdrop-blur-sm';
  menu.innerHTML = `
    <button class="ctx-rename w-full text-left px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-2">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      Rename
    </button>
    <button class="ctx-kill w-full text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors flex items-center gap-2">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
      Kill
    </button>
  `;

  // Position with fixed coordinates so the menu escapes overflow containers
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const menuHeight = 88; // approximate: 2 items × 40px + padding
  const spaceBelow = window.innerHeight - rect.bottom;
  // Show above if not enough space below
  if (spaceBelow < menuHeight + 8) {
    menu.style.top = `${rect.top - menuHeight - 4}px`;
  } else {
    menu.style.top = `${rect.bottom + 4}px`;
  }
  menu.style.right = `${window.innerWidth - rect.right}px`;
  activeMenu = menu;

  // Trigger open animation on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => menu.classList.add('open'));
  });

  // Rename
  menu.querySelector('.ctx-rename')!.addEventListener('click', (e) => {
    e.stopPropagation();
    closeContextMenu();
    showRenameModal(sessionName);
  });

  // Kill with confirmation
  menu.querySelector('.ctx-kill')!.addEventListener('click', (e) => {
    e.stopPropagation();
    closeContextMenu();
    showKillConfirm(sessionName);
  });

  // Close on outside click (next tick so this click doesn't close it)
  requestAnimationFrame(() => {
    document.addEventListener('click', closeContextMenu);
  });
}

function showKillConfirm(sessionName: string) {
  const overlay = document.createElement('div');
  overlay.className =
    'modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4';
  overlay.innerHTML = `
    <div class="modal-dialog w-full max-w-xs rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl overflow-hidden">
      <div class="p-4 text-center">
        <div class="mx-auto w-10 h-10 rounded-full bg-red-100 dark:bg-red-950/40 flex items-center justify-center mb-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="text-red-600 dark:text-red-400">
            <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
          </svg>
        </div>
        <p class="text-sm font-medium mb-1">Kill session?</p>
        <p class="text-xs text-zinc-500 dark:text-zinc-400">Session <span class="font-mono font-medium text-zinc-700 dark:text-zinc-300">${escapeHtml(sessionName)}</span> will be terminated.</p>
      </div>
      <div class="flex border-t border-zinc-200 dark:border-zinc-700">
        <button class="confirm-cancel flex-1 py-2.5 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors">Cancel</button>
        <button class="confirm-kill flex-1 py-2.5 text-sm font-medium text-red-600 dark:text-red-400 border-l border-zinc-200 dark:border-zinc-700 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors">Kill</button>
      </div>
    </div>
  `;

  openModal(overlay);

  overlay.querySelector('.confirm-cancel')!.addEventListener('click', () => {
    closeModal(overlay);
  });

  overlay.querySelector('.confirm-kill')!.addEventListener('click', () => {
    closeModal(overlay);
    send({ type: 'tmuxKill', name: sessionName });
  });

  // Close on backdrop click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay);
  });
}

function showRenameModal(sessionName: string) {
  const overlay = document.createElement('div');
  overlay.className =
    'modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4';
  overlay.innerHTML = `
    <div class="modal-dialog w-full max-w-xs rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl overflow-hidden">
      <div class="p-4">
        <p class="text-sm font-medium mb-3">Rename session</p>
        <input id="rename-input" type="text" value="${escapeHtml(sessionName)}"
          class="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-600 bg-zinc-50 dark:bg-zinc-700/50 outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 font-mono" />
      </div>
      <div class="flex border-t border-zinc-200 dark:border-zinc-700">
        <button class="rename-cancel flex-1 py-2.5 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors">Cancel</button>
        <button class="rename-confirm flex-1 py-2.5 text-sm font-medium text-accent border-l border-zinc-200 dark:border-zinc-700 hover:bg-accent/5 transition-colors">Rename</button>
      </div>
    </div>
  `;

  openModal(overlay);

  const input = overlay.querySelector('#rename-input') as HTMLInputElement;
  input.select();
  input.focus();

  const doRename = () => {
    const newName = input.value.trim();
    if (newName && newName !== sessionName) {
      send({ type: 'tmuxRename', from: sessionName, to: newName });
    }
    closeModal(overlay);
  };

  overlay.querySelector('.rename-cancel')!.addEventListener('click', () => closeModal(overlay));
  overlay.querySelector('.rename-confirm')!.addEventListener('click', doRename);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doRename();
    if (e.key === 'Escape') closeModal(overlay);
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay);
  });
}

function showSupervisorModal(sessionName: string) {
  let selectedMode: 'auto' | 'confirm' | 'watch' = 'confirm';

  const overlay = document.createElement('div');
  overlay.className =
    'modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4';
  overlay.innerHTML = `
    <div class="modal-dialog w-full max-w-xs rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl overflow-hidden">
      <div class="p-4">
        <p class="text-sm font-medium mb-3">AI Supervisor</p>
        <textarea id="supervisor-goal" rows="3" placeholder="Describe your goal, e.g. 'Build a todo app, approve all prompts'"
          class="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-600 bg-zinc-50 dark:bg-zinc-700/50 outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 resize-none"></textarea>
        <div class="flex gap-2 mt-3">
          <button class="sup-mode flex-1 px-2 py-1.5 text-xs font-medium rounded-md border border-zinc-300 dark:border-zinc-600 transition-colors" data-mode="auto">Auto</button>
          <button class="sup-mode flex-1 px-2 py-1.5 text-xs font-medium rounded-md border border-accent bg-accent/10 text-accent transition-colors" data-mode="confirm">Confirm</button>
          <button class="sup-mode flex-1 px-2 py-1.5 text-xs font-medium rounded-md border border-zinc-300 dark:border-zinc-600 transition-colors" data-mode="watch">Watch</button>
        </div>
      </div>
      <div class="flex border-t border-zinc-200 dark:border-zinc-700">
        <button class="sup-cancel flex-1 py-2.5 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors">Cancel</button>
        <button class="sup-start flex-1 py-2.5 text-sm font-medium text-accent border-l border-zinc-200 dark:border-zinc-700 hover:bg-accent/5 transition-colors">Start</button>
      </div>
    </div>
  `;

  openModal(overlay);

  const goalInput = overlay.querySelector('#supervisor-goal') as HTMLTextAreaElement;
  goalInput.focus();

  // Mode selection
  overlay.querySelectorAll<HTMLButtonElement>('.sup-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedMode = btn.dataset.mode as 'auto' | 'confirm' | 'watch';
      overlay.querySelectorAll<HTMLButtonElement>('.sup-mode').forEach((b) => {
        b.classList.remove('border-accent', 'bg-accent/10', 'text-accent');
        b.classList.add('border-zinc-300', 'dark:border-zinc-600');
      });
      btn.classList.remove('border-zinc-300', 'dark:border-zinc-600');
      btn.classList.add('border-accent', 'bg-accent/10', 'text-accent');
    });
  });

  overlay.querySelector('.sup-cancel')!.addEventListener('click', () => closeModal(overlay));

  overlay.querySelector('.sup-start')!.addEventListener('click', () => {
    const goal = goalInput.value.trim();
    send({ type: 'supervisorStart', sessionName, goal, mode: selectedMode });
    closeModal(overlay);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay);
  });
}

function showConfirmActionModal(
  sessionName: string,
  actionId: string,
  suggestion: string,
  reasoning: string,
) {
  const overlay = document.createElement('div');
  overlay.className =
    'modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4';
  overlay.innerHTML = `
    <div class="modal-dialog w-full max-w-xs rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl overflow-hidden">
      <div class="p-4">
        <div class="flex items-center gap-2 mb-2">
          <span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
          <p class="text-sm font-medium">AI Suggestion</p>
        </div>
        <p class="text-xs text-zinc-500 dark:text-zinc-400 mb-2">${escapeHtml(reasoning)}</p>
        <div class="px-3 py-2 rounded-md bg-zinc-100 dark:bg-zinc-700/50 font-mono text-sm">${escapeHtml(suggestion)}</div>
      </div>
      <div class="flex border-t border-zinc-200 dark:border-zinc-700">
        <button class="confirm-stop flex-1 py-2.5 text-sm font-medium text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors">Stop</button>
        <button class="confirm-reject flex-1 py-2.5 text-sm font-medium text-red-600 dark:text-red-400 border-l border-zinc-200 dark:border-zinc-700 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors">Reject</button>
        <button class="confirm-approve flex-1 py-2.5 text-sm font-medium text-accent border-l border-zinc-200 dark:border-zinc-700 hover:bg-accent/5 transition-colors">Approve</button>
      </div>
    </div>
  `;

  openModal(overlay);

  overlay.querySelector('.confirm-stop')!.addEventListener('click', () => {
    send({ type: 'supervisorConfirm', sessionName, actionId, approved: false });
    send({ type: 'supervisorStop', sessionName });
    closeModal(overlay);
  });

  overlay.querySelector('.confirm-reject')!.addEventListener('click', () => {
    send({ type: 'supervisorConfirm', sessionName, actionId, approved: false });
    closeModal(overlay);
  });

  overlay.querySelector('.confirm-approve')!.addEventListener('click', () => {
    send({ type: 'supervisorConfirm', sessionName, actionId, approved: true });
    closeModal(overlay);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay);
  });
}

/** Track store subscription for status dot so we can unsubscribe */
let statusDotUnsub: (() => void) | null = null;

/** Track window tab polling interval */
let windowTabsInterval: ReturnType<typeof setInterval> | null = null;

/** Current attached session name (for command palette / copy / window tabs) */
let currentSessionName = '';

// ── Command Palette (bottom sheet) ────────────────────────────────

function showCommandPalette(name: string) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-sheet';

  const commands = [
    { label: 'Split \u2194', command: 'splitH', icon: 'M12 3v18M3 12h18' },
    { label: 'Split \u2195', command: 'splitV', icon: 'M3 12h18M12 3v18' },
    { label: 'New Win', command: 'newWindow', icon: 'M12 5v14M5 12h14' },
    { label: 'Next Win', command: 'nextWindow', icon: 'M9 18l6-6-6-6' },
    { label: 'Prev Win', command: 'prevWindow', icon: 'M15 18l-6-6 6-6' },
    { label: 'Next Pane', command: 'nextPane', icon: 'M7 2l10 10L7 22' },
    { label: 'Zoom', command: 'zoomPane', icon: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7' },
    { label: 'Kill Pane', command: 'killPane', icon: 'M18 6L6 18M6 6l12 12' },
  ];

  overlay.innerHTML = `
    <div class="modal-sheet-content p-4">
      <div class="flex items-center justify-between mb-3">
        <span class="text-sm font-semibold">Tmux Commands</span>
        <button class="sheet-close p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="grid grid-cols-4 gap-2">
        ${commands
          .map(
            (c) => `
          <button class="cmd-btn btn-secondary flex flex-col items-center gap-1 p-3 rounded-lg" data-cmd="${c.command}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${c.icon}"/></svg>
            <span class="text-[10px]">${c.label}</span>
          </button>
        `,
          )
          .join('')}
      </div>
    </div>
  `;

  openModal(overlay);

  overlay.querySelector('.sheet-close')!.addEventListener('click', () => closeModal(overlay));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay);
  });

  overlay.querySelectorAll<HTMLButtonElement>('.cmd-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      send({ type: 'tmuxCommand', name, command: btn.dataset.cmd! } as never);
      closeModal(overlay);
    });
  });
}

// ── Clipboard helper ─────────────────────────────────────────────

/** execCommand('copy') fallback for iOS Safari / non-HTTPS contexts. */
function fallbackCopyText(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.setSelectionRange(0, text.length); // iOS requires explicit range
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    /* ignore */
  }
  ta.remove();
  return ok;
}

// ── Capture / Copy Modal ─────────────────────────────────────────

function showCaptureModal(text: string) {
  const overlay = document.createElement('div');
  overlay.className =
    'modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4';
  overlay.innerHTML = `
    <div class="modal-dialog w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-xl"
         style="height:70vh;display:flex;flex-direction:column;touch-action:manipulation">
      <div class="shrink-0 flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 rounded-t-xl">
        <span class="text-sm font-semibold">Terminal Content</span>
        <button class="capture-close p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="capture-scroll" style="flex:1;height:0;overflow-y:scroll;-webkit-overflow-scrolling:touch;touch-action:pan-y">
        <pre class="p-4 pb-8 text-xs font-mono text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap"
             style="user-select:text;-webkit-user-select:text;margin:0;touch-action:pan-y"></pre>
      </div>
      <div class="shrink-0 flex items-center justify-end gap-1.5 px-3 py-2 border-t border-zinc-200 dark:border-zinc-700 rounded-b-xl">
        <button class="capture-up btn-accent" aria-label="Scroll up">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
        </button>
        <button class="capture-down btn-accent" aria-label="Scroll down">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <button class="capture-copy btn-accent">Copy All</button>
      </div>
    </div>
  `;

  // Set text content safely (no XSS)
  overlay.querySelector('pre')!.textContent = text;

  openModal(overlay);

  const scrollBox = overlay.querySelector('.capture-scroll') as HTMLElement;

  // Scroll to bottom so the most recent output is visible
  requestAnimationFrame(() => {
    scrollBox.scrollTop = scrollBox.scrollHeight;
  });

  overlay.querySelector('.capture-up')!.addEventListener('click', () => {
    scrollBox.scrollTop = Math.max(
      0,
      scrollBox.scrollTop - Math.max(100, scrollBox.clientHeight * 0.8),
    );
  });
  overlay.querySelector('.capture-down')!.addEventListener('click', () => {
    scrollBox.scrollTop += Math.max(100, scrollBox.clientHeight * 0.8);
  });
  overlay.querySelector('.capture-copy')!.addEventListener('click', () => {
    // execCommand('copy') is deprecated but remains the only fallback
    // for non-HTTPS contexts where Clipboard API is unavailable.
    const copyViaFallback = () => {
      if (fallbackCopyText(text)) {
        showToast('Copied to clipboard');
        closeModal(overlay);
      } else {
        showToast('Copy failed — select text manually', 'error');
      }
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          showToast('Copied to clipboard');
          closeModal(overlay);
        })
        .catch(copyViaFallback);
    } else {
      copyViaFallback();
    }
  });
  overlay.querySelector('.capture-close')!.addEventListener('click', () => closeModal(overlay));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay);
  });
}

// ── Window Tab Bar ───────────────────────────────────────────────

interface WindowInfo {
  index: number;
  name: string;
  active: boolean;
  panes: number;
}

function renderWindowTabs(session: string, windows: WindowInfo[]) {
  const el = windowTabsEl();
  if (windows.length <= 1) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = windows
    .map(
      (w) => `
    <button class="win-tab shrink-0 px-3 py-1 text-xs font-medium rounded-md transition-colors
      ${w.active ? 'bg-accent text-white' : 'bg-white dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-600'}"
      data-idx="${w.index}">
      ${w.index}:${escapeHtml(w.name)}${w.panes > 1 ? ` (${w.panes})` : ''}
    </button>
  `,
    )
    .join('');

  el.querySelectorAll<HTMLButtonElement>('.win-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      send({
        type: 'tmuxSelectWindow',
        name: session,
        index: parseInt(btn.dataset.idx!, 10),
      } as never);
      // Request updated window list after a short delay
      setTimeout(() => send({ type: 'tmuxListWindows', name: session } as never), 200);
    });
  });

  // Auto-scroll to active tab
  const activeTab = el.querySelector('.bg-accent');
  if (activeTab) activeTab.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function updateTerminalStatusDot(status: string) {
  const dot = statusDot();
  if (!dot) return;
  if (status === 'connected') {
    dot.className = 'w-2 h-2 rounded-full bg-accent shrink-0';
  } else if (status === 'connecting') {
    dot.className = 'w-2 h-2 rounded-full bg-yellow-500 shrink-0 animate-pulse';
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-red-500 shrink-0';
  }
}

/** Create terminal view and return dimensions (does NOT send attach yet). */
function showTerminalView(name: string): { cols: number; rows: number } {
  stopAutoRefresh();
  listView().classList.add('hidden');
  termView().classList.remove('hidden');
  attachedName().textContent = `tmux: ${name}`;
  currentSessionName = name;

  // Status dot — show current connection state + subscribe
  updateTerminalStatusDot(store.get('status'));
  statusDotUnsub = store.subscribe((state, key) => {
    if (key === 'status') updateTerminalStatusDot(state.status);
  });

  // Hide bottom tab bar for maximum terminal space
  inTerminalView = true;
  document.getElementById('app-nav')?.classList.add('hidden');

  // Wire command palette button
  commandsBtn().onclick = () => showCommandPalette(name);

  // Wire copy button
  copyBtn().onclick = () => {
    if (!isConnected()) {
      showToast('Not connected', 'error');
      return;
    }
    send({ type: 'tmuxCapture', name } as never);
  };

  // Request window list + start polling
  if (isConnected()) {
    send({ type: 'tmuxListWindows', name } as never);
  }
  windowTabsInterval = setInterval(() => {
    if (isConnected() && inTerminalView) {
      send({ type: 'tmuxListWindows', name } as never);
    }
  }, 5000);

  const container = termContainer();
  container.innerHTML = '';

  // Setup extra keys bar
  const keysEl = document.getElementById('tmux-extra-keys')!;
  keysEl.innerHTML = '';
  keysEl.appendChild(
    createExtraKeysBar((data) => {
      if (!isConnected()) {
        showToast('Not connected to server', 'error');
        return;
      }
      // PgUp/PgDn: use tmux copy-mode server-side for reliable scrollback
      if (data === '\x1b[5~') {
        send({ type: 'tmuxScroll', name, direction: 'up' });
        return;
      }
      if (data === '\x1b[6~') {
        send({ type: 'tmuxScroll', name, direction: 'down' });
        return;
      }
      send({ type: 'input', data });
    }),
  );

  tmuxTerm = createTerminal();

  // Attach handlers BEFORE mount so initial fit() triggers resize
  tmuxTerm.onInput((data) => {
    if (!isConnected()) {
      showToast('Not connected to server', 'error');
      return;
    }
    send({ type: 'input', data });
  });

  tmuxTerm.onResize((cols, rows) => {
    send({ type: 'resize', cols, rows });
  });

  tmuxTerm.mount(container);
  // Don't auto-focus — on mobile this opens the keyboard immediately.
  // User can tap the terminal to focus when they want to type.

  return tmuxTerm.getDimensions();
}

/** Attach to a tmux session: create terminal first, then send with correct dimensions. */
function attachToSession(name: string) {
  const { cols, rows } = showTerminalView(name);
  store.set('activeTmuxSession', `tmux:${name}`);
  store.set('lastTmuxSession', name);
  send({ type: 'tmuxAttach', name, cols, rows });
}

/** Re-attach to the last tmux session after a WebSocket reconnect. */
export function reattachTmux(): void {
  const name = store.get('lastTmuxSession');
  if (!name) return;

  if (tmuxTerm) {
    // Fast path: terminal still exists, just re-send attach + window list
    const { cols, rows } = tmuxTerm.getDimensions();
    store.set('activeTmuxSession', `tmux:${name}`);
    send({ type: 'tmuxAttach', name, cols, rows });
    send({ type: 'tmuxListWindows', name } as never);
  } else {
    // Full re-attach (e.g. after page refresh)
    attachToSession(name);
  }
}

function showListView() {
  termView().classList.add('hidden');
  listView().classList.remove('hidden');

  // Restore bottom tab bar
  inTerminalView = false;
  startAutoRefresh();
  document.getElementById('app-nav')?.classList.remove('hidden');

  // Clean up status dot subscription
  if (statusDotUnsub) {
    statusDotUnsub();
    statusDotUnsub = null;
  }

  // Stop window tab polling
  if (windowTabsInterval) {
    clearInterval(windowTabsInterval);
    windowTabsInterval = null;
  }
  windowTabsEl().classList.add('hidden');

  currentSessionName = '';

  if (tmuxTerm) {
    tmuxTerm.dispose();
    tmuxTerm = null;
  }
  document.getElementById('tmux-extra-keys')!.innerHTML = '';
}

function updateStaleIndicator() {
  const icon = document.getElementById('tmux-stale-icon');
  if (icon) icon.classList.toggle('hidden', listFresh);
}

/** Mark the session list as stale (e.g. after a period of time or on reconnect). */
export function markTmuxStale(): void {
  listFresh = false;
  updateStaleIndicator();
}

function toggleNewBar(show?: boolean) {
  const bar = newBar();
  const visible = show ?? bar.classList.contains('hidden');
  bar.classList.toggle('hidden', !visible);
  if (visible) {
    nameInput().value = '';
    nameInput().focus();
  }
}

export function initTmux(): void {
  // Show stale indicator until first fetch
  updateStaleIndicator();

  // "+" button toggles the new session bar
  addBtn().addEventListener('click', () => toggleNewBar());

  // Cancel button hides it
  cancelBtn().addEventListener('click', () => toggleNewBar(false));

  // Create button
  createBtn().addEventListener('click', () => {
    const name = nameInput().value.trim();
    if (!name) {
      showToast('Enter a session name', 'error');
      return;
    }
    send({ type: 'tmuxNew', name });
    toggleNewBar(false);
  });

  nameInput().addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createBtn().click();
    if (e.key === 'Escape') toggleNewBar(false);
  });

  refreshBtn().addEventListener('click', () => {
    send({ type: 'tmuxList' });
  });

  detachBtn().addEventListener('click', () => {
    send({ type: 'tmuxDetach' });
    showListView();
    send({ type: 'tmuxList' });
  });

  supervisorLogToggle().addEventListener('click', () => {
    const entries = supervisorLogEntries();
    entries.classList.toggle('hidden');
  });

  onMessage((msg) => {
    switch (msg.type) {
      case 'tmuxSessionList': {
        const sessions = msg.sessions as TmuxSessionInfo[];
        store.set('tmuxSessions', sessions); // triggers renderSessions via subscriber
        listFresh = true;
        updateStaleIndicator();
        break;
      }

      case 'ready': {
        // Terminal already created in attachToSession() — nothing to do here
        break;
      }

      case 'output': {
        const sid = msg.sessionId as string;
        if (sid === store.get('activeTmuxSession') && tmuxTerm) {
          tmuxTerm.write(msg.data as string);
        }
        break;
      }

      case 'tmuxCaptureResult': {
        showCaptureModal(msg.text as string);
        break;
      }

      case 'tmuxWindowList': {
        if (inTerminalView && currentSessionName) {
          renderWindowTabs(currentSessionName, msg.windows as WindowInfo[]);
        }
        break;
      }

      case 'supervisorStatus': {
        const sups = { ...store.get('supervisedSessions') };
        if (msg.active) {
          sups[msg.sessionName as string] = {
            goal: msg.goal as string,
            mode: msg.mode as 'auto' | 'confirm' | 'watch',
          };
        } else {
          delete sups[msg.sessionName as string];
        }
        store.set('supervisedSessions', sups); // triggers renderSessions via subscriber
        renderSupervisorLog();
        break;
      }

      case 'supervisorAction': {
        if (msg.waitingForConfirm) {
          showConfirmActionModal(
            msg.sessionName as string,
            msg.actionId as string,
            msg.suggestion as string,
            msg.reasoning as string,
          );
        } else {
          showToast(`AI sent: ${msg.suggestion}`, 'info');
        }
        break;
      }

      case 'serverFeatures': {
        store.set('supervisorEnabled', !!msg.supervisorEnabled);
        break;
      }

      case 'supervisorLog': {
        const level = msg.level as string;
        const sessionName = msg.sessionName as string;
        const text = msg.text as string;
        appendSupervisorLog(sessionName, text, level);
        if (level === 'error') {
          showToast(`[${sessionName}] ${text}`, 'error');
        }
        break;
      }
    }
  });

  store.subscribe((_state, key) => {
    if (
      key === 'tmuxSessions' ||
      key === 'thumbHeight' ||
      key === 'supervisedSessions' ||
      key === 'supervisorEnabled'
    ) {
      renderSessions();
    }
    if (key === 'thumbRefresh') {
      startAutoRefresh();
    }
  });

  startAutoRefresh();
}

export function refreshTmux(): void {
  send({ type: 'tmuxList' });
}
