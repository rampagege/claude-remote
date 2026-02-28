import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { TmuxManager } from './tmuxManager.js';
import type { SupervisorMode, SupervisorConfig } from '../types.js';
import type { NotificationChannel } from './supervisorChannels.js';
import { stripAnsi } from './utils.js';

interface SessionSupervisor {
  sessionName: string;
  goal: string;
  mode: SupervisorMode;
  interval: ReturnType<typeof setInterval> | null;
  lastHash: string;
  pendingAction: { id: string; suggestion: string } | null;
  paused: boolean; // true when waiting for user feedback or after auto-send
  lastLlmCallAt: number; // timestamp of last LLM call — for cooldown
}

export class AiSupervisor {
  private supervisors = new Map<string, SessionSupervisor>();
  private log: Logger;
  private tmux: TmuxManager;
  private config: SupervisorConfig;
  private channels: NotificationChannel;
  private actionCounter = 0;

  constructor(
    log: Logger,
    tmux: TmuxManager,
    config: SupervisorConfig,
    channels: NotificationChannel,
  ) {
    this.log = log.child({ module: 'ai-supervisor' });
    this.tmux = tmux;
    this.config = config;
    this.channels = channels;
  }

  start(sessionName: string, goal: string, mode: SupervisorMode): void {
    this.stop(sessionName);

    if (!this.config.apiKey) {
      this.channels.notifyLog(sessionName, 'Supervisor API key not configured', 'error');
      return;
    }

    const sup: SessionSupervisor = {
      sessionName,
      goal,
      mode,
      lastHash: '',
      pendingAction: null,
      paused: false,
      interval: null,
      lastLlmCallAt: 0,
    };

    this.supervisors.set(sessionName, sup);
    this.startPolling(sup);
    this.channels.notifyStatus(sessionName, true, mode, goal);
    this.channels.notifyLog(
      sessionName,
      `Supervisor started (${mode} mode, ${this.config.pollIntervalMs / 1000}s interval): ${goal}`,
      'info',
    );
    this.log.info({ sessionName, mode, goal }, 'Supervisor started');

    // If terminal is waiting for input, send goal as first instruction
    this.trySendGoalAsFirstInput(sup);
  }

  /** Start or restart the polling interval for a supervisor. */
  private startPolling(sup: SessionSupervisor): void {
    this.stopPolling(sup);
    sup.paused = false;
    sup.interval = setInterval(() => this.poll(sup.sessionName), this.config.pollIntervalMs);
  }

  /** Stop polling (pause). The supervisor stays active but stops checking. */
  private stopPolling(sup: SessionSupervisor): void {
    if (sup.interval) {
      clearInterval(sup.interval);
      sup.interval = null;
    }
  }

  /** Pause polling — called when input is detected and we're waiting for user feedback. */
  private pausePolling(sup: SessionSupervisor, reason: string): void {
    this.stopPolling(sup);
    sup.paused = true;
    this.channels.notifyLog(sup.sessionName, `Polling paused: ${reason}`, 'info');
  }

  /** Resume polling — called after user confirms/rejects or after auto-send completes. */
  private resumePolling(sup: SessionSupervisor, resetHash = true): void {
    if (sup.paused) {
      if (resetHash) {
        sup.lastHash = ''; // reset hash so next poll re-checks content
      }
      this.startPolling(sup);
      this.channels.notifyLog(sup.sessionName, 'Polling resumed', 'info');
    }
  }

  /** Pause polling and resume after a delay (default 2x poll interval). */
  private pauseAndResumeAfter(sup: SessionSupervisor, reason: string, multiplier = 2): void {
    this.pausePolling(sup, reason);
    setTimeout(() => {
      if (this.supervisors.has(sup.sessionName)) {
        this.resumePolling(sup);
      }
    }, this.config.pollIntervalMs * multiplier);
  }

  stop(sessionName: string): void {
    const sup = this.supervisors.get(sessionName);
    if (sup) {
      this.stopPolling(sup);
      this.supervisors.delete(sessionName);
      this.channels.notifyStatus(sessionName, false, sup.mode, sup.goal);
      this.channels.notifyLog(sessionName, 'Supervisor stopped', 'info');
      this.log.info({ sessionName }, 'Supervisor stopped');
    }
  }

