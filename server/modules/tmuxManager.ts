import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import type { Logger } from 'pino';
import type { TmuxSessionInfo, TmuxWindowInfo, ServerConfig } from '../types.js';

const exec = promisify(execFile);

const VALID_SESSION_NAME = /^[a-zA-Z0-9_-]+$/;

export class TmuxManager {
  private attachedPtys = new Map<string, import('node-pty').IPty>();
  private log: Logger;
  private config: ServerConfig;

  constructor(log: Logger, config: ServerConfig) {
    this.log = log.child({ module: 'tmux' });
    this.config = config;
  }

  private validateName(name: string): void {
    if (!name || !VALID_SESSION_NAME.test(name)) {
      throw new Error('Invalid session name (use only a-z, 0-9, _, -)');
    }
  }

  /** Capture the full visible pane content with ANSI colors for thumbnail rendering. */
  private async capturePreview(name: string): Promise<string> {
    try {
      const { stdout } = await exec('tmux', ['capture-pane', '-t', name, '-p', '-e']);
      return stdout;
    } catch {
      return '';
    }
  }

  /** List all tmux sessions. */
  async list(): Promise<TmuxSessionInfo[]> {
    try {
      const { stdout } = await exec('tmux', [
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}',
      ]);

      const sessions = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, windows, created, attached] = line.split('\t');
          return {
            name,
            windows: parseInt(windows, 10),
            created: new Date(parseInt(created, 10) * 1000).toISOString(),
            attached: attached !== '0',
          };
        });

      // Capture previews in parallel
      const previews = await Promise.all(sessions.map((s) => this.capturePreview(s.name)));

      return sessions.map((s, i) => ({ ...s, preview: previews[i] }));
    } catch (err) {
      const msg = (err as Error).message || '';
      if (
        msg.includes('no server running') ||
        msg.includes('no sessions') ||
        msg.includes('No such file or directory')
      ) {
        return [];
      }
      throw err;
    }
  }

  /** Create a new tmux session. */
  async create(name: string): Promise<void> {
    this.validateName(name);

    const sessions = await this.list();
    if (sessions.length >= this.config.maxTmuxSessions) {
      throw new Error(`Max tmux sessions (${this.config.maxTmuxSessions}) reached`);
    }

    await exec('tmux', ['new-session', '-d', '-s', name]);
    this.log.info({ name }, 'tmux session created');
  }

  /** Kill a tmux session. */
  async kill(name: string): Promise<void> {
    this.validateName(name);
    await exec('tmux', ['kill-session', '-t', name]);
    this.log.info({ name }, 'tmux session killed');
  }

  /** Rename a tmux session. */
  async rename(from: string, to: string): Promise<void> {
    this.validateName(from);
    this.validateName(to);
    await exec('tmux', ['rename-session', '-t', from, to]);
    this.log.info({ from, to }, 'tmux session renamed');
  }

  /** Scroll a tmux pane via copy-mode (server-side, bypasses key bindings). */
  async scrollPage(name: string, direction: 'up' | 'down'): Promise<void> {
    this.validateName(name);
    if (direction === 'up') {
      // Enter copy mode (if not already) and scroll up one page
      await exec('tmux', ['copy-mode', '-eu', '-t', name]);
    } else {
      // In copy mode, scroll down; if not in copy mode, this is a no-op (errors silently)
      try {
        await exec('tmux', ['send-keys', '-X', '-t', name, 'page-down']);
      } catch {
        // Not in copy mode — ignore
      }
    }
  }

  /** Run a tmux command (split, new window, etc.) on the given session. */
  async runCommand(name: string, command: string): Promise<void> {
    this.validateName(name);
    const commandMap: Record<string, string[]> = {
      splitH: ['split-window', '-h', '-t', name],
      splitV: ['split-window', '-v', '-t', name],
      newWindow: ['new-window', '-t', name],
      nextWindow: ['next-window', '-t', name],
      prevWindow: ['previous-window', '-t', name],
      nextPane: ['select-pane', '-t', `${name}:.+`],
      zoomPane: ['resize-pane', '-Z', '-t', name],
      killPane: ['kill-pane', '-t', name],
    };
    const args = commandMap[command];
    if (!args) throw new Error(`Unknown tmux command: ${command}`);
    await exec('tmux', args);
    this.log.info({ name, command }, 'tmux command executed');
  }

  /** Capture full pane content including scrollback as plain text (no ANSI). */
  async captureFull(name: string): Promise<string> {
    this.validateName(name);
    const { stdout } = await exec('tmux', ['capture-pane', '-t', name, '-p', '-S', '-']);
    return stdout;
  }

  /** Send literal text to a tmux session, followed by Enter. */
  async sendKeys(name: string, text: string): Promise<void> {
    this.validateName(name);
    await exec('tmux', ['send-keys', '-t', name, '-l', text]);
    await exec('tmux', ['send-keys', '-t', name, 'Enter']);
  }

  /** List windows in a tmux session. */
  async listWindows(session: string): Promise<TmuxWindowInfo[]> {
    this.validateName(session);
    try {
      const { stdout } = await exec('tmux', [
        'list-windows',
        '-t',
        session,
        '-F',
        '#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}',
      ]);
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [index, name, active, panes] = line.split('\t');
          return {
            index: parseInt(index, 10),
            name,
            active: active === '1',
            panes: parseInt(panes, 10),
          };
        });
    } catch {
      return [];
    }
  }

  /** Select a window by index in a tmux session. */
  async selectWindow(session: string, index: number): Promise<void> {
    this.validateName(session);
    await exec('tmux', ['select-window', '-t', `${session}:${index}`]);
  }

  /**
   * Attach to a tmux session by spawning a PTY that runs `tmux attach`.
   * Returns a session key used to manage this attached PTY.
   */
  attach(
    name: string,
    cols: number,
    rows: number,
    onData: (data: string) => void,
    onExit: () => void,
  ): string {
    this.validateName(name);
    const key = `tmux:${name}`;

    // Detach any existing attachment
    this.detach(key);

    // Filter sensitive env vars from the spawned process
    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !['AUTH_TOKEN', 'TLS_KEY', 'TLS_CERT'].includes(k),
      ),
    );

    const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', name], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME || '/',
      env: {
        ...safeEnv,
        TERM: 'xterm-256color',
      } as Record<string, string>,
    });

    // Store the PTY before registering callbacks to avoid race conditions
    this.attachedPtys.set(key, ptyProcess);

    ptyProcess.onData(onData);
    ptyProcess.onExit(() => {
      this.attachedPtys.delete(key);
      onExit();
    });

    this.log.info({ name }, 'tmux session attached');
    return key;
  }

  /** Write to an attached tmux PTY. */
  write(key: string, data: string): void {
    const p = this.attachedPtys.get(key);
    if (!p) throw new Error('Not attached to any tmux session');
    p.write(data);
  }

  /** Resize an attached tmux PTY. */
  resize(key: string, cols: number, rows: number): void {
    const p = this.attachedPtys.get(key);
    if (p) p.resize(cols, rows);
  }

  /** Detach from a tmux session. */
  detach(key: string): void {
    const p = this.attachedPtys.get(key);
    if (p) {
      p.kill();
      this.attachedPtys.delete(key);
      this.log.info({ key }, 'tmux session detached');
    }
  }

  /** Kill all attached PTYs (cleanup). */
  detachAll(): void {
    for (const key of [...this.attachedPtys.keys()]) {
      this.detach(key);
    }
  }
}
