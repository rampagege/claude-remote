export type Tab = 'tmux' | 'settings';
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
  preview: string;
}

export interface AppState {
  tab: Tab;
  status: ConnectionStatus;
  activeTmuxSession: string | null;
  tmuxSessions: TmuxSessionInfo[];
  serverUrl: string;
  token: string;
  darkMode: boolean;
  thumbHeight: number; // 0-100, percentage height for tmux thumbnails (0 = off)
  thumbRefresh: number; // auto-refresh interval in seconds (0 = off, 5, 10, 30)
  fontSize: number; // terminal font size in px (10-24)
  lastTmuxSession: string; // last attached tmux session name for auto-reattach
  supervisorEnabled: boolean; // server-side feature flag
  supervisedSessions: Record<string, { goal: string; mode: 'auto' | 'confirm' | 'watch' }>;
}

type Listener = (state: AppState, key: keyof AppState) => void;

const STORAGE_KEY = 'tmuxfly_settings';

function loadSettings(): Partial<AppState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}

function saveSettings(state: AppState) {
  const persist = {
    serverUrl: state.serverUrl,
    token: state.token,
    darkMode: state.darkMode,
    thumbHeight: state.thumbHeight,
    thumbRefresh: state.thumbRefresh,
    fontSize: state.fontSize,
    lastTmuxSession: state.lastTmuxSession,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
}

function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

const saved = loadSettings();

const state: AppState = {
  tab: 'tmux',
  status: 'disconnected',
  activeTmuxSession: null,
  tmuxSessions: [],
  serverUrl: saved.serverUrl || defaultWsUrl(),
  token: saved.token || '',
  darkMode: saved.darkMode ?? true,
  thumbHeight: saved.thumbHeight ?? 50,
  thumbRefresh: saved.thumbRefresh ?? 0,
  fontSize: saved.fontSize ?? 14,
  lastTmuxSession: saved.lastTmuxSession || '',
  supervisorEnabled: false,
  supervisedSessions: {},
};

const listeners = new Set<Listener>();

export const store = {
  get<K extends keyof AppState>(key: K): AppState[K] {
    return state[key];
  },

  set<K extends keyof AppState>(key: K, value: AppState[K]) {
    state[key] = value;
    listeners.forEach((fn) => fn(state, key));
    if (
      [
        'serverUrl',
        'token',
        'darkMode',
        'thumbHeight',
        'thumbRefresh',
        'fontSize',
        'lastTmuxSession',
      ].includes(key)
    ) {
      saveSettings(state);
    }
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  getState(): Readonly<AppState> {
    return state;
  },
};
