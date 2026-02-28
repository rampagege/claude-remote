import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import type { Logger } from 'pino';
import type {
  ClaudeUsageData,
  DailyTokens,
  ExtraUsage,
  ServerConfig,
  UsageQuota,
} from '../types.js';
import { stripAnsi } from './utils.js';
export { stripAnsi };

/** Detect account tier from the header line */
export function detectAccountTier(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('claude pro')) return 'Pro';
  if (lower.includes('claude max')) return 'Max';
  if (lower.includes('api usage') || lower.includes('api billing')) return 'API';
  return '';
}

/**
 * Extract percentage from text near a label.
 * Supports "N% used" and "N% left" formats.
 */
export function extractPercent(label: string, text: string): number | null {
  const lines = text.split('\n');
  const labelIdx = lines.findIndex((l) => l.toLowerCase().includes(label.toLowerCase()));
  if (labelIdx < 0) return null;

  // Scan a 12-line window after the label
  const window = lines.slice(labelIdx, labelIdx + 12);
  for (const line of window) {
    const m = line.match(/(\d{1,3})\s*%\s*(used|left)/i);
    if (m) {
      const raw = parseInt(m[1], 10);
      return m[2].toLowerCase() === 'left' ? 100 - raw : raw;
    }
  }
  return null;
}

/** Extract reset text near a label */
export function extractReset(label: string, text: string): string {
  const lines = text.split('\n');
  const labelIdx = lines.findIndex((l) => l.toLowerCase().includes(label.toLowerCase()));
  if (labelIdx < 0) return '';

  const window = lines.slice(labelIdx, labelIdx + 14);
  for (const line of window) {
    if (/reset/i.test(line)) {
      return line.trim();
    }
  }
  return '';
}

/** Parse all quota sections from the output dynamically */
export function parseQuotas(text: string): UsageQuota[] {
  const quotas: UsageQuota[] = [];
  const lines = text.split('\n');

  // Find all lines starting with "Current session" or "Current week"
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const lower = trimmed.toLowerCase();
    if (!lower.startsWith('current session') && !lower.startsWith('current week')) continue;

    // Extract the label (up to first non-label content like progress bar chars)
    const labelMatch = trimmed.match(/^(Current\s+(?:session|week\s*(?:\([^)]*\))?))/i);
    if (!labelMatch) continue;
    const label = labelMatch[1].trim();

    // Scan the window for percent
    const pct = extractPercent(label, text);
    if (pct === null) continue;
    const resetText = extractReset(label, text);
    quotas.push({ label, percentUsed: pct, resetText });
  }

  return quotas;
}

/** Extract account info line (contains "Claude Pro/Max" with · separators) */
export function extractAccountInfo(text: string): string {
  const lines = text.split('\n');
  for (const line of lines) {
    // Split on box-drawing │ to isolate individual cells
    const cells = line.split('│');
    for (const cell of cells) {
      const cleaned = cell.replace(/[╭╮╰╯─┤├┬┴┼▏▕]/g, '').trim();
      if (!cleaned) continue;
      if (/claude\s+(pro|max)/i.test(cleaned) && cleaned.includes('·')) {
        return cleaned;
      }
    }
  }
  return '';
}

/** Parse extra usage section */
export function parseExtraUsage(text: string): ExtraUsage | null {
  const lower = text.toLowerCase();
  if (!lower.includes('extra usage')) return null;
  if (lower.includes('extra usage not enabled')) return null;

  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.toLowerCase().includes('extra usage'));
  if (idx < 0) return null;

  const window = lines.slice(idx, idx + 10);
  for (const line of window) {
    const m = line.match(/\$?([\d,]+\.?\d*)\s*\/\s*\$?([\d,]+\.?\d*)\s*spent/i);
    if (m) {
      const spentVal = parseFloat(m[1].replace(/,/g, ''));
      const budgetVal = parseFloat(m[2].replace(/,/g, ''));
      const pct = budgetVal > 0 ? Math.round((spentVal / budgetVal) * 100) : 0;
      const resetText = extractReset('extra usage', text);
      return {
        spent: `$${m[1]}`,
        budget: `$${m[2]}`,
        percentUsed: pct,
        resetText,
      };
    }
  }
  return null;
}

export class UsageManager {
  private log: Logger;
  private config: ServerConfig;
  private claudeDir: string;
  private statsPath: string;

  constructor(log: Logger, config: ServerConfig) {
    this.log = log.child({ module: 'usage' });
    this.config = config;
    this.claudeDir = path.join(homedir(), '.claude');
    this.statsPath = path.join(this.claudeDir, 'stats-cache.json');
  }

