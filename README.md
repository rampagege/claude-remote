# claude-remote

> **Remote Claude Code Controller** — Manage multiple Claude Code sessions from your phone, browser, or Telegram

Run multiple Claude Code instances on your dev server, remotely control them all from any device. claude-remote uses tmux to keep sessions alive and provides a **Web UI** and **Telegram Bot** for real-time monitoring, interaction, and AI-powered auto-response.

## Why

You run 3 Claude Code tasks in parallel on your server, then walk away. You want to check progress, approve prompts, or give new instructions — from your phone on the couch, your tablet in bed, or via Telegram on the go.

**claude-remote makes this possible.** Each Claude Code instance runs in a tmux session on the server. claude-remote gives you two ways to control them remotely:

- **Web UI** — Real-time terminal streaming in your browser, attach/detach sessions, full keyboard interaction
- **Telegram Bot** — List sessions, view terminal content, send commands, approve/reject AI suggestions — all from a Telegram chat

**AI Supervisor** watches your Claude Code sessions and detects when input is needed. It can auto-respond, ask for your confirmation, or just log what it sees — so your Claude Code tasks keep moving even when you're away from the keyboard.

**Designed for private networks:** Run on your Tailscale / WireGuard VPN. Access via your Tailscale IP from any device — no SSH client needed, no public exposure.

## How It Works

```
  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
  │   Phone   │  │  Tablet   │  │  Desktop  │  │ Telegram  │
  │ (browser) │  │ (browser) │  │ (browser) │  │    Bot    │
  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
        │              │              │               │
        └───── Tailscale / LAN ───────┘               │
                       │                              │
                ┌──────┴──────┐          Telegram Bot API
                │   claude-remote  │ <──────────────────────┘
                │  (Node.js) │
                └──────┬──────┘
                       │
            ┌──────────┴──────────┐
            │                     │
       tmux sessions        AI Supervisor
            │                     │
   ┌────────┼────────┐    ┌──────┴───────┐
   │        │        │    │   LLM API    │
 tmux    tmux     tmux    │ (OpenRouter/ │
 claude  codex    shell   │ OpenAI/      │
   │                      │ MiniMax)     │
   │                      └──────────────┘
   │                           │
   └──── auto-respond/confirm ─┘
```

1. AI agents run inside **tmux sessions** on your server
2. claude-remote connects to tmux via WebSocket and streams the terminal to your browser
3. **Attach from any device** — phone on the couch, tablet in bed, desktop at your desk
4. **Detach and reattach freely** — the tmux session keeps running, pick up exactly where you left off
5. **AI Supervisor** monitors sessions via LLM, detects input prompts, and auto-responds or asks for your confirmation via Web UI or Telegram

## Features

- **Multi-device access** — Same tmux sessions accessible from phone, tablet, desktop, or any browser
- **tmux session management** — List, create, attach, detach, rename, kill sessions from a touch-friendly UI
- **Window & pane control** — Switch windows, split panes, zoom, kill — all from touch or keyboard
- **Real-time terminal** — Full xterm.js emulation over WebSocket, no polling
- **Scrollback capture** — Copy full terminal content with one tap
- **AI Supervisor** — Monitor Claude Code sessions via LLM, detect when input is needed, auto-respond or confirm from your phone
- **Telegram Bot** — Control sessions and AI supervisor remotely via Telegram commands
- **Claude Usage Dashboard** — Track token usage (today / this week), quotas, and account info
- **PWA / Mobile-first** — Install to home screen; portrait mode recommended on phone & tablet; extra key bar for Tab, Ctrl, Esc, arrows
- **Dark / Light mode** — Follows system preference
- **Token auth + auto-reconnect** — Secure access with resilient reconnection

### AI Supervisor

The AI Supervisor monitors tmux sessions (especially Claude Code) via OpenRouter LLM and detects when user input is needed. Three modes:

| Mode | Behavior |
|------|----------|
| **auto** | Detects input prompts and sends responses automatically |
| **confirm** | Sends suggestion to you for approval before acting |
| **watch** | Logs observations only, never sends input |

When starting the supervisor, the goal text is sent directly to the terminal as the first instruction if the terminal is idle.

#### LLM Providers

