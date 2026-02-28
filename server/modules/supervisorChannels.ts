import type { Logger } from 'pino';
import type { SupervisorMode } from '../types.js';

// ── Channel Interface ────────────────────────────────────────────

export interface NotificationChannel {
  /** Called when supervisor detects input needed and has a suggestion. */
  notifyAction(
    sessionName: string,
    actionId: string,
    suggestion: string,
    reasoning: string,
    waitingForConfirm: boolean,
  ): void;

  /** Called for log entries (info/warn/error). */
  notifyLog(sessionName: string, text: string, level: 'info' | 'warn' | 'error'): void;

  /** Called when supervisor starts/stops on a session. */
  notifyStatus(sessionName: string, active: boolean, mode: SupervisorMode, goal: string): void;

  /** Cleanup resources. */
  destroy(): void;
}

// ── Channel Manager (fan-out) ────────────────────────────────────

export class ChannelManager implements NotificationChannel {
  private channels: NotificationChannel[] = [];

  addChannel(ch: NotificationChannel): void {
    this.channels.push(ch);
  }

  notifyAction(
    sessionName: string,
    actionId: string,
    suggestion: string,
    reasoning: string,
    waitingForConfirm: boolean,
  ): void {
    for (const ch of this.channels)
      ch.notifyAction(sessionName, actionId, suggestion, reasoning, waitingForConfirm);
  }

  notifyLog(sessionName: string, text: string, level: 'info' | 'warn' | 'error'): void {
    for (const ch of this.channels) ch.notifyLog(sessionName, text, level);
  }

  notifyStatus(sessionName: string, active: boolean, mode: SupervisorMode, goal: string): void {
    for (const ch of this.channels) ch.notifyStatus(sessionName, active, mode, goal);
  }

  destroy(): void {
    for (const ch of this.channels) ch.destroy();
  }
}

// ── Web Channel (WebSocket broadcast) ────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BroadcastFn = (msg: any) => void;

export class WebChannel implements NotificationChannel {
  constructor(private broadcast: BroadcastFn) {}

  notifyAction(
    sessionName: string,
    actionId: string,
    suggestion: string,
    reasoning: string,
    waitingForConfirm: boolean,
  ): void {
    this.broadcast({
      type: 'supervisorAction',
      sessionName,
      actionId,
      suggestion,
      reasoning,
      waitingForConfirm,
    });
  }

  notifyLog(sessionName: string, text: string, level: 'info' | 'warn' | 'error'): void {
    this.broadcast({ type: 'supervisorLog', sessionName, text, level });
  }

  notifyStatus(sessionName: string, active: boolean, mode: SupervisorMode, goal: string): void {
    this.broadcast({ type: 'supervisorStatus', sessionName, active, mode, goal });
  }

  destroy(): void {
    /* no-op */
  }
}

// ── Telegram Channel ─────────────────────────────────────────────

import { escapeHtmlBasic as escTg } from './utils.js';

type ConfirmCallback = (sessionName: string, actionId: string, approved: boolean) => void;
type StopCallback = (sessionName: string) => void;
type TextInputCallback = (text: string) => void;
type CommandCallback = (command: string, args: string) => Promise<string>;

export class TelegramChannel implements NotificationChannel {
  private stopped = false;
  private logBuffer = new Map<string, string[]>();
  private flushTimer: ReturnType<typeof setInterval>;

  constructor(
    private token: string,
    private chatId: string,
    private onConfirm: ConfirmCallback,
    private onStop: StopCallback,
    private onTextInput: TextInputCallback,
    private onCommand: CommandCallback,
    private log: Logger,
  ) {
    // Validate bot token on startup
    this.verifyBot();
    // Start long-polling for callback queries
    this.pollUpdates();
    // Flush buffered info logs every 3s
    this.flushTimer = setInterval(() => this.flushLogs(), 3000);
  }

  // ── NotificationChannel implementation ───────────────────────

