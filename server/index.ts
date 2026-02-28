import 'dotenv/config';
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import pino from 'pino';

import { TmuxManager } from './modules/tmuxManager.js';
import { UsageManager } from './modules/usageManager.js';
import { AiSupervisor } from './modules/aiSupervisor.js';
import { ChannelManager, WebChannel, TelegramChannel } from './modules/supervisorChannels.js';
import { stripAnsi, escapeHtmlBasic, VALID_SESSION_NAME } from './modules/utils.js';
import { extractToken, validateToken, checkAuthConfig } from './modules/auth.js';
import { getTlsOptions } from './modules/tls.js';
import type {
  ClientMessage,
  ClientState,
  ServerConfig,
  ServerMessage,
  SupervisorConfig,
} from './types.js';
import type { SupervisorProvider } from './types.js';
import { clientMessageSchema } from './modules/validation.js';

// ── Config ────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = import.meta.url.endsWith('.ts');

// Resolve supervisor LLM provider
const PROVIDER_DEFAULTS: Record<
  SupervisorProvider,
  { baseUrl: string; model: string; envKey: string }
> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    envKey: 'OPENROUTER_API_KEY',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
  },
  minimax: {
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'MiniMax-Text-01',
    envKey: 'MINIMAX_API_KEY',
  },
};

const supervisorProvider = (process.env.SUPERVISOR_PROVIDER || 'openrouter') as SupervisorProvider;
const providerDef = PROVIDER_DEFAULTS[supervisorProvider] ?? PROVIDER_DEFAULTS.openrouter;
const supervisorApiKey = process.env.SUPERVISOR_API_KEY || process.env[providerDef.envKey] || '';

const config: ServerConfig = {
  port: parseInt(process.env.PORT || '3980', 10),
  host: process.env.HOST || '127.0.0.1',
  authToken: process.env.AUTH_TOKEN || '',
  logLevel: process.env.LOG_LEVEL || 'info',
  claudeCmd: process.env.CLAUDE_CMD || 'claude',
  maxTmuxSessions: parseInt(process.env.MAX_TMUX_SESSIONS || '10', 10),
  supervisorEnabled: process.env.SUPERVISOR_ENABLED !== 'false' && !!supervisorApiKey,
};

const log = pino({
  level: config.logLevel,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
});

const useHttps = process.env.HTTPS === 'true' || !!process.env.TLS_KEY;
const httpsPort = parseInt(process.env.HTTPS_PORT || String(config.port + 1), 10);

// ── Express ───────────────────────────────────────────────────────

const app = express();

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // modern browsers use CSP instead
  next();
});

// Servers — declared here for module scope
let httpServer: import('node:http').Server;
let httpsServer: import('node:https').Server | null = null;

// ── Managers ──────────────────────────────────────────────────────

const tmuxManager = new TmuxManager(log, config);
const usageManager = new UsageManager(log, config);

// ── Supervisor Channels ──────────────────────────────────────────

const channelManager = new ChannelManager();
const activeChannel = (process.env.SUPERVISOR_CHANNEL || 'web').trim();

const supervisorConfig: SupervisorConfig = {
  apiKey: supervisorApiKey,
  baseUrl: process.env.SUPERVISOR_BASE_URL || providerDef.baseUrl,
  model: process.env.SUPERVISOR_MODEL || providerDef.model,
  pollIntervalMs: parseInt(process.env.SUPERVISOR_POLL_MS || '5000', 10),
  maxCaptureLines: parseInt(process.env.SUPERVISOR_MAX_LINES || '80', 10),
};

const aiSupervisor = new AiSupervisor(log, tmuxManager, supervisorConfig, channelManager);

// Register the single active notification channel
if (activeChannel === 'telegram') {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (botToken && chatId) {
    channelManager.addChannel(
      new TelegramChannel(
        botToken,
        chatId,
        (sessionName, actionId, approved) => aiSupervisor.confirm(sessionName, actionId, approved),
        (sessionName) => aiSupervisor.stop(sessionName),
        (text) => {
          const session = aiSupervisor.getActiveSessionName();
          if (session) aiSupervisor.sendInput(session, text);
        },
        async (cmd, args) => handleTelegramCommand(cmd, args),
        log,
      ),
    );
    log.info('Supervisor channel: telegram');
  } else {
    log.warn(
      'SUPERVISOR_CHANNEL=telegram but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — falling back to web',
    );
    channelManager.addChannel(new WebChannel(broadcast));
  }
} else {
  channelManager.addChannel(new WebChannel(broadcast));
  log.info('Supervisor channel: web');
}