  confirm(sessionName: string, actionId: string, approved: boolean): void {
    const sup = this.supervisors.get(sessionName);
    if (!sup?.pendingAction || sup.pendingAction.id !== actionId) return;

    const { suggestion } = sup.pendingAction;
    sup.pendingAction = null;

    if (approved) {
      this.sendKeys(sessionName, suggestion);
      this.channels.notifyLog(sessionName, `Approved & sent: ${suggestion}`, 'info');
      // Reset hash — content will change after sending keys
      this.resumePolling(sup, true);
    } else {
      this.channels.notifyLog(sessionName, `Rejected: ${suggestion}`, 'info');
      // Keep hash — don't re-analyze the same unchanged content
      this.resumePolling(sup, false);
    }
  }

  stopAll(): void {
    for (const name of [...this.supervisors.keys()]) {
      this.stop(name);
    }
  }

  isActive(sessionName: string): boolean {
    return this.supervisors.has(sessionName);
  }

  /** Detect Claude Code markers anywhere in the captured content. */
  private isClaudeCodeSession(content: string): boolean {
    // Claude Code has distinctive UI elements in the terminal output
    return (
      /Context left until auto-compact/i.test(content) ||
      /bypass permissions on/i.test(content) ||
      /shift\+tab to cycle/i.test(content) ||
      /❯❯\s/.test(content) ||
      /Co-Authored-By: Claude/i.test(content) ||
      /\? Allow (Bash|Read|Write|Edit|Glob|Grep|Agent|Skill)/i.test(content)
    );
  }