  /**
   * Run `claude /usage --allowed-tools ""` in a PTY and parse the output.
   * Uses node-pty because `claude /usage` is a TUI that requires a terminal.
   * Auto-accepts the workspace trust dialog if it appears.
   * Returns null if the probe fails.
   */
  async probeClaudeUsage(): Promise<{
    accountTier: string;
    accountInfo: string;
    quotas: UsageQuota[];
    extraUsage: ExtraUsage | null;
  } | null> {
    try {
      const raw = await new Promise<string>((resolve, _reject) => {
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          NO_COLOR: '1',
        };
        delete env.CLAUDECODE;
        delete env.AUTH_TOKEN;
        delete env.OPENROUTER_API_KEY;
        delete env.OPENAI_API_KEY;
        delete env.MINIMAX_API_KEY;
        delete env.SUPERVISOR_API_KEY;
        delete env.TELEGRAM_BOT_TOKEN;
        delete env.TLS_KEY;
        delete env.TLS_CERT;

        const proc = pty.spawn(this.config.claudeCmd, ['/usage', '--allowed-tools', ''], {
          cols: 160,
          rows: 50,
          cwd: homedir(),
          env,
        });

        let buf = '';
        let trustSent = false;
        let done = false;

        const finish = () => {
          if (done) return;
          done = true;
          proc.kill();
          resolve(buf);
        };

        const timeout = setTimeout(finish, 20_000);

        proc.onData((data) => {
          if (done) return;
          buf += data;

          // Auto-accept workspace trust dialog
          if (!trustSent && buf.includes('trust')) {
            trustSent = true;
            proc.write('\r');
          }

          // Detect usage data has loaded (contains actual quota percentages)
          const stripped = stripAnsi(buf);
          if (stripped.includes('% used') || stripped.includes('% left')) {
            clearTimeout(timeout);
            // Give a short delay for remaining output to arrive
            setTimeout(finish, 500);
          }
        });

        proc.onExit(() => {
          clearTimeout(timeout);
          finish();
        });
      });

      const text = stripAnsi(raw);
      this.log.debug({ textLen: text.length }, 'claude /usage probe output');

      const accountInfo = extractAccountInfo(text);

      return {
        accountTier: detectAccountTier(accountInfo),
        accountInfo,
        quotas: parseQuotas(text),
        extraUsage: parseExtraUsage(text),
      };
    } catch (err) {
      this.log.warn({ err }, 'claude /usage probe failed');
      return null;
    }
  }

  async fetchClaude(): Promise<ClaudeUsageData> {
    // Run probe and stats-cache read in parallel
    const [probeResult, statsResult, tokenResult] = await Promise.all([
      this.probeClaudeUsage(),
      this.readStatsCache(),
      this.scanSessionTokens(),
    ]);

    return {
      // Live quota (fallback to empty if probe failed)
      accountTier: probeResult?.accountTier ?? '',
      accountInfo: probeResult?.accountInfo ?? '',
      quotas: probeResult?.quotas ?? [],
      extraUsage: probeResult?.extraUsage ?? null,

      // Stats-cache aggregate
      ...statsResult,

      // JSONL token scanning
      ...tokenResult,
    };
  }

  private async readStatsCache(): Promise<{
    totalSessions: number;
    totalMessages: number;
    firstSessionDate: string;
    lastComputedDate: string;
    modelUsage: ClaudeUsageData['modelUsage'];
    recentDays: ClaudeUsageData['recentDays'];
  }> {
    let data: Record<string, unknown>;
    try {
      const raw = await readFile(this.statsPath, 'utf-8');
      data = JSON.parse(raw) as Record<string, unknown>;
      if (!data || typeof data !== 'object') throw new Error('Invalid stats cache');
    } catch {
      return {
        totalSessions: 0,
        totalMessages: 0,
        firstSessionDate: '',
        lastComputedDate: '',
        modelUsage: {},
        recentDays: [],
      };
    }

    const modelUsage: ClaudeUsageData['modelUsage'] = {};
    if (data.modelUsage && typeof data.modelUsage === 'object') {
      for (const [model, usage] of Object.entries(data.modelUsage as Record<string, unknown>)) {
        const u = usage as Record<string, number>;
        modelUsage[model] = {
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
        };
      }
    }

    const recentDays: ClaudeUsageData['recentDays'] = [];
    if (Array.isArray(data.dailyActivity)) {
      const last7 = (data.dailyActivity as Array<Record<string, unknown>>).slice(-7);
      for (const day of last7) {
        recentDays.push({
          date: (day.date as string) ?? '',
          messageCount: (day.messageCount as number) ?? 0,
          sessionCount: (day.sessionCount as number) ?? 0,
          toolCallCount: (day.toolCallCount as number) ?? 0,
        });
      }
    }

    return {
      totalSessions: (data.totalSessions as number) ?? 0,
      totalMessages: (data.totalMessages as number) ?? 0,
      firstSessionDate: (data.firstSessionDate as string) ?? '',
      lastComputedDate: (data.lastComputedDate as string) ?? '',
      modelUsage,
      recentDays,
    };
  }

  /**
   * Scan ~/.claude/projects/* /*.jsonl files (modified in last 7 days)
   * to compute real-time today/week token usage from assistant messages.
   */
  private async scanSessionTokens(): Promise<{
    todayTokens: number;
    weekTokens: number;
    recentDailyTokens: DailyTokens[];
  }> {
    const now = Date.now();
    const weekAgoMs = now - 7 * 86400000;
    const todayStr = new Date(now).toISOString().slice(0, 10);
    const weekAgoStr = new Date(weekAgoMs).toISOString().slice(0, 10);

    // date -> model -> totalTokens
    const daily = new Map<string, Map<string, number>>();

    try {
      const projectsDir = path.join(this.claudeDir, 'projects');
      const projectDirs = await readdir(projectsDir).catch(() => []);

      // Collect all JSONL files modified in the last 7 days
      const jsonlFiles: string[] = [];
      for (const dir of projectDirs) {
        const dirPath = path.join(projectsDir, dir);
        let entries: string[];
        try {
          entries = await readdir(dirPath);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.endsWith('.jsonl')) continue;
          const filePath = path.join(dirPath, entry);
          try {
            const s = await stat(filePath);
            if (s.mtimeMs >= weekAgoMs) {
              jsonlFiles.push(filePath);
            }
          } catch {
            // skip inaccessible files
          }
        }
      }

      this.log.debug({ fileCount: jsonlFiles.length }, 'scanning JSONL files for token usage');

      // Parse files in parallel (limit concurrency)
      const BATCH = 10;
      for (let i = 0; i < jsonlFiles.length; i += BATCH) {
        const batch = jsonlFiles.slice(i, i + BATCH);
        await Promise.all(batch.map((f) => this.parseJsonlTokens(f, weekAgoStr, daily)));
      }
    } catch (err) {
      this.log.warn({ err }, 'failed to scan session JSONL files');
    }

    // Aggregate results
    let todayTokens = 0;
    let weekTokens = 0;
    const recentDailyTokens: DailyTokens[] = [];

    const sortedDates = [...daily.keys()].sort();
    for (const date of sortedDates) {
      const modelMap = daily.get(date)!;
      const tokensByModel: Record<string, number> = {};
      let dayTotal = 0;
      for (const [model, count] of modelMap) {
        tokensByModel[model] = count;
        dayTotal += count;
      }
      recentDailyTokens.push({ date, tokensByModel });
      weekTokens += dayTotal;
      if (date === todayStr) {
        todayTokens = dayTotal;
      }
    }

    return { todayTokens, weekTokens, recentDailyTokens };
  }

  /**
   * Stream-parse a single JSONL file, extracting token usage from assistant messages.
   * Deduplicates by message ID — Claude Code writes multiple entries per message
   * (intermediate streaming + final), so we keep only the last entry per ID.
   */
  private parseJsonlTokens(
    filePath: string,
    weekAgoStr: string,
    daily: Map<string, Map<string, number>>,
  ): Promise<void> {
    return new Promise((resolve) => {
      // Collect per-message: last seen usage wins (dedup streaming duplicates)
      const byMessageId = new Map<string, { date: string; model: string; total: number }>();

      const rl = createInterface({
        input: createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
      });

      rl.on('line', (line) => {
        // Fast pre-check: skip lines that aren't assistant messages
        if (!line.includes('"type":"assistant"')) return;

        try {
          const obj = JSON.parse(line);
          if (obj.type !== 'assistant') return;

          const msg = obj.message;
          if (!msg?.usage) return;

          const ts: string = obj.timestamp ?? msg.timestamp ?? '';
          if (!ts) return;
          const date = ts.slice(0, 10);
          if (date < weekAgoStr) return;

          const messageId: string = msg.id ?? '';
          const model: string = msg.model ?? 'unknown';
          const u = msg.usage;
          const total =
            (u.input_tokens ?? 0) +
            (u.output_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0);

          if (total === 0) return;

          if (messageId) {
            // Dedup: overwrite with latest entry for this message ID
            byMessageId.set(messageId, { date, model, total });
          } else {
            // No message ID — add directly (legacy format)
            let modelMap = daily.get(date);
            if (!modelMap) {
              modelMap = new Map();
              daily.set(date, modelMap);
            }
            modelMap.set(model, (modelMap.get(model) ?? 0) + total);
          }
        } catch {
          // skip malformed lines
        }
      });

      rl.on('close', () => {
        // Flush deduplicated entries into the daily map
        for (const { date, model, total } of byMessageId.values()) {
          let modelMap = daily.get(date);
          if (!modelMap) {
            modelMap = new Map();
            daily.set(date, modelMap);
          }
          modelMap.set(model, (modelMap.get(model) ?? 0) + total);
        }
        resolve();
      });
      rl.on('error', () => resolve());
    });
  }
}
