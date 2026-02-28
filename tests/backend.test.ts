import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractToken, validateToken } from '../server/modules/auth.js';
import type { ServerConfig } from '../server/types.js';

// ── Auth Module Tests ─────────────────────────────────────────────

describe('Auth Module', () => {
  const mockConfig: ServerConfig = {
    port: 3980,
    host: '127.0.0.1',
    authToken: 'test-secret-token',
    logLevel: 'info',
    claudeCmd: 'claude',
    maxTmuxSessions: 10,
  };

  describe('extractToken', () => {
    it('should not extract token from query string (removed for security)', () => {
      const req = {
        url: '/ws?token=my-token',
        headers: { host: 'localhost:3980' },
      } as import('node:http').IncomingMessage;

      expect(extractToken(req)).toBeNull();
    });

    it('should extract token from WebSocket protocol header', () => {
      const req = {
        url: '/ws',
        headers: {
          host: 'localhost:3980',
          'sec-websocket-protocol': 'token.my-token',
        },
      } as unknown as import('node:http').IncomingMessage;

      expect(extractToken(req)).toBe('my-token');
    });

    it('should return null when no token is present', () => {
      const req = {
        url: '/ws',
        headers: { host: 'localhost:3980' },
      } as import('node:http').IncomingMessage;

      expect(extractToken(req)).toBeNull();
    });

    it('should only use WebSocket protocol header, ignoring query string', () => {
      const req = {
        url: '/ws?token=query-token',
        headers: {
          host: 'localhost:3980',
          'sec-websocket-protocol': 'token.header-token',
        },
      } as unknown as import('node:http').IncomingMessage;

      expect(extractToken(req)).toBe('header-token');
    });
  });

  describe('validateToken', () => {
    it('should validate correct token', () => {
      expect(validateToken('test-secret-token', mockConfig)).toBe(true);
    });

    it('should reject incorrect token', () => {
      expect(validateToken('wrong-token', mockConfig)).toBe(false);
    });

    it('should reject null token', () => {
      expect(validateToken(null, mockConfig)).toBe(false);
    });

    it('should reject all tokens when auth is not configured', () => {
      const noAuthConfig = { ...mockConfig, authToken: '' };
      expect(validateToken(null, noAuthConfig)).toBe(false);
      expect(validateToken('anything', noAuthConfig)).toBe(false);
    });

    it('should reject all tokens when default placeholder is used', () => {
      const placeholderConfig = { ...mockConfig, authToken: 'your-secret-token-here' };
      expect(validateToken(null, placeholderConfig)).toBe(false);
    });
  });
});