  /**
   * Detect if Claude Code is actively working (not waiting for input).
   *
   * Uses multiple signals to minimize false negatives (which would
   * trigger unnecessary LLM calls):
   * - "esc to interrupt" in status bar (most reliable)
   * - Active processing markers: "* Verb…", "✦ Verb…"
   * - Tool execution markers: "● Bash(", "● Read(", "Running…"
   * - Thinking/working indicators without a subsequent "● Done"
   */
  private isClaudeCodeBusy(content: string): boolean {
    // Primary signal — definitive
    if (/esc to interrupt/i.test(content)) return true;

    // Secondary signals — check last 30 lines for active work indicators
    const lines = content.split('\n');
    const tail = lines.slice(-30).join('\n');

    // Active processing: "* Thinking…", "✦ Deciphering…", etc.
    if (/^[*✦✻]\s+\S/m.test(tail)) {
      // But not if "● Done" appears AFTER the last processing marker
      const lastProcessing = Math.max(
        tail.lastIndexOf('* '),
        tail.lastIndexOf('✦ '),
        tail.lastIndexOf('✻ '),
      );
      const lastDone = tail.lastIndexOf('● Done');
      if (lastDone < lastProcessing) return true;
    }

    // Tool execution: "● Bash(", "● Read(", "├ Read(", "Running…"
    if (/^[●├]\s+(Bash|Read|Write|Edit|Glob|Grep|Agent|Explore)\(/m.test(tail)) return true;
    if (/Running…/i.test(tail) && !/● Done/i.test(tail.slice(tail.lastIndexOf('Running'))))
      return true;

    return false;
  }

  /**
   * Cheap heuristic: detect if terminal clearly does NOT need input.
   * Returns true → skip LLM call (no input needed).
   * Returns false → fall through to LLM analysis.
   */
  private looksIdle(lastLines: string, isClaudeCode: boolean): boolean {
    // Claude Code session: if it's busy (has "esc to interrupt"), skip LLM
    if (isClaudeCode) {
      return this.isClaudeCodeBusy(lastLines);
    }

    // Generic terminal idle detection (NOT used for Claude Code sessions,
    // because Claude Code's ">" prompt would false-match shell patterns)
    const trimmed = lastLines.replace(/\s+$/, '');
    const lines = trimmed.split('\n');
    const last = lines.pop()?.trim() ?? '';

    // Common shell prompts — $ % ❯ #  (NOT ">" to avoid Claude Code conflicts)
    if (/[$%❯#]\s*$/.test(last)) return true;
    if (/^\S+@\S+[:%~]/.test(last)) return true;

    // Cursor sitting on an empty line after output
    if (last === '' || last === '~') return true;

    // vim/nano/less status lines
    if (/^(--|~|:|\[No Name\])/.test(last)) return true;

    return false;
  }

  /**
   * On supervisor start, check if the terminal is already waiting for input.
   * If so, send the goal text directly as the first instruction.
   */
  private async trySendGoalAsFirstInput(sup: SessionSupervisor): Promise<void> {
    try {
      const rawContent = await this.tmux.captureFull(sup.sessionName);
      const content = stripAnsi(rawContent);

      // If Claude Code is actively working, don't send — fall through to normal polling
      if (this.isClaudeCodeBusy(content)) return;

      // Terminal is not busy — send goal as first instruction
      this.sendKeys(sup.sessionName, sup.goal);
      this.channels.notifyLog(sup.sessionName, `Sent goal as first input: ${sup.goal}`, 'info');

      this.pauseAndResumeAfter(sup, 'sent initial goal');
    } catch (err) {
      this.log.error({ err, sessionName: sup.sessionName }, 'Failed to check initial input state');
    }
  }

  /**
   * Send arbitrary text to a supervised session's terminal.
   * Called when user sends a text message via Telegram or other channel.
   */
  sendInput(sessionName: string, text: string): void {
    const sup = this.supervisors.get(sessionName);
    if (!sup) return;

    // Clear any pending action — user is overriding with their own input
    if (sup.pendingAction) {
      sup.pendingAction = null;
    }

    this.sendKeys(sessionName, text);
    this.channels.notifyLog(sessionName, `User input sent: ${text}`, 'info');

    this.pauseAndResumeAfter(sup, 'user input sent');
  }

  /** Get the first active supervised session name (for single-session text input). */
  getActiveSessionName(): string | null {
    const first = this.supervisors.keys().next();
    return first.done ? null : first.value;
  }

  private async poll(sessionName: string): Promise<void> {
    const sup = this.supervisors.get(sessionName);
    if (!sup) return;

    // Don't poll if paused or waiting for user confirmation
    if (sup.paused || sup.pendingAction) return;

    try {
      const rawContent = await this.tmux.captureFull(sessionName);
      const content = stripAnsi(rawContent);
      const hash = createHash('sha256').update(content).digest('hex');

      // Skip if content unchanged
      if (hash === sup.lastHash) return;
      sup.lastHash = hash;

      // Check Claude Code markers on FULL content (markers may be above the fold)
      const isClaudeCode = this.isClaudeCodeSession(content);

      // Take last N lines for LLM analysis
      const lines = content.split('\n');
      const recentLines = lines.slice(-this.config.maxCaptureLines).join('\n');

      // Fast idle check — skip LLM if terminal is clearly not waiting for input
      if (this.looksIdle(recentLines, isClaudeCode)) return;

      // Cooldown — if LLM was called recently (within 2 poll intervals) and content
      // is rapidly changing (e.g. Claude streaming output), skip to avoid spam.
      // This catches cases where heuristics fail to detect busy state.
      const now = Date.now();
      const cooldownMs = this.config.pollIntervalMs * 2;
      if (sup.lastLlmCallAt && now - sup.lastLlmCallAt < cooldownMs) return;
      sup.lastLlmCallAt = now;

      const result = await this.analyzeWithLLM(recentLines, sup.goal, sup.mode);
      if (!result) return;

      if (result.needsInput) {
        const actionId = `act_${++this.actionCounter}`;

        // Pause polling in ALL modes — wait for user feedback or for
        // the auto-sent command to finish before checking again
        this.pausePolling(sup, 'input detected');

        if (sup.mode === 'auto') {
          this.sendKeys(sessionName, result.suggestion);
          this.channels.notifyAction(
            sessionName,
            actionId,
            result.suggestion,
            result.reasoning,
            false,
          );
          this.channels.notifyLog(sessionName, `Auto-sent: ${result.suggestion}`, 'info');
          this.pauseAndResumeAfter(sup, 'auto-sent');
        } else if (sup.mode === 'confirm') {
          sup.pendingAction = { id: actionId, suggestion: result.suggestion };
          this.channels.notifyAction(
            sessionName,
            actionId,
            result.suggestion,
            result.reasoning,
            true,
          );
          this.channels.notifyLog(
            sessionName,
            `Awaiting confirmation: ${result.suggestion}`,
            'info',
          );
          // Stays paused until user calls confirm()
        } else {
          // Watch mode: log and resume after a delay
          this.channels.notifyLog(
            sessionName,
            `Detected prompt — suggestion: ${result.suggestion}`,
            'info',
          );
          this.pauseAndResumeAfter(sup, 'watch logged', 3);
        }
      }
    } catch (err) {
      this.channels.notifyLog(sessionName, `Poll error: ${(err as Error).message}`, 'error');
      this.log.error({ err, sessionName }, 'Supervisor poll error');
    }
  }

  private async sendKeys(sessionName: string, text: string): Promise<void> {
    try {
      await this.tmux.sendKeys(sessionName, text);
    } catch (err) {
      this.channels.notifyLog(
        sessionName,
        `Failed to send keys: ${(err as Error).message}`,
        'error',
      );
    }
  }

  private async analyzeWithLLM(
    terminalContent: string,
    goal: string,
    _mode: SupervisorMode,
  ): Promise<{ needsInput: boolean; suggestion: string; reasoning: string } | null> {
    const systemPrompt = `You are an AI supervisor monitoring a terminal session.

Your job: determine if the terminal is showing an INTERACTIVE PROMPT that requires a user response.

NEEDS INPUT (needsInput=true) — these cases:
- A yes/no or permission prompt: "? Allow read access to /foo [Y/n]", "[y/N]", "(yes/no)"
  → suggestion should be "yes", "no", "y", "n", etc.
- A numbered selection list where the CLI is waiting for a choice (1/2/3)
  → suggestion should be the number
- "Press Enter to continue" or "Hit any key"
  → suggestion should be "" (empty, Enter is sent automatically)
- Claude Code permission prompts: "? Allow Bash(...)" "? Allow Read(...)"
  → suggestion should be "y" or "n"
- Claude Code text input prompt: a line showing just ">" or "❯" (the input cursor).
  Context clues: nearby lines contain "bypass permissions on", "shift+tab to cycle",
  "Context left until auto-compact", or "❯❯". These confirm it is Claude Code, not a shell.
  IMPORTANT: This is ONLY a valid input prompt if "● Done" appears BEFORE it (Claude finished)
  AND there are NO active processing markers (*, ✦, Running…) AFTER the "● Done" line.
  If Claude just finished, the ">" prompt is waiting for the user's NEXT INSTRUCTION.
  → suggestion should be a concrete instruction based on the user's goal (provided in the <goal> tag in the user message).
  For example if goal is "review test coverage", suggest: "请review当前项目的测试功能覆盖情况"
  DO NOT suggest empty text or just "continue" — give a meaningful instruction derived from the goal.

DOES NOT NEED INPUT (needsInput=false) — these are NOT prompts:
- A shell prompt ($, %, >, #) — the terminal is idle at a bash/zsh shell
- Completed command output with NO input cursor (git push results, build logs, "Done" text)
- An empty terminal or blank lines
- Editor status lines (vim, nano, less)
- Text like "shift+tab to cycle", "bypass permissions on", "Context Left" — these are UI hints, not prompts
- Claude Code ACTIVELY WORKING — these are critical to recognize:
  * Lines starting with "* " followed by a verb: "* Nesting…", "* Deciphering…", "* Crunching…", "* Thinking…", "* Brewing…" — Claude is processing
  * Lines starting with "✦ " or "✻ " — same as above, just different bullet styles
  * "* Crunched for Xm Xs" or "* Nested for Xs" — Claude JUST finished a thinking step but may still be generating output. If there is NO "● Done" line AFTER this, Claude is still working.
  * Active tool output: "● Bash(...)", "● Read(...)", "Explore(...)", "├ Read(...)" — Claude is executing tools
  * "Running…" — a subprocess is running
  * "+N more tool uses" — Claude is executing multiple tools
  * "esc to interrupt" in the status bar — definitive busy signal
  If ANY of these are present AND there is no "● Done" summary line AFTER them, Claude is busy. Do NOT suggest input.

CRITICAL: When in doubt, answer needsInput=false. False positives are harmful (they send unwanted input). False negatives are harmless (the next poll will catch it).

Respond ONLY with valid JSON:
{"needsInput": true/false, "suggestion": "text to type (empty if needsInput is false)", "reasoning": "brief explanation"}

If needsInput=true:
- For yes/no prompts, lean toward "yes" / approval unless the goal says otherwise
- For selection lists, pick the option that best matches the goal
- Keep suggestions short — just the exact text to type (Enter key is sent automatically)`;

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `<goal>${goal}</goal>\n\nTerminal output (last ${this.config.maxCaptureLines} lines):\n\`\`\`\n${terminalContent}\n\`\`\``,
            },
          ],
          temperature: 0.1,
          max_tokens: 200,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        // Redact potential API keys from error body
        const safeText = text.replace(/sk-[a-zA-Z0-9_-]{10,}/g, '[REDACTED]');
        throw new Error(`OpenRouter API error ${response.status}: ${safeText}`);
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) return null;

      const jsonStr = content.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      try {
        return JSON.parse(jsonStr) as {
          needsInput: boolean;
          suggestion: string;
          reasoning: string;
        };
      } catch {
        this.log.warn({ raw: content }, 'LLM returned invalid JSON');
        return null;
      }
    } catch (err) {
      this.log.error({ err }, 'LLM analysis failed');
      return null;
    }
  }
}
