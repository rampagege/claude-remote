import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { store } from './store';

export interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  mount(container: HTMLElement): void;
  dispose(): void;
  write(data: string): void;
  onInput(handler: (data: string) => void): void;
  onResize(handler: (cols: number, rows: number) => void): void;
  getDimensions(): { cols: number; rows: number };
  fit(): void;
  focus(): void;
  findNext(term: string): boolean;
  findPrevious(term: string): boolean;
}

const THEME_DARK = {
  background: '#09090b',
  foreground: '#e4e4e7',
  cursor: '#10b981',
  cursorAccent: '#09090b',
  selectionBackground: '#27272a',
  selectionForeground: '#e4e4e7',
  black: '#18181b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#d4d4d8',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa',
};

const THEME_LIGHT = {
  background: '#fafafa',
  foreground: '#27272a',
  cursor: '#059669',
  cursorAccent: '#fafafa',
  selectionBackground: '#e4e4e7',
  selectionForeground: '#27272a',
  black: '#f4f4f5',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#3f3f46',
  brightBlack: '#a1a1aa',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#18181b',
};

export function createTerminal(opts?: { scrollback?: number }): TerminalInstance {
  const isDark = store.get('darkMode');

  const terminal = new Terminal({
    fontFamily: "'JetBrains Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    fontSize: store.get('fontSize'),
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    theme: isDark ? THEME_DARK : THEME_LIGHT,
    allowProposedApi: true,
    scrollback: opts?.scrollback ?? 5000,
    convertEol: true,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.loadAddon(searchAddon);

  let resizeObserver: ResizeObserver | null = null;

  // Listen for theme and font size changes
  const unsub = store.subscribe((state, key) => {
    if (key === 'darkMode') {
      terminal.options.theme = state.darkMode ? THEME_DARK : THEME_LIGHT;
    }
    if (key === 'fontSize') {
      terminal.options.fontSize = state.fontSize;
      requestAnimationFrame(() => fitAddon.fit());
    }
  });

  return {
    terminal,
    fitAddon,
    searchAddon,

    mount(el: HTMLElement) {
      terminal.open(el);
      fitAddon.fit();

      resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => fitAddon.fit());
      });
      resizeObserver.observe(el);
    },

    dispose() {
      resizeObserver?.disconnect();
      unsub();
      terminal.dispose();
    },

    write(data: string) {
      terminal.write(data);
    },

    onInput(handler: (data: string) => void) {
      terminal.onData(handler);
    },

    onResize(handler: (cols: number, rows: number) => void) {
      terminal.onResize(({ cols, rows }) => handler(cols, rows));
    },

    getDimensions() {
      return { cols: terminal.cols, rows: terminal.rows };
    },

    fit() {
      fitAddon.fit();
    },

    focus() {
      terminal.focus();
    },

    findNext(query: string) {
      return searchAddon.findNext(query);
    },

    findPrevious(query: string) {
      return searchAddon.findPrevious(query);
    },
  };
}
