import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from '../types.js';
import type { Logger } from 'pino';

/**
 * Extract token from WebSocket protocol header.
 * URL query string extraction has been removed to avoid leaking tokens in logs.
 * The primary auth path is now message-based (client sends { type: 'auth', token }).
 */
export function extractToken(req: IncomingMessage): string | null {
  const protocol = req.headers['sec-websocket-protocol'];
  if (typeof protocol === 'string') {
    const parts = protocol.split(',').map((s) => s.trim());
    const tokenPart = parts.find((p) => p.startsWith('token.'));
    if (tokenPart) return tokenPart.slice(6);
  }

  return null;
}

/**
 * Validate a token against the configured auth token.
 * Rejects when authToken is empty or still set to the placeholder value.
 */
export function validateToken(token: string | null, config: ServerConfig): boolean {
  if (!config.authToken || config.authToken === 'your-secret-token-here') {
    return false; // Reject — auth token is not configured
  }
  if (!token || token.length !== config.authToken.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(config.authToken));
}

/**
 * Check that AUTH_TOKEN is properly configured. If not, log a FATAL error and exit.
 */
export function checkAuthConfig(config: ServerConfig, log: Logger): void {
  if (!config.authToken || config.authToken === 'your-secret-token-here') {
    log.fatal(
      'AUTH_TOKEN is not set or is still the placeholder value. ' +
      'Please set a strong AUTH_TOKEN in your .env file before starting the server.',
    );
    process.exit(1);
  }
  if (config.authToken.length < 16) {
    log.warn('AUTH_TOKEN is shorter than 16 characters — consider using a stronger token');
  }
}
