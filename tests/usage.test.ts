import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { UsageManager } from '../server/modules/usageManager.js';
import {
  stripAnsi,
  detectAccountTier,
  extractPercent,
  extractReset,
  parseQuotas,
  parseExtraUsage,
  extractAccountInfo,
} from '../server/modules/usageManager.js';
import type { ServerConfig } from '../server/types.js';

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

// Mock node:fs (createReadStream)
vi.mock('node:fs', () => ({
  createReadStream: vi.fn(),
}));

// Mock node-pty
const mockPtySpawn = vi.fn();
vi.mock('node-pty', () => ({
  default: { spawn: (...args: unknown[]) => mockPtySpawn(...args) },
  spawn: (...args: unknown[]) => mockPtySpawn(...args),
}));

import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const mockReadFile = vi.mocked(readFile);
const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);
const mockCreateReadStream = vi.mocked(createReadStream);

const mockLog = {
  child: () => mockLog,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import('pino').Logger;

const mockConfig: ServerConfig = {
  port: 3980,
  host: '127.0.0.1',
  authToken: 'test',
  logLevel: 'silent',
  claudeCmd: 'claude',
  maxTmuxSessions: 10,
};

const sampleStatsCache = {
  totalSessions: 87,
  totalMessages: 73781,
  firstSessionDate: '2025-01-06',
  lastComputedDate: '2025-02-20',
  modelUsage: {
    'claude-sonnet-4-20250514': {
      inputTokens: 5000000,
      outputTokens: 1200000,
      cacheReadInputTokens: 800000,
      cacheCreationInputTokens: 300000,
    },
    'claude-haiku-4-5-20251001': {
      inputTokens: 200000,
      outputTokens: 50000,
      cacheReadInputTokens: 10000,
      cacheCreationInputTokens: 5000,
    },
  },
  dailyActivity: [
    { date: '2025-02-14', messageCount: 100, sessionCount: 2, toolCallCount: 300 },
    { date: '2025-02-15', messageCount: 80, sessionCount: 1, toolCallCount: 200 },
    { date: '2025-02-16', messageCount: 120, sessionCount: 3, toolCallCount: 450 },
    { date: '2025-02-17', messageCount: 90, sessionCount: 2, toolCallCount: 280 },
    { date: '2025-02-18', messageCount: 110, sessionCount: 4, toolCallCount: 350 },
    { date: '2025-02-19', messageCount: 60, sessionCount: 1, toolCallCount: 150 },
    { date: '2025-02-20', messageCount: 70, sessionCount: 2, toolCallCount: 220 },
  ],
};

/** Helper: create a JSONL assistant message line */
function assistantLine(
  timestamp: string,
  model: string,
  tokens: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      model,
      usage: {
        input_tokens: tokens.input_tokens ?? 0,
        output_tokens: tokens.output_tokens ?? 0,
        cache_creation_input_tokens: tokens.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: tokens.cache_read_input_tokens ?? 0,
      },
    },
  });
}

/** Helper: make createReadStream return a stream of JSONL lines */
function mockJsonlFile(lines: string[]): void {
  const content = lines.join('\n') + '\n';
  const stream = new PassThrough();
  stream.end(content);
  mockCreateReadStream.mockReturnValueOnce(
    stream as unknown as ReturnType<typeof createReadStream>,
  );
}

/** Setup JSONL scanning mocks: no project dirs (empty scan) */
function setupEmptyJSONLScan(): void {
  // readdir for projects/ dir returns empty
  mockReaddir.mockImplementation(async (p) => {
    const ps = String(p);
    if (ps.includes('projects')) return [] as unknown as ReturnType<typeof readdir>;
    return [] as unknown as ReturnType<typeof readdir>;
  });
}