// ── Telegram Command Handler ─────────────────────────────────────

function validateSessionName(name: string): string | null {
  if (!name || name.length > 64 || !VALID_SESSION_NAME.test(name)) {
    return '🔴 Invalid session name (only a-z, 0-9, _, - allowed)';
  }
  return null;
}

// Usage cache — avoid repeated fetches within a short window
let usageCache: { data: import('./types.js').ClaudeUsageData; ts: number } | null = null;
const USAGE_CACHE_TTL = 30_000; // 30s

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

async function handleTelegramCommand(cmd: string, args: string): Promise<string> {
  switch (cmd) {
    case 'help':
    case 'start': {
      return (
        '<b>Commands</b>\n' +
        '/list — list tmux sessions\n' +
        '/status — supervised sessions status\n' +
        '/usage — Claude token usage\n' +
        '/watch <i>session</i> <i>goal</i> — start supervisor (confirm mode)\n' +
        '/auto <i>session</i> <i>goal</i> — start supervisor (auto mode)\n' +
        '/stop [session] — stop supervisor (all if omitted)\n' +
        '/capture [session] — show terminal content\n' +
        '/send <i>session</i> <i>text</i> — send text to session\n' +
        '/help — show this message'
      );
    }

    case 'list': {
      const sessions = await tmuxManager.list();
      if (sessions.length === 0) return 'No tmux sessions.';
      return (
        '<b>Sessions</b>\n' +
        sessions
          .map((s) => {
            const sup = aiSupervisor.isActive(s.name);
            const icon = s.attached ? '🟢' : '⚪';
            const supTag = sup ? ' 🤖' : '';
            return `${icon} <code>${escapeHtmlBasic(s.name)}</code> — ${s.windows}w${supTag}`;
          })
          .join('\n')
      );
    }

    case 'status': {
      const sessions = await tmuxManager.list();
      const active = sessions.filter((s) => aiSupervisor.isActive(s.name));
      if (active.length === 0) return 'No active supervisors.';
      return (
        '<b>Active Supervisors</b>\n' +
        active.map((s) => `🤖 <code>${escapeHtmlBasic(s.name)}</code>`).join('\n')
      );
    }

    case 'watch':
    case 'auto': {
      if (!args) return `Usage: /${cmd} <i>session</i> <i>goal</i>`;
      const spaceIdx = args.indexOf(' ');
      const sessionName = spaceIdx > 0 ? args.slice(0, spaceIdx) : args;
      const err = validateSessionName(sessionName);
      if (err) return err;
      const goal = spaceIdx > 0 ? args.slice(spaceIdx + 1).trim() : '';
      if (!goal) return `Usage: /${cmd} <i>session</i> <i>goal</i>`;
      const mode = cmd === 'auto' ? 'auto' : 'confirm';
      if (!config.supervisorEnabled) return '🔴 Supervisor is disabled on server.';
      aiSupervisor.start(sessionName, goal, mode);
      return `▶️ Supervisor started on <code>${escapeHtmlBasic(sessionName)}</code> (${mode})`;
    }

    case 'stop': {
      if (args) {
        const err = validateSessionName(args);
        if (err) return err;
        aiSupervisor.stop(args);
        return `⏹ Supervisor stopped on <code>${escapeHtmlBasic(args)}</code>`;
      }
      aiSupervisor.stopAll();
      return '⏹ All supervisors stopped.';
    }

    case 'capture': {
      const sessionName = args || aiSupervisor.getActiveSessionName();
      if (!sessionName) return 'Usage: /capture <i>session</i>';
      if (args) {
        const err = validateSessionName(args);
        if (err) return err;
      }
      try {
        const raw = await tmuxManager.captureFull(sessionName);
        const clean = stripAnsi(raw);
        const lines = clean.split('\n');
        const tail = lines.slice(-50).join('\n');
        return `<b>[${escapeHtmlBasic(sessionName)}]</b>\n<pre>${escapeHtmlBasic(tail)}</pre>`;
      } catch {
        return `🔴 Session <code>${escapeHtmlBasic(sessionName)}</code> not found.`;
      }
    }

    case 'send': {
      if (!args) return 'Usage: /send <i>session</i> <i>text</i>';
      const spaceIdx = args.indexOf(' ');
      if (spaceIdx <= 0) return 'Usage: /send <i>session</i> <i>text</i>';
      const sessionName = args.slice(0, spaceIdx);
      const err = validateSessionName(sessionName);
      if (err) return err;
      const text = args.slice(spaceIdx + 1).trim();
      if (!text) return 'Usage: /send <i>session</i> <i>text</i>';
      if (aiSupervisor.isActive(sessionName)) {
        aiSupervisor.sendInput(sessionName, text);
      } else {
        // Direct send to non-supervised session via tmux manager
        await tmuxManager.sendKeys(sessionName, text);
      }
      return `✅ Sent to <code>${escapeHtmlBasic(sessionName)}</code>: <code>${escapeHtmlBasic(text)}</code>`;
    }

    case 'usage': {
      const now = Date.now();
      if (!usageCache || now - usageCache.ts > USAGE_CACHE_TTL) {
        const data = await usageManager.fetchClaude();
        usageCache = { data, ts: now };
      }
      const d = usageCache.data;
      const fresh =
        now - usageCache.ts < 2000
          ? '(just fetched)'
          : `(cached ${Math.round((now - usageCache.ts) / 1000)}s ago)`;

      let msg = `<b>Claude Usage</b> ${fresh}\n`;

      if (d.accountInfo) {
        msg += `${escapeHtmlBasic(d.accountInfo)}\n`;
      }

      msg += '\n';

      // Quotas
      for (const q of d.quotas) {
        const bar =
          '█'.repeat(Math.round(q.percentUsed / 5)) +
          '░'.repeat(20 - Math.round(q.percentUsed / 5));
        msg += `<b>${escapeHtmlBasic(q.label)}</b>  ${q.percentUsed}%\n${bar}\n${escapeHtmlBasic(q.resetText)}\n\n`;
      }

      // Extra usage
      if (d.extraUsage) {
        msg += `<b>Extra</b>: ${escapeHtmlBasic(d.extraUsage.spent)} / ${escapeHtmlBasic(d.extraUsage.budget)} (${d.extraUsage.percentUsed}%)\n${escapeHtmlBasic(d.extraUsage.resetText)}\n\n`;
      }

      // Token counts
      msg += `<b>TODAY</b>  ${formatTokens(d.todayTokens)} tokens\n`;
      msg += `<b>THIS WEEK</b>  ${formatTokens(d.weekTokens)} tokens`;

      return msg;
    }

    default:
      return `Unknown command: /${escapeHtmlBasic(cmd)}\nSend /help for available commands.`;
  }
}

