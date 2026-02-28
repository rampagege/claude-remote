import type { WebSocket } from 'ws';

// ── Client → Server Messages ──────────────────────────────────────

export interface InputMessage {
  type: 'input';
  data: string;
}

export interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface TmuxListMessage {
  type: 'tmuxList';
}

export interface TmuxNewMessage {
  type: 'tmuxNew';
  name: string;
}

export interface TmuxKillMessage {
  type: 'tmuxKill';
  name: string;
}

export interface TmuxAttachMessage {
  type: 'tmuxAttach';
  name: string;
  cols?: number;
  rows?: number;
}

export interface TmuxDetachMessage {
  type: 'tmuxDetach';
}

export interface TmuxRenameMessage {
  type: 'tmuxRename';
  from: string;
  to: string;
}

export interface TmuxScrollMessage {
  type: 'tmuxScroll';
  name: string;
  direction: 'up' | 'down';
}

export interface TmuxCommandMessage {
  type: 'tmuxCommand';
  name: string;
  command:
    | 'splitH'
    | 'splitV'
    | 'newWindow'
    | 'nextWindow'
    | 'prevWindow'
    | 'nextPane'
    | 'zoomPane'
    | 'killPane';
}

export interface TmuxCaptureMessage {
  type: 'tmuxCapture';
  name: string;
}

export interface TmuxListWindowsMessage {
  type: 'tmuxListWindows';
  name: string;
}

export interface TmuxSelectWindowMessage {
  type: 'tmuxSelectWindow';
  name: string;
  index: number;
}

export interface GetUsageMessage {
  type: 'getUsage';
  provider: 'claude';
}

export interface AuthMessage {
  type: 'auth';
  token: string;
}

// ── AI Supervisor Types ──────────────────────────────────────────

export type SupervisorMode = 'auto' | 'confirm' | 'watch';

export interface SupervisorStartMessage {
  type: 'supervisorStart';
  sessionName: string;
  goal: string;
  mode: SupervisorMode;
}

export interface SupervisorStopMessage {
  type: 'supervisorStop';
  sessionName: string;
}

export interface SupervisorConfirmMessage {
  type: 'supervisorConfirm';
  sessionName: string;
  actionId: string;
  approved: boolean;
}

export interface SupervisorStatusMessage {
  type: 'supervisorStatus';
  sessionName: string;
  active: boolean;
  mode: SupervisorMode;
  goal: string;
}

export interface SupervisorActionMessage {
  type: 'supervisorAction';
  sessionName: string;
  actionId: string;
  suggestion: string;
  reasoning: string;
  waitingForConfirm: boolean;
}

export interface SupervisorLogMessage {
  type: 'supervisorLog';
  sessionName: string;
  text: string;
  level: 'info' | 'warn' | 'error';
}

export type SupervisorProvider = 'openrouter' | 'openai' | 'minimax';

export interface SupervisorConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  pollIntervalMs: number;
  maxCaptureLines: number;
}

export type ClientMessage =
  | InputMessage
  | ResizeMessage
  | TmuxListMessage
  | TmuxNewMessage
  | TmuxKillMessage
  | TmuxAttachMessage
  | TmuxDetachMessage
  | TmuxRenameMessage
  | TmuxScrollMessage
  | TmuxCommandMessage
  | TmuxCaptureMessage
  | TmuxListWindowsMessage
  | TmuxSelectWindowMessage
  | GetUsageMessage
  | AuthMessage
  | SupervisorStartMessage
  | SupervisorStopMessage
  | SupervisorConfirmMessage;

// ── Server → Client Messages ──────────────────────────────────────

export interface ReadyMessage {
  type: 'ready';
  sessionId: string;
}

export interface OutputMessage {
  type: 'output';
  sessionId: string;
  data: string;
}

export interface TmuxSessionListMessage {
  type: 'tmuxSessionList';
  sessions: TmuxSessionInfo[];
}

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
  preview: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface ExitMessage {
  type: 'exit';
  sessionId: string;
}

export interface AuthResultMessage {
  type: 'authResult';
  success: boolean;
}

export interface TmuxCaptureResultMessage {
  type: 'tmuxCaptureResult';
  text: string;
}

export interface TmuxWindowInfo {
  index: number;
  name: string;
  active: boolean;
  panes: number;
}

export interface TmuxWindowListMessage {
  type: 'tmuxWindowList';
  windows: TmuxWindowInfo[];
}

export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface DailyTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

export interface UsageQuota {
  label: string; // "Current session", "Current week (all models)", etc.
  percentUsed: number; // 0-100
  resetText: string; // "Resets 2:59pm (Asia/Shanghai)"
}

export interface ExtraUsage {
  spent: string; // "$5.41"
  budget: string; // "$20.00"
  percentUsed: number; // 0-100
  resetText: string; // "Resets Jan 1, 2026"
}

export interface ClaudeUsageData {
  // Live quota from `claude /usage`
  accountTier: string; // "Pro", "Max", "API", ""
  accountInfo: string; // e.g. "Opus 4.5 · Claude Pro · user@example.com"
  quotas: UsageQuota[];
  extraUsage: ExtraUsage | null;

  // Aggregate from stats-cache.json
  totalSessions: number;
  totalMessages: number;
  firstSessionDate: string;
  lastComputedDate: string;
  modelUsage: Record<string, ModelTokenUsage>;
  recentDays: DailyActivity[];

  // JSONL token scanning (today/week totals)
  todayTokens: number;
  weekTokens: number;
  recentDailyTokens: DailyTokens[];
}

export interface UsageResultMessage {
  type: 'usageResult';
  provider: 'claude';
  data: ClaudeUsageData;
}

export interface ServerFeaturesMessage {
  type: 'serverFeatures';
  supervisorEnabled: boolean;
}

export type ServerMessage =
  | ReadyMessage
  | OutputMessage
  | TmuxSessionListMessage
  | ErrorMessage
  | ExitMessage
  | AuthResultMessage
  | TmuxCaptureResultMessage
  | TmuxWindowListMessage
  | UsageResultMessage
  | SupervisorStatusMessage
  | SupervisorActionMessage
  | SupervisorLogMessage
  | ServerFeaturesMessage;

// ── Internal Types ────────────────────────────────────────────────

export interface ClientState {
  ws: WebSocket;
  authenticated: boolean;
  activeTmuxSession: string | null;
}

export interface ServerConfig {
  port: number;
  host: string;
  authToken: string;
  logLevel: string;
  claudeCmd: string;
  maxTmuxSessions: number;
  supervisorEnabled: boolean;
}