The supervisor supports multiple LLM providers via `SUPERVISOR_PROVIDER`:

| Provider | Env Var | Default Model | Base URL |
|----------|---------|---------------|----------|
| `openrouter` (default) | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini` | `openrouter.ai/api/v1` |
| `openai` | `OPENAI_API_KEY` | `gpt-4o-mini` | `api.openai.com/v1` |
| `minimax` | `MINIMAX_API_KEY` | `MiniMax-Text-01` | `api.minimax.chat/v1` |

All providers use the OpenAI-compatible chat completions API. You can override model and base URL with `SUPERVISOR_MODEL` and `SUPERVISOR_BASE_URL`.

### Telegram Bot

When `SUPERVISOR_CHANNEL=telegram` is configured, all supervisor notifications go to Telegram instead of the web UI. The bot supports:

| Command | Description |
|---------|-------------|
| `/list` | List tmux sessions |
| `/status` | Show supervised sessions |
| `/usage` | Claude token usage |
| `/watch session goal` | Start supervisor (confirm mode) |
| `/auto session goal` | Start supervisor (auto mode) |
| `/stop [session]` | Stop supervisor |
| `/capture [session]` | Show terminal content |
| `/send session text` | Send text to session |

Text messages (without `/`) are sent directly to the active supervised session's terminal.

## Tech Stack

| Layer    | Technology                                         |
| -------- | -------------------------------------------------- |
| Backend  | Node.js, Express, ws, node-pty, pino               |
| Frontend | TypeScript, Tailwind CSS, xterm.js, Vite           |
| AI       | OpenRouter / OpenAI / MiniMax (configurable), Telegram Bot API |
| PWA      | vite-plugin-pwa, Workbox                           |
| Testing  | Vitest                                             |
| CI/CD    | GitHub Actions                                     |

## Quick Start

### Prerequisites

- **Node.js** >= 18 (see `.nvmrc`)
- **npm** >= 8
- **macOS or Linux** (node-pty requires a Unix PTY layer)
- **tmux** — `brew install tmux` on macOS

### Install

```bash
git clone https://github.com/rampagege/claude-remote.git
cd claude-remote
npm install
```

### Configure

```bash
cp .env.example .env
```

Generate a strong token:

```bash
openssl rand -base64 24
```

Edit `.env`:

```env
PORT=3980
HOST=127.0.0.1
AUTH_TOKEN=<paste-token-here>
LOG_LEVEL=info

# AI Supervisor (optional)
# Provider: openrouter (default), openai, minimax
# SUPERVISOR_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
# OPENAI_API_KEY=sk-...
# MINIMAX_API_KEY=...
# SUPERVISOR_MODEL=openai/gpt-4o-mini
# SUPERVISOR_POLL_MS=5000

# Notification channel: web (default) or telegram
# SUPERVISOR_CHANNEL=web
# TELEGRAM_BOT_TOKEN=123456:ABC...
# TELEGRAM_CHAT_ID=123456789
```

### Development

```bash
npm run dev
```

This starts the backend server with hot reload (tsx watch). Open `http://localhost:3980` in your browser.

### Production

```bash
npm run build
npm start
```

The server runs on the configured port and serves the built frontend. Open `http://<HOST>:<PORT>`.

## Typical Workflow

1. **On your desktop** — Start a Claude Code task in tmux: `tmux new -s claude`
2. **Walk away** — The task keeps running in the background
3. **On your phone** — Open claude-remote, tap the `claude` session to attach
4. **Check progress** — See real-time output, scroll back, interact if needed
5. **On your tablet** — Open claude-remote, attach to the same session — seamless handoff

## Project Structure