// ── Rate Limiter ──────────────────────────────────────────────────

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const connectionAttempts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = connectionAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    connectionAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Periodically clean up expired rate limiter entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of connectionAttempts) {
    if (now >= entry.resetAt) connectionAttempts.delete(ip);
  }
}, 60_000).unref();

// ── WebSocket (noServer mode for Vite HMR compatibility) ─────────

const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

function attachUpgradeHandler(srv: import('node:http').Server | import('node:https').Server) {
  srv.on('upgrade', (req, socket, head) => {
    // Prevent unhandled socket errors from crashing the process
    socket.on('error', (err) => {
      log.debug({ err }, 'Socket error during upgrade');
    });

    const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (pathname === '/ws') {
      // Rate limiting by IP
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (isRateLimited(ip)) {
        log.warn({ ip }, 'Rate limit exceeded — connection rejected');
        socket.destroy();
        return;
      }

      // Origin validation
      const origin = req.headers.origin;
      if (origin) {
        try {
          const originHost = new URL(origin).hostname;
          const serverHost = req.headers.host?.split(':')[0] ?? config.host;
          const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(originHost);
          const matchesServer = originHost === serverHost;
          if (!isLocalhost && !matchesServer) {
            log.warn({ origin, serverHost }, 'Origin mismatch — connection rejected');
            socket.destroy();
            return;
          }
        } catch {
          log.warn({ origin }, 'Malformed Origin header — connection rejected');
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
    // Other upgrade requests (e.g. Vite HMR /__vite_hmr) are handled by Vite
  });
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(msg: ServerMessage): void {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  });
}

wss.on('connection', (ws, req) => {
  // Check if token was provided via sec-websocket-protocol header (fallback path)
  const token = extractToken(req);
  const isAuthed = validateToken(token, config);

  const state: ClientState = {
    ws,
    authenticated: isAuthed,
    activeTmuxSession: null,
  };

  const sendFeatures = () => {
    send(ws, { type: 'serverFeatures', supervisorEnabled: config.supervisorEnabled });
  };

  if (isAuthed) {
    send(ws, { type: 'authResult', success: true });
    sendFeatures();
    log.info('Client connected (authenticated via header)');
  } else {
    // Give client a grace period to authenticate via message.
    // If still not authenticated after 10s, close the connection.
    const authTimeout = setTimeout(() => {
      if (!state.authenticated) {
        send(ws, { type: 'error', message: 'Authentication timeout' });
        ws.close();
      }
    }, 10_000);

    // Clear timeout if connection closes before timeout fires
    ws.on('close', () => clearTimeout(authTimeout));
  }

  ws.on('message', (raw) => {
    const parsed = clientMessageSchema.safeParse(
      (() => {
        try {
          return JSON.parse(raw.toString());
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success) {
      send(ws, { type: 'error', message: 'Invalid message: ' + parsed.error.issues[0]?.message });
      return;
    }
    const msg = parsed.data;

    if (msg.type === 'auth') {
      const ok = validateToken(msg.token, config);
      state.authenticated = ok;
      send(ws, { type: 'authResult', success: ok });
      if (!ok) {
        send(ws, { type: 'error', message: 'Invalid token' });
        setTimeout(() => ws.close(), 1000);
      } else {
        sendFeatures();
        log.info('Client authenticated via message');
      }
      return;
    }

    if (!state.authenticated) {
      send(ws, { type: 'error', message: 'Not authenticated' });
      return;
    }

    handleMessage(ws, state, msg);
  });

  ws.on('close', () => {
    log.info('Client disconnected');
    if (state.activeTmuxSession) {
      tmuxManager.detach(state.activeTmuxSession);
    }
  });

  ws.on('error', (err) => {
    log.error({ err }, 'WebSocket error');
  });
});

// ── Message Handler ───────────────────────────────────────────────

function handleMessage(ws: WebSocket, state: ClientState, msg: ClientMessage): void {
  try {
    switch (msg.type) {
      case 'input': {
        if (state.activeTmuxSession) {
          tmuxManager.write(state.activeTmuxSession, msg.data);
        } else {
          send(ws, { type: 'error', message: 'No active session' });
        }
        break;
      }

      case 'resize': {
        if (state.activeTmuxSession) {
          tmuxManager.resize(state.activeTmuxSession, msg.cols, msg.rows);
        }
        break;
      }

      case 'tmuxList': {
        tmuxManager
          .list()
          .then((sessions) => send(ws, { type: 'tmuxSessionList', sessions }))
          .catch((err) => send(ws, { type: 'error', message: (err as Error).message }));
        break;
      }

      case 'tmuxNew': {
        tmuxManager
          .create(msg.name)
          .then(() => tmuxManager.list())
          .then((sessions) => send(ws, { type: 'tmuxSessionList', sessions }))
          .catch((err) => send(ws, { type: 'error', message: (err as Error).message }));
        break;
      }

      case 'tmuxKill': {
        tmuxManager
          .kill(msg.name)
          .then(() => tmuxManager.list())
          .then((sessions) => send(ws, { type: 'tmuxSessionList', sessions }))
          .catch((err) => send(ws, { type: 'error', message: (err as Error).message }));
        break;
      }

      case 'tmuxRename': {
        tmuxManager
          .rename(msg.from, msg.to)
          .then(() => tmuxManager.list())
          .then((sessions) => send(ws, { type: 'tmuxSessionList', sessions }))
          .catch((err) => send(ws, { type: 'error', message: (err as Error).message }));
        break;
      }

      case 'tmuxAttach': {
        if (state.activeTmuxSession) {
          tmuxManager.detach(state.activeTmuxSession);
        }

        // Pre-compute key so the closure captures a resolved value (no race condition)
        const key = `tmux:${msg.name}`;
        tmuxManager.attach(
          msg.name,
          msg.cols || 80,
          msg.rows || 24,
          (data) => send(ws, { type: 'output', sessionId: key, data }),
          () => {
            state.activeTmuxSession = null;
          },
        );

        state.activeTmuxSession = key;
        send(ws, { type: 'ready', sessionId: key });
        break;
      }

      case 'tmuxDetach': {
        if (state.activeTmuxSession) {
          tmuxManager.detach(state.activeTmuxSession);
          state.activeTmuxSession = null;
        }
        break;
      }

      case 'tmuxScroll': {
        tmuxManager
          .scrollPage(msg.name, msg.direction)
          .catch((err) => send(ws, { type: 'error', message: (err as Error).message }));
        break;
      }

      case 'tmuxCommand': {
        tmuxManager
          .runCommand(msg.name, msg.command)
          .catch((err) => send(ws, { type: 'error', message: (err as Error).message }));
        break;
      }

      case 'tmuxCapture': {
        tmuxManager
          .captureFull(msg.name)
          .then((text) => send(ws, { type: 'tmuxCaptureResult', text }))
          .catch((err) => send(ws, { type: 'error', message: (err as Error).message }));
        break;
      }

      case 'tmuxListWindows': {
        tmuxManager
          .listWindows(msg.name)
          .then((windows) => send(ws, { type: 'tmuxWindowList', windows }))
          .catch((err) => send(ws, { type: 'error', message: (err as Error).message }));
        break;
      }

      case 'tmuxSelectWindow': {
        tmuxManager
          .selectWindow(msg.name, msg.index)
          .catch((err) => send(ws, { type: 'error', message: (err as Error).message }));
        break;
      }

      case 'getUsage': {
        usageManager
          .fetchClaude()
          .then((data) => send(ws, { type: 'usageResult', provider: 'claude', data }))
          .catch((err) => send(ws, { type: 'error', message: (err as Error).message }));
        break;
      }

      case 'supervisorStart': {
        if (!config.supervisorEnabled) {
          send(ws, {
            type: 'error',
            message: 'AI Supervisor is disabled (set API key and SUPERVISOR_ENABLED!=false)',
          });
          break;
        }
        aiSupervisor.start(msg.sessionName, msg.goal, msg.mode);
        break;
      }

      case 'supervisorStop': {
        aiSupervisor.stop(msg.sessionName);
        break;
      }

      case 'supervisorConfirm': {
        aiSupervisor.confirm(msg.sessionName, msg.actionId, msg.approved);
        break;
      }

      default: {
        send(ws, {
          type: 'error',
          message: `Unknown message type: ${(msg as ClientMessage).type}`,
        });
      }
    }
  } catch (err) {
    log.error({ err }, 'Error handling message');
    send(ws, { type: 'error', message: 'Operation failed' });
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────

async function bootstrap() {
  // Validate auth configuration before starting
  checkAuthConfig(config, log);

  // Always create HTTP server
  httpServer = createHttpServer(app);
  attachUpgradeHandler(httpServer);

  // Optionally create HTTPS server
  if (useHttps) {
    const tls = await getTlsOptions(log);
    httpsServer = createHttpsServer({ key: tls.key, cert: tls.cert }, app);
    attachUpgradeHandler(httpsServer);
  }

  if (isDev) {
    log.info('Development mode — Vite middleware enabled');
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: path.resolve(process.cwd(), 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
    });
    app.use(vite.middlewares);
  } else {
    const clientDir = path.resolve(__dirname, '../client');
    if (existsSync(clientDir)) {
      app.use(express.static(clientDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(clientDir, 'index.html'));
      });
    } else {
      log.warn('No built client found at %s — run "npm run build" first', clientDir);
    }
  }

  // Start HTTP server
  httpServer.listen(config.port, config.host, () => {
    log.info(`HTTP  server running at http://${config.host}:${config.port}`);
  });

  // Start HTTPS server on a separate port
  if (httpsServer) {
    httpsServer.listen(httpsPort, config.host, () => {
      log.info(`HTTPS server running at https://${config.host}:${httpsPort}`);
      log.info('');
      log.info('🔒 To avoid browser security warnings for self-signed certs:');
      log.info('   Option 1: Install mkcert (https://github.com/FiloSottile/mkcert)');
      log.info('     $ mkcert -install');
      log.info(
        '     $ mkcert -key-file .certs/server.key -cert-file .certs/server.crt localhost 127.0.0.1 ::1',
      );
      log.info('   Option 2: If using Tailscale, run: tailscale cert <your-machine-name>');
      log.info('     Then set TLS_KEY and TLS_CERT in .env to the generated files');
      log.info('   Option 3: Accept the warning once in your browser (least effort)');
      log.info('');
    });
  }
}

bootstrap().catch((err) => {
  log.error(err, 'Failed to start');
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────

function shutdown() {
  log.info('Shutting down…');
  aiSupervisor.stopAll();
  channelManager.destroy();
  tmuxManager.detachAll();
  wss.close();
  let pending = 1;
  const done = () => {
    if (--pending === 0) process.exit(0);
  };
  httpServer.close(done);
  if (httpsServer) {
    pending++;
    httpsServer.close(done);
  }
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  log.error({ err }, 'Uncaught exception — shutting down');
  shutdown();
});
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unhandled promise rejection');
});

export { app, httpServer, httpsServer, wss };