/** Create a fake PTY process that emits data then exits */
function makeFakePty(output: string | null): unknown {
  let onDataCb: ((data: string) => void) | null = null;
  let onExitCb: (() => void) | null = null;
  return {
    onData(cb: (data: string) => void) {
      onDataCb = cb;
    },
    onExit(cb: () => void) {
      onExitCb = cb;
      // Emit data + exit on next tick
      queueMicrotask(() => {
        if (output !== null && onDataCb) onDataCb(output);
        if (onExitCb) onExitCb();
      });
    },
    write: vi.fn(),
    kill: vi.fn(),
  };
}

/** Mock pty.spawn to simulate probe failure */
function setupProbeFailure(): void {
  mockPtySpawn.mockImplementation(() => makeFakePty(null));
}

/** Mock pty.spawn to simulate probe success with given output */
function setupProbeSuccess(output: string): void {
  mockPtySpawn.mockImplementation(() => makeFakePty(output));
}

// ── Parsing unit tests ────────────────────────────────────────────

describe('stripAnsi', () => {
  it('should remove ANSI escape codes', () => {
    const input = '\x1B[1mBold\x1B[0m and \x1B[31mred\x1B[0m text';
    expect(stripAnsi(input)).toBe('Bold and red text');
  });

  it('should replace cursor-forward with spaces', () => {
    // \x1B[1C means move cursor right 1 position (= 1 space)
    const input = '9%\x1B[1Cused';
    expect(stripAnsi(input)).toBe('9% used');
  });

  it('should replace multi-column cursor-forward', () => {
    const input = 'Hello\x1B[3CWorld';
    expect(stripAnsi(input)).toBe('Hello   World');
  });

  it('should remove OSC sequences (terminal title)', () => {
    const input = '\x1B]0;My Title\x07Hello';
    expect(stripAnsi(input)).toBe('Hello');
  });

  it('should handle text without ANSI codes', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('should handle complex escape sequences', () => {
    const input = '\x1B[?25l\x1B[2J\x1B[HHello\x1B[0m';
    expect(stripAnsi(input)).toBe('Hello');
  });
});

describe('detectAccountTier', () => {
  it('should detect Pro tier', () => {
    expect(detectAccountTier('Opus 4.5 · Claude Pro · user@example.com')).toBe('Pro');
  });

  it('should detect Max tier', () => {
    expect(detectAccountTier('Sonnet 4.5 · Claude Max · user@example.com')).toBe('Max');
  });

  it('should detect API tier', () => {
    expect(detectAccountTier('API usage billing dashboard')).toBe('API');
  });

  it('should return empty for unknown tier', () => {
    expect(detectAccountTier('Some random text')).toBe('');
  });

  it('should be case-insensitive', () => {
    expect(detectAccountTier('CLAUDE PRO plan')).toBe('Pro');
  });
});

describe('extractPercent', () => {
  it('should extract "N% used" format', () => {
    const text = `Current session
▌                                                  1% used
Resets 2:59pm`;
    expect(extractPercent('Current session', text)).toBe(1);
  });

  it('should extract "N% left" format and convert to used', () => {
    const text = `Current session
▌                                                  65% left
Resets 2:59pm`;
    expect(extractPercent('Current session', text)).toBe(35);
  });

  it('should extract high percentages', () => {
    const text = `Current week (all models)
█████                                              16% used
Resets Dec 25`;
    expect(extractPercent('Current week (all models)', text)).toBe(16);
  });

  it('should return null when label not found', () => {
    const text = 'no matching label here';
    expect(extractPercent('Current session', text)).toBeNull();
  });

  it('should return null when no percentage after label', () => {
    const text = `Current session
no percentage here`;
    expect(extractPercent('Current session', text)).toBeNull();
  });
});

describe('extractReset', () => {
  it('should extract reset text after label', () => {
    const text = `Current session
1% used
Resets 2:59pm (Asia/Shanghai)`;
    expect(extractReset('Current session', text)).toBe('Resets 2:59pm (Asia/Shanghai)');
  });

  it('should extract reset with date', () => {
    const text = `Current week (all models)
16% used
Resets Dec 25 at 4:59am (Asia/Shanghai)`;
    expect(extractReset('Current week (all models)', text)).toBe(
      'Resets Dec 25 at 4:59am (Asia/Shanghai)',
    );
  });

  it('should return empty when no reset line found', () => {
    const text = `Current session
1% used
no timing info here`;
    expect(extractReset('Current session', text)).toBe('');
  });
});

describe('parseQuotas', () => {
  const sampleOutput = `Opus 4.5 · Claude Pro · Some User
~/Projects/ClaudeStat

Settings: Status  Config  Usage (tab to cycle)

Current session
▌                                                  1% used
Resets 2:59pm (Asia/Shanghai)

Current week (all models)
█████                                              16% used
Resets Dec 25 at 4:59am (Asia/Shanghai)

Extra usage
Extra usage not enabled · /extra-usage to enable

Esc to cancel`;

  it('should parse all quotas from output', () => {
    const quotas = parseQuotas(sampleOutput);
    expect(quotas).toHaveLength(2);
    expect(quotas[0]).toEqual({
      label: 'Current session',
      percentUsed: 1,
      resetText: 'Resets 2:59pm (Asia/Shanghai)',
    });
    expect(quotas[1]).toEqual({
      label: 'Current week (all models)',
      percentUsed: 16,
      resetText: 'Resets Dec 25 at 4:59am (Asia/Shanghai)',
    });
  });

  it('should parse model-specific quotas', () => {
    const text = `Current session
5% used
Resets in 2h

Current week (Opus)
40% used
Resets Jan 1

Current week (Sonnet)
20% used
Resets Jan 1`;
    const quotas = parseQuotas(text);
    expect(quotas).toHaveLength(3);
    expect(quotas[1].label).toBe('Current week (Opus)');
    expect(quotas[1].percentUsed).toBe(40);
  });

  it('should parse "Sonnet only" variant label', () => {
    const text = `Current session
10% used
Resets 2am

Current week (all models)
13% used
Resets Feb 28

Current week (Sonnet only)
0% used
Resets Mar 3`;
    const quotas = parseQuotas(text);
    expect(quotas).toHaveLength(3);
    expect(quotas[2].label).toBe('Current week (Sonnet only)');
    expect(quotas[2].percentUsed).toBe(0);
  });
});

describe('extractAccountInfo', () => {
  it('should extract account header from TUI output', () => {
    const text = `────────────────────
 Accessing workspace:
 /Users/jay
╭─── Claude Code v2.1.52 ──╮
│  Opus 4.6 · Claude Max   │
│       /Users/jay          │
╰───────────────────────────╯`;
    expect(extractAccountInfo(text)).toBe('Opus 4.6 · Claude Max');
  });

  it('should skip separator lines', () => {
    const text = `────────
Opus 4.5 · Claude Pro · user@example.com
Current session`;
    expect(extractAccountInfo(text)).toBe('Opus 4.5 · Claude Pro · user@example.com');
  });

  it('should return empty when no account line found', () => {
    expect(extractAccountInfo('just some text\nno account info')).toBe('');
  });
});

describe('parseExtraUsage', () => {
  it('should return null when extra usage not enabled', () => {
    const text = 'Extra usage\nExtra usage not enabled · /extra-usage to enable';
    expect(parseExtraUsage(text)).toBeNull();
  });

  it('should parse extra usage with dollar amounts', () => {
    const text = `Extra usage
$5.41 / $20.00 spent
Resets Jan 1, 2026`;
    const eu = parseExtraUsage(text);
    expect(eu).not.toBeNull();
    expect(eu!.spent).toBe('$5.41');
    expect(eu!.budget).toBe('$20.00');
    expect(eu!.percentUsed).toBe(27); // 5.41/20.00 ≈ 27%
    expect(eu!.resetText).toBe('Resets Jan 1, 2026');
  });

  it('should return null when no extra usage section', () => {
    const text = 'Current session\n1% used';
    expect(parseExtraUsage(text)).toBeNull();
  });

  it('should handle amounts with commas', () => {
    const text = `Extra usage
$1,234.56 / $5,000.00 spent
Resets Feb 1`;
    const eu = parseExtraUsage(text);
    expect(eu).not.toBeNull();
    expect(eu!.spent).toBe('$1,234.56');
    expect(eu!.budget).toBe('$5,000.00');
    expect(eu!.percentUsed).toBe(25);
  });
});

// ── UsageManager integration tests (stats-cache) ──────────────────

describe('UsageManager', () => {
  let manager: UsageManager;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
    manager = new UsageManager(mockLog, mockConfig);
    // Default: empty JSONL scan, probe failure
    setupEmptyJSONLScan();
    setupProbeFailure();
  });

  it('should parse stats-cache.json and return structured data', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(sampleStatsCache));

    const result = await manager.fetchClaude();

    expect(result.totalSessions).toBe(87);
    expect(result.totalMessages).toBe(73781);
    expect(result.firstSessionDate).toBe('2025-01-06');
    expect(result.lastComputedDate).toBe('2025-02-20');
  });

  it('should parse model usage correctly', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(sampleStatsCache));

    const result = await manager.fetchClaude();

    expect(Object.keys(result.modelUsage)).toHaveLength(2);
    expect(result.modelUsage['claude-sonnet-4-20250514']).toEqual({
      inputTokens: 5000000,
      outputTokens: 1200000,
      cacheReadInputTokens: 800000,
      cacheCreationInputTokens: 300000,
    });
  });

  it('should return last 7 days of daily activity', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(sampleStatsCache));

    const result = await manager.fetchClaude();

    expect(result.recentDays).toHaveLength(7);
    expect(result.recentDays[0].date).toBe('2025-02-14');
    expect(result.recentDays[6].date).toBe('2025-02-20');
  });

  it('should handle missing fields with defaults', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({}));

    const result = await manager.fetchClaude();

    expect(result.totalSessions).toBe(0);
    expect(result.totalMessages).toBe(0);
    expect(result.firstSessionDate).toBe('');
    expect(result.modelUsage).toEqual({});
    expect(result.recentDays).toEqual([]);
  });

  it('should handle model usage with missing token fields', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        modelUsage: {
          'some-model': { inputTokens: 100 },
        },
      }),
    );

    const result = await manager.fetchClaude();

    expect(result.modelUsage['some-model']).toEqual({
      inputTokens: 100,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('should return empty data when stats file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const result = await manager.fetchClaude();
    expect(result.totalSessions).toBe(0);
    expect(result.totalMessages).toBe(0);
    expect(result.modelUsage).toEqual({});
    expect(result.recentDays).toEqual([]);
  });

  it('should slice only last 7 days when more than 7 entries', async () => {
    const manyDays = Array.from({ length: 30 }, (_, i) => ({
      date: `2025-02-${String(i + 1).padStart(2, '0')}`,
      messageCount: 10,
      sessionCount: 1,
      toolCallCount: 20,
    }));
    mockReadFile.mockResolvedValue(JSON.stringify({ dailyActivity: manyDays }));

    const result = await manager.fetchClaude();

    expect(result.recentDays).toHaveLength(7);
    expect(result.recentDays[0].date).toBe('2025-02-24');
    expect(result.recentDays[6].date).toBe('2025-02-30');
  });

  it('should return empty quota fields when probe fails', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(sampleStatsCache));

    const result = await manager.fetchClaude();

    expect(result.accountTier).toBe('');
    expect(result.accountInfo).toBe('');
    expect(result.quotas).toEqual([]);
    expect(result.extraUsage).toBeNull();
    // Stats-cache data should still be present
    expect(result.totalSessions).toBe(87);
  });

  it('should merge probe data with stats-cache data', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(sampleStatsCache));

    const probeOutput = `Opus 4.5 · Claude Pro · user@example.com
~/Projects/test

Current session
▌                                                  5% used
Resets 3:00pm (Asia/Shanghai)

Current week (all models)
█████                                              25% used
Resets Dec 30 at 5:00am (Asia/Shanghai)

Extra usage
Extra usage not enabled · /extra-usage to enable`;

    setupProbeSuccess(probeOutput);

    const result = await manager.fetchClaude();

    expect(result.accountTier).toBe('Pro');
    expect(result.accountInfo).toBe('Opus 4.5 · Claude Pro · user@example.com');
    expect(result.quotas).toHaveLength(2);
    expect(result.quotas[0].percentUsed).toBe(5);
    expect(result.quotas[1].percentUsed).toBe(25);
    expect(result.extraUsage).toBeNull();
    // Stats-cache still available
    expect(result.totalSessions).toBe(87);
  });
});