```
claude-remote/
├── server/                  # Backend (TypeScript)
│   ├── index.ts             # Express + WebSocket server
│   ├── types.ts             # Shared type definitions
│   └── modules/
│       ├── auth.ts               # Token authentication
│       ├── tmuxManager.ts        # tmux session management
│       ├── usageManager.ts       # Claude usage stats
│       ├── aiSupervisor.ts       # AI supervisor (LLM-driven terminal monitor)
│       ├── supervisorChannels.ts # Notification channels (Web, Telegram)
│       ├── tls.ts                # Auto-generated self-signed TLS
│       └── validation.ts         # Zod message validation
├── client/                  # Frontend (TypeScript + Tailwind)
│   ├── index.html           # Main HTML entry
│   ├── main.ts              # App initialization
│   ├── style.css            # Tailwind + custom styles
│   └── lib/
│       ├── ws.ts            # WebSocket client
│       ├── store.ts         # Reactive state management
│       ├── router.ts        # Tab navigation
│       ├── terminal.ts      # xterm.js wrapper
│       ├── tmux.ts          # Tmux view controller
│       ├── usage.ts         # Claude usage view
│       ├── settings.ts      # Settings view controller
│       ├── extraKeys.ts     # Mobile extra key bar
│       ├── status.ts        # Connection status indicator
│       ├── ripple.ts        # Ripple animation effect
│       └── toast.ts         # Toast notifications
├── public/                  # Static assets
├── tests/                   # Vitest test suites
├── .github/workflows/       # CI configuration
├── vite.config.ts           # Vite configuration
├── tailwind.config.ts       # Tailwind configuration
├── tsconfig.json            # TypeScript config (server)
└── vitest.config.ts         # Test configuration
```

## Security

- Server binds to **`127.0.0.1`** by default (local only)
- Token-based authentication required for all WebSocket operations
- Once authenticated, the user has **full shell access** — treat `AUTH_TOKEN` like an SSH key
- Session names validated against injection (alphanumeric + `-` + `_` only)
- No system commands exposed in error messages
- Origin header validated when present; missing Origin allowed for non-browser clients
- AI Supervisor feature is disabled by default (requires `OPENROUTER_API_KEY`)
- Telegram bot validates `chat_id` on all incoming messages — only the configured chat receives notifications and can send commands

### Network Exposure

If you set `HOST=0.0.0.0`:

1. **Use HTTPS** — Set `HTTPS=true` in `.env` (auto-generates self-signed cert) or provide `TLS_CERT` / `TLS_KEY`
2. **Use a strong token** — At least 16 random characters (`openssl rand -base64 24`)
3. **Prefer a tunnel** over direct exposure:
   ```bash
   cloudflared tunnel --url http://localhost:3980
   ```

### Responsible Disclosure

If you discover a security vulnerability, please report it privately via GitHub's vulnerability reporting feature. Do not open a public issue.

## Remote Access

### Tailscale / WireGuard (Recommended)

If your devices are on a Tailscale (or WireGuard) network, this is the simplest and most secure setup:

1. Set `HOST=0.0.0.0` in `.env`
2. Access via `http://<tailscale-ip>:3980` from any device on the network
3. Add to home screen for a native-app experience

No tunnels, no port forwarding, no public exposure — Tailscale handles encryption and auth at the network layer.

### Local Network

1. Set `HOST=0.0.0.0` in `.env`
2. Access via `http://<local-ip>:3980` from your phone
3. Use the Settings tab to configure server URL and token

### Public Tunnel

If you need access from outside your network without a VPN:

```bash
# cloudflared
cloudflared tunnel --url http://localhost:3980

# ngrok
ngrok http 3980
```

## Scripts

| Command            | Description                        |
| ------------------ | ---------------------------------- |
| `npm run dev`      | Start dev server (hot reload)      |
| `npm run build`    | Build for production               |
| `npm start`        | Run production server              |
| `npm test`         | Run tests                          |
| `npm run lint`     | Lint TypeScript files              |
| `npm run format`   | Format code with Prettier          |

## Troubleshooting

| Issue                         | Solution                                                |
| ----------------------------- | ------------------------------------------------------- |
| `node-pty` install fails      | Install build tools: `xcode-select --install` (macOS)   |
| tmux commands fail            | Install tmux: `brew install tmux`                       |
| WebSocket won't connect       | Check firewall, verify HOST/PORT in `.env`              |
| PWA not installable           | Must serve over HTTPS or localhost                      |

## Keywords

Claude Code remote, Claude Code mobile, Claude Code manager, remote Claude Code, Claude Code terminal, Claude Code Telegram, AI coding agent remote, tmux web client, tmux remote, web terminal, remote terminal, Tailscale terminal, AI supervisor, Claude Code auto-approve

## License

MIT — see [LICENSE](LICENSE).
