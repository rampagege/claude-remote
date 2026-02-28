# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately via [GitHub's vulnerability reporting feature](https://github.com/rampagege/tmuxfly/security/advisories/new). **Do not open a public issue.**

You should receive a response within 48 hours. If the vulnerability is confirmed, a fix will be released as soon as possible.

## Security Model

- **Auth token = root access.** Once authenticated, the user has full shell access via tmux. Treat `AUTH_TOKEN` like an SSH key.
- Server binds to `127.0.0.1` by default (local only).
- Session names are validated against injection (alphanumeric, `-`, `_` only).
- No system commands are exposed in error messages.
- Origin header is validated when present; missing Origin is allowed for non-browser clients (e.g., curl).

## Recommendations

1. Use a strong, random token: `openssl rand -base64 24`
2. If binding to `0.0.0.0`, enable HTTPS (`HTTPS=true` or provide `TLS_CERT`/`TLS_KEY`).
3. Prefer Tailscale/WireGuard or a tunnel (cloudflared, ngrok) over direct public exposure.