// ── JSONL token scanning tests ────────────────────────────────────

describe('UsageManager JSONL token scanning', () => {
  let manager: UsageManager;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-02-20T12:00:00Z'));
    manager = new UsageManager(mockLog, mockConfig);
    mockReadFile.mockResolvedValue(JSON.stringify(sampleStatsCache));
    setupProbeFailure();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupJSONLScan(files: { name: string; mtimeMs: number; lines: string[] }[]): void {
    mockReaddir.mockImplementation(async (p) => {
      const ps = String(p);
      if (ps.endsWith('projects')) {
        return ['my-project'] as unknown as ReturnType<typeof readdir>;
      }
      if (ps.includes('my-project')) {
        return files.map((f) => f.name) as unknown as ReturnType<typeof readdir>;
      }
      return [] as unknown as ReturnType<typeof readdir>;
    });

    mockStat.mockImplementation(async (p) => {
      const ps = String(p);
      const file = files.find((f) => ps.endsWith(f.name));
      return { mtimeMs: file?.mtimeMs ?? 0 } as Awaited<ReturnType<typeof stat>>;
    });

    // createReadStream calls happen in order
    for (const file of files) {
      mockJsonlFile(file.lines);
    }
  }

  it('should compute todayTokens from JSONL session files', async () => {
    const now = new Date('2025-02-20T12:00:00Z').getTime();
    setupJSONLScan([
      {
        name: 'session1.jsonl',
        mtimeMs: now,
        lines: [
          // Today's messages
          assistantLine('2025-02-20T10:00:00Z', 'claude-opus-4-6', {
            input_tokens: 1000,
            output_tokens: 500,
          }),
          assistantLine('2025-02-20T11:00:00Z', 'claude-opus-4-6', {
            input_tokens: 2000,
            output_tokens: 800,
          }),
          // Yesterday's message (should not count as today)
          assistantLine('2025-02-19T23:00:00Z', 'claude-opus-4-6', {
            input_tokens: 5000,
            output_tokens: 3000,
          }),
        ],
      },
    ]);

    const result = await manager.fetchClaude();

    // Today: (1000+500) + (2000+800) = 4300
    expect(result.todayTokens).toBe(4300);
  });

  it('should compute weekTokens across multiple files', async () => {
    const now = new Date('2025-02-20T12:00:00Z').getTime();
    setupJSONLScan([
      {
        name: 'session1.jsonl',
        mtimeMs: now,
        lines: [
          assistantLine('2025-02-20T10:00:00Z', 'claude-opus-4-6', {
            input_tokens: 1000,
            output_tokens: 500,
          }),
          assistantLine('2025-02-15T10:00:00Z', 'claude-sonnet-4-6', {
            input_tokens: 3000,
            output_tokens: 1000,
          }),
        ],
      },
      {
        name: 'session2.jsonl',
        mtimeMs: now,
        lines: [
          assistantLine('2025-02-18T10:00:00Z', 'claude-opus-4-6', {
            input_tokens: 2000,
            output_tokens: 700,
          }),
        ],
      },
    ]);

    const result = await manager.fetchClaude();

    // Week: (1000+500) + (3000+1000) + (2000+700) = 8200
    expect(result.weekTokens).toBe(8200);
  });

  it('should group recentDailyTokens by date and model', async () => {
    const now = new Date('2025-02-20T12:00:00Z').getTime();
    setupJSONLScan([
      {
        name: 'session1.jsonl',
        mtimeMs: now,
        lines: [
          assistantLine('2025-02-20T10:00:00Z', 'claude-opus-4-6', {
            input_tokens: 1000,
            output_tokens: 500,
          }),
          assistantLine('2025-02-20T11:00:00Z', 'claude-sonnet-4-6', {
            input_tokens: 2000,
            output_tokens: 800,
          }),
          assistantLine('2025-02-19T10:00:00Z', 'claude-opus-4-6', {
            input_tokens: 3000,
            output_tokens: 1000,
          }),
        ],
      },
    ]);

    const result = await manager.fetchClaude();

    expect(result.recentDailyTokens).toHaveLength(2);
    // Sorted by date
    expect(result.recentDailyTokens[0].date).toBe('2025-02-19');
    expect(result.recentDailyTokens[0].tokensByModel['claude-opus-4-6']).toBe(4000);
    expect(result.recentDailyTokens[1].date).toBe('2025-02-20');
    expect(result.recentDailyTokens[1].tokensByModel['claude-opus-4-6']).toBe(1500);
    expect(result.recentDailyTokens[1].tokensByModel['claude-sonnet-4-6']).toBe(2800);
  });

  it('should include cache tokens in totals', async () => {
    const now = new Date('2025-02-20T12:00:00Z').getTime();
    setupJSONLScan([
      {
        name: 'session1.jsonl',
        mtimeMs: now,
        lines: [
          assistantLine('2025-02-20T10:00:00Z', 'claude-opus-4-6', {
            input_tokens: 100,
            output_tokens: 200,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 400,
          }),
        ],
      },
    ]);

    const result = await manager.fetchClaude();

    // 100 + 200 + 300 + 400 = 1000
    expect(result.todayTokens).toBe(1000);
  });

  it('should skip old files by mtime', async () => {
    const now = new Date('2025-02-20T12:00:00Z').getTime();
    const twoWeeksAgo = now - 14 * 86400000;
    setupJSONLScan([
      {
        name: 'old-session.jsonl',
        mtimeMs: twoWeeksAgo,
        lines: [
          assistantLine('2025-02-06T10:00:00Z', 'claude-opus-4-6', {
            input_tokens: 99999,
            output_tokens: 99999,
          }),
        ],
      },
    ]);

    const result = await manager.fetchClaude();

    // Old file should be skipped entirely
    expect(result.todayTokens).toBe(0);
    expect(result.weekTokens).toBe(0);
    expect(result.recentDailyTokens).toEqual([]);
  });

  it('should skip non-assistant lines in JSONL', async () => {
    const now = new Date('2025-02-20T12:00:00Z').getTime();
    setupJSONLScan([
      {
        name: 'session1.jsonl',
        mtimeMs: now,
        lines: [
          JSON.stringify({ type: 'user', content: 'hello' }),
          JSON.stringify({ type: 'progress', data: 'something' }),
          assistantLine('2025-02-20T10:00:00Z', 'claude-opus-4-6', {
            input_tokens: 500,
            output_tokens: 200,
          }),
          JSON.stringify({ type: 'file-history-snapshot', messageId: 'abc' }),
        ],
      },
    ]);

    const result = await manager.fetchClaude();

    expect(result.todayTokens).toBe(700);
  });

  it('should return zeros when no JSONL projects exist', async () => {
    mockReaddir.mockImplementation(async () => [] as unknown as ReturnType<typeof readdir>);

    const result = await manager.fetchClaude();

    expect(result.todayTokens).toBe(0);
    expect(result.weekTokens).toBe(0);
    expect(result.recentDailyTokens).toEqual([]);
  });
});
