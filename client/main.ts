import './style.css';
import { initRouter, onTab, switchTab } from './lib/router';
import { initTmux, refreshTmux, markTmuxStale, isTmuxAttached, reattachTmux } from './lib/tmux';
import { initSettings } from './lib/settings';
import { initUsage } from './lib/usage';
import { initStatus } from './lib/status';
import { connect, onMessage } from './lib/ws';
import { store } from './lib/store';
import { showToast } from './lib/toast';
import { initRipple } from './lib/ripple';

// ── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initRouter();
  initRipple();
  initTmux();
  initSettings();
  initUsage();
  initStatus();

  // Tab change hooks
  onTab((tab) => {
    if (tab === 'tmux') refreshTmux();
  });

  // Auth result handler
  onMessage((msg) => {
    if (msg.type === 'authResult') {
      if (msg.success) {
        showToast('Connected');
        // Auto-reattach if we were in a tmux session, otherwise refresh list
        if (isTmuxAttached()) {
          reattachTmux();
        } else {
          refreshTmux();
        }
      } else {
        showToast('Authentication failed', 'error');
        switchTab('settings');
      }
    }
  });

  // Mark tmux list stale on disconnect so the indicator shows
  store.subscribe((_state, key) => {
    if (key === 'status' && store.get('status') === 'disconnected') {
      markTmuxStale();
    }
  });

  // Auto-connect if we have settings
  const url = store.get('serverUrl');
  if (url) {
    connect();
  }

  // ── iOS keyboard viewport handling ──────────────────────────────
  initKeyboardViewport();

  // PWA install prompt
  let deferredPrompt: BeforeInstallPromptEvent | null = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;

    // Show install banner
    const banner = document.createElement('div');
    banner.className =
      'fixed bottom-20 left-4 right-4 max-w-lg mx-auto p-3 rounded-xl bg-white dark:bg-zinc-800 shadow-xl border border-zinc-200 dark:border-zinc-700 flex items-center gap-3 z-50';
    banner.innerHTML = `
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium">Install TmuxFly</p>
        <p class="text-xs text-zinc-500 dark:text-zinc-400">Add to home screen for the best experience</p>
      </div>
      <button id="pwa-install" class="shrink-0 px-3 py-1.5 text-sm font-medium rounded-lg bg-accent text-white">Install</button>
      <button id="pwa-dismiss" class="shrink-0 p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">&times;</button>
    `;
    document.body.appendChild(banner);

    document.getElementById('pwa-install')?.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
      }
      banner.remove();
    });

    document.getElementById('pwa-dismiss')?.addEventListener('click', () => {
      banner.remove();
    });
  });
});

// Type for PWA install prompt
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// ── Virtual keyboard handling (iOS + Android) ────────────────────
// Uses visualViewport API to detect keyboard and adjust the fixed app shell.
// On Android with interactive-widget=resizes-content, this is mostly a no-op.
// On iOS, this is required since the keyboard overlays the viewport.

function initKeyboardViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;

  const appEl = document.getElementById('app')!;
  const navEl = document.getElementById('app-nav')!;
  const THRESHOLD = 100; // px — anything smaller is the address bar, not keyboard

  let keyboardOpen = false;

  function update() {
    const offset = window.innerHeight - vv!.height;
    const isOpen = offset > THRESHOLD;

    if (isOpen !== keyboardOpen) {
      keyboardOpen = isOpen;
      if (isOpen) {
        // Unset bottom so height takes effect (top+bottom would override height)
        appEl.style.bottom = 'auto';
        appEl.style.top = `${vv!.offsetTop}px`;
        appEl.style.height = `${vv!.height}px`;
        document.documentElement.classList.add('kb-open');
        navEl.classList.add('hidden');
      } else {
        appEl.style.height = '';
        appEl.style.bottom = '';
        appEl.style.top = '';
        document.documentElement.classList.remove('kb-open');
        // Only restore nav if not in tmux attached view
        if (!isTmuxAttached()) {
          navEl.classList.remove('hidden');
        }
      }
    }

    // Also handle iOS scroll offset (keyboard can shift visualViewport)
    if (isOpen) {
      appEl.style.top = `${vv!.offsetTop}px`;
      appEl.style.height = `${vv!.height}px`;
    }
  }

  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
}