  notifyAction(
    sessionName: string,
    actionId: string,
    suggestion: string,
    reasoning: string,
    waitingForConfirm: boolean,
  ): void {
    const text =
      `<b>[${escTg(sessionName)}]</b> Input detected\n` +
      `<b>Suggestion:</b> <code>${escTg(suggestion)}</code>\n` +
      `<i>${escTg(reasoning)}</i>`;

    if (waitingForConfirm) {
      const keyboard = {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: `approve:${sessionName}:${actionId}` },
            { text: 'Reject', callback_data: `reject:${sessionName}:${actionId}` },
            { text: 'Stop', callback_data: `stop:${sessionName}:${actionId}` },
          ],
        ],
      };
      this.sendMessage(text, keyboard);
    } else {
      this.sendMessage(text);
    }
  }

  notifyLog(sessionName: string, text: string, level: 'info' | 'warn' | 'error'): void {
    if (level === 'error' || level === 'warn') {
      const icon = level === 'error' ? '🔴' : '🟡';
      this.sendMessage(`${icon} <b>[${escTg(sessionName)}]</b> ${escTg(text)}`);
      return;
    }
    // Buffer info-level logs
    const buf = this.logBuffer.get(sessionName) ?? [];
    buf.push(text);
    this.logBuffer.set(sessionName, buf);
    if (buf.length >= 5) this.flushLogs(sessionName);
  }

  notifyStatus(sessionName: string, active: boolean, mode: SupervisorMode, goal: string): void {
    const status = active
      ? `▶️ <b>[${escTg(sessionName)}]</b> Supervisor started (<b>${mode}</b>)\n<i>${escTg(goal)}</i>`
      : `⏹ <b>[${escTg(sessionName)}]</b> Supervisor stopped`;
    this.sendMessage(status);
  }

  destroy(): void {
    this.stopped = true;
    clearInterval(this.flushTimer);
    this.flushLogs();
  }

  // ── Internal ─────────────────────────────────────────────────

  private async verifyBot(): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/getMe`);
      const data = (await res.json()) as { ok: boolean; result?: { username: string } };
      if (data.ok) {
        this.log.info({ bot: data.result?.username }, 'Telegram bot connected');
        this.registerCommands();
      } else {
        this.log.error({ data }, 'Telegram bot token invalid');
      }
    } catch (err) {
      this.log.error({ err }, 'Failed to verify Telegram bot');
    }
  }

  private async registerCommands(): Promise<void> {
    const commands = [
      { command: 'list', description: 'List tmux sessions' },
      { command: 'status', description: 'Show supervised sessions' },
      { command: 'usage', description: 'Claude token usage' },
      { command: 'watch', description: 'Start supervisor (confirm mode)' },
      { command: 'auto', description: 'Start supervisor (auto mode)' },
      { command: 'stop', description: 'Stop supervisor' },
      { command: 'capture', description: 'Show terminal content' },
      { command: 'send', description: 'Send text to session' },
      { command: 'help', description: 'Show help' },
    ];
    try {
      await fetch(`https://api.telegram.org/bot${this.token}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands }),
      });
    } catch {
      /* best effort */
    }
  }

  private async sendMessage(text: string, replyMarkup?: object): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      });
    } catch (err) {
      this.log.error({ err }, 'Telegram sendMessage failed');
    }
  }

  private flushLogs(sessionName?: string): void {
    const flush = (name: string) => {
      const buf = this.logBuffer.get(name);
      if (!buf?.length) return;
      this.logBuffer.delete(name);
      const lines = buf.map((l) => escTg(l)).join('\n');
      this.sendMessage(`<b>[${escTg(name)}]</b>\n${lines}`);
    };

    if (sessionName) {
      flush(sessionName);
    } else {
      for (const name of this.logBuffer.keys()) flush(name);
    }
  }

  private async pollUpdates(): Promise<void> {
    let offset = 0;
    let consecutiveErrors = 0;

    while (!this.stopped) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${this.token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["callback_query","message"]`,
        );
        const data = (await res.json()) as {
          ok: boolean;
          result?: Array<{
            update_id: number;
            callback_query?: {
              id: string;
              data?: string;
              message?: { chat?: { id: number } };
            };
            message?: {
              text?: string;
              chat?: { id: number };
            };
          }>;
        };

        consecutiveErrors = 0;

        for (const update of data.result ?? []) {
          offset = update.update_id + 1;

          // Handle button callbacks (Approve / Reject / Stop)
          const cbq = update.callback_query;
          if (cbq?.data) {
            // Verify callback originates from the authorized chat
            if (String(cbq.message?.chat?.id) !== this.chatId) continue;

            // Validate callback_data format: action:sessionName:actionId
            const match = cbq.data.match(/^(approve|reject|stop):([a-zA-Z0-9_-]+):(act_\d+)$/);
            if (!match) continue;

            const [, action, sessionName, actionId] = match;
            let answerText = '';

            if (action === 'approve') {
              this.onConfirm(sessionName, actionId, true);
              answerText = 'Approved';
            } else if (action === 'reject') {
              this.onConfirm(sessionName, actionId, false);
              answerText = 'Rejected';
            } else if (action === 'stop') {
              this.onStop(sessionName);
              answerText = 'Supervisor stopped';
            }

            try {
              await fetch(`https://api.telegram.org/bot${this.token}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: cbq.id, text: answerText }),
              });
            } catch {
              /* best effort */
            }
            continue;
          }

          // Handle text messages
          const msg = update.message;
          if (msg?.text && String(msg.chat?.id) === this.chatId) {
            const text = msg.text.trim();
            if (!text) continue;

            if (text.startsWith('/')) {
              // Bot command — route to command handler
              const spaceIdx = text.indexOf(' ');
              const cmd = (spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1)).replace(
                /@.*$/,
                '',
              );
              const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';
              try {
                const reply = await this.onCommand(cmd, args);
                if (reply) this.sendMessage(reply);
              } catch (err) {
                this.sendMessage(`🔴 Command error: ${escTg((err as Error).message)}`);
              }
            } else {
              // Plain text — send as input to active session
              this.onTextInput(text);
              this.sendMessage(`✅ Sent to terminal: <code>${escTg(text)}</code>`);
            }
          }
        }
      } catch (err) {
        consecutiveErrors++;
        this.log.error({ err }, 'Telegram poll error');
        const backoff = Math.min(5000 * consecutiveErrors, 30000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
}
