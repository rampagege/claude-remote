import { describe, it, expect } from 'vitest';
import type {
  ClientMessage,
  ServerMessage,
  InputMessage,
  TmuxListMessage,
  TmuxNewMessage,
  TmuxScrollMessage,
  TmuxCommandMessage,
  TmuxCaptureMessage,
  TmuxListWindowsMessage,
  TmuxSelectWindowMessage,
  GetUsageMessage,
  AuthMessage,
} from '../server/types.js';
import { clientMessageSchema } from '../server/modules/validation.js';

// ── Protocol Validation Tests ─────────────────────────────────────

describe('WebSocket Protocol', () => {
  describe('Client Messages', () => {
    it('should validate input message format', () => {
      const msg: InputMessage = { type: 'input', data: 'hello\n' };
      expect(msg.type).toBe('input');
      expect(msg.data).toBe('hello\n');
    });

    it('should validate tmuxList message', () => {
      const msg: TmuxListMessage = { type: 'tmuxList' };
      expect(msg.type).toBe('tmuxList');
    });

    it('should validate tmuxNew message', () => {
      const msg: TmuxNewMessage = { type: 'tmuxNew', name: 'my-session' };
      expect(msg.type).toBe('tmuxNew');
      expect(msg.name).toBe('my-session');
    });

    it('should validate auth message', () => {
      const msg: AuthMessage = { type: 'auth', token: 'secret' };
      expect(msg.type).toBe('auth');
      expect(msg.token).toBe('secret');
    });

    it('should validate resize message', () => {
      const msg: ClientMessage = { type: 'resize', cols: 120, rows: 40 };
      expect(msg.type).toBe('resize');
    });

    it('should validate tmux rename message', () => {
      const msg: ClientMessage = { type: 'tmuxRename', from: 'old', to: 'new' };
      expect(msg.type).toBe('tmuxRename');
    });

    it('should validate tmuxScroll message', () => {
      const msg: TmuxScrollMessage = { type: 'tmuxScroll', name: 'main', direction: 'up' };
      expect(msg.type).toBe('tmuxScroll');
      expect(msg.direction).toBe('up');
    });

    it('should validate tmuxCommand message', () => {
      const msg: TmuxCommandMessage = { type: 'tmuxCommand', name: 'main', command: 'splitH' };
      expect(msg.type).toBe('tmuxCommand');
      expect(msg.command).toBe('splitH');
    });

    it('should validate tmuxCapture message', () => {
      const msg: TmuxCaptureMessage = { type: 'tmuxCapture', name: 'main' };
      expect(msg.type).toBe('tmuxCapture');
    });

    it('should validate tmuxListWindows message', () => {
      const msg: TmuxListWindowsMessage = { type: 'tmuxListWindows', name: 'main' };
      expect(msg.type).toBe('tmuxListWindows');
    });

    it('should validate tmuxSelectWindow message', () => {
      const msg: TmuxSelectWindowMessage = { type: 'tmuxSelectWindow', name: 'main', index: 0 };
      expect(msg.type).toBe('tmuxSelectWindow');
      expect(msg.index).toBe(0);
    });

    it('should validate getUsage message', () => {
      const msg: GetUsageMessage = { type: 'getUsage', provider: 'claude' };
      expect(msg.type).toBe('getUsage');
      expect(msg.provider).toBe('claude');
    });
  });

  describe('Server Messages', () => {
    it('should validate ready message', () => {
      const msg: ServerMessage = { type: 'ready', sessionId: 'uuid-here' };
      expect(msg.type).toBe('ready');
    });

    it('should validate output message', () => {
      const msg: ServerMessage = {
        type: 'output',
        sessionId: 'uuid',
        data: 'Hello World\n',
      };
      expect(msg.type).toBe('output');
    });

    it('should validate tmuxSessionList message', () => {
      const msg: ServerMessage = {
        type: 'tmuxSessionList',
        sessions: [
          {
            name: 'main',
            windows: 2,
            created: '2024-01-01T00:00:00Z',
            attached: true,
            preview: '',
          },
        ],
      };
      expect(msg.type).toBe('tmuxSessionList');
    });

    it('should validate error message', () => {
      const msg: ServerMessage = { type: 'error', message: 'Something went wrong' };
      expect(msg.type).toBe('error');
    });

    it('should validate exit message', () => {
      const msg: ServerMessage = { type: 'exit', sessionId: 'uuid' };
      expect(msg.type).toBe('exit');
    });

    it('should validate authResult message', () => {
      const msg: ServerMessage = { type: 'authResult', success: true };
      expect(msg.type).toBe('authResult');
    });

    it('should validate tmuxCaptureResult message', () => {
      const msg: ServerMessage = { type: 'tmuxCaptureResult', text: 'terminal content' };
      expect(msg.type).toBe('tmuxCaptureResult');
    });

    it('should validate tmuxWindowList message', () => {
      const msg: ServerMessage = {
        type: 'tmuxWindowList',
        windows: [
          { index: 0, name: 'bash', active: true, panes: 1 },
          { index: 1, name: 'vim', active: false, panes: 2 },
        ],
      };
      expect(msg.type).toBe('tmuxWindowList');
    });

    it('should validate usageResult message', () => {
      const msg: ServerMessage = {
        type: 'usageResult',
        provider: 'claude',
        data: {
          accountTier: 'Pro',
          accountInfo: 'Opus 4.5 · Claude Pro · user@example.com',
          quotas: [{ label: 'Current session', percentUsed: 5, resetText: 'Resets 3:00pm' }],
          extraUsage: null,
          totalSessions: 10,
          totalMessages: 500,
          firstSessionDate: '2025-01-01',
          lastComputedDate: '2025-02-01',
          modelUsage: {
            'claude-sonnet-4-20250514': {
              inputTokens: 100000,
              outputTokens: 50000,
              cacheReadInputTokens: 20000,
              cacheCreationInputTokens: 5000,
            },
          },
          recentDays: [
            { date: '2025-02-01', messageCount: 50, sessionCount: 3, toolCallCount: 120 },
          ],
          todayTokens: 5000,
          weekTokens: 35000,
          recentDailyTokens: [
            { date: '2025-02-01', tokensByModel: { 'claude-sonnet-4-20250514': 5000 } },
          ],
        },
      };
      expect(msg.type).toBe('usageResult');
    });
  });

  describe('Zod Validation (clientMessageSchema)', () => {
    it('should accept valid input message', () => {
      const result = clientMessageSchema.safeParse({ type: 'input', data: 'hello' });
      expect(result.success).toBe(true);
    });

    it('should accept valid auth message', () => {
      const result = clientMessageSchema.safeParse({ type: 'auth', token: 'secret' });
      expect(result.success).toBe(true);
    });

    it('should accept valid resize message', () => {
      const result = clientMessageSchema.safeParse({ type: 'resize', cols: 80, rows: 24 });
      expect(result.success).toBe(true);
    });

    it('should accept valid tmuxNew message', () => {
      const result = clientMessageSchema.safeParse({ type: 'tmuxNew', name: 'my-session' });
      expect(result.success).toBe(true);
    });

    it('should accept valid tmuxRename message', () => {
      const result = clientMessageSchema.safeParse({ type: 'tmuxRename', from: 'old', to: 'new' });
      expect(result.success).toBe(true);
    });

    it('should accept valid tmuxScroll message', () => {
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxScroll', name: 'main', direction: 'up' })
          .success,
      ).toBe(true);
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxScroll', name: 'main', direction: 'down' })
          .success,
      ).toBe(true);
    });

    it('should reject tmuxScroll with invalid direction', () => {
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxScroll', name: 'main', direction: 'left' })
          .success,
      ).toBe(false);
    });

    it('should reject tmuxScroll with invalid session name', () => {
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxScroll', name: '', direction: 'up' }).success,
      ).toBe(false);
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxScroll', name: 'a;b', direction: 'up' }).success,
      ).toBe(false);
    });

    it('should reject tmuxScroll with missing fields', () => {
      expect(clientMessageSchema.safeParse({ type: 'tmuxScroll', name: 'main' }).success).toBe(
        false,
      );
      expect(clientMessageSchema.safeParse({ type: 'tmuxScroll', direction: 'up' }).success).toBe(
        false,
      );
    });

    it('should reject unknown message type', () => {
      const result = clientMessageSchema.safeParse({ type: 'unknown', foo: 'bar' });
      expect(result.success).toBe(false);
    });

    it('should reject null input', () => {
      const result = clientMessageSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('should reject missing required fields', () => {
      const result = clientMessageSchema.safeParse({ type: 'input' }); // missing 'data'
      expect(result.success).toBe(false);
    });

    it('should reject wrong field types', () => {
      const result = clientMessageSchema.safeParse({ type: 'resize', cols: 'abc', rows: 24 });
      expect(result.success).toBe(false);
    });

    it('should reject tmuxNew with empty name', () => {
      const result = clientMessageSchema.safeParse({ type: 'tmuxNew', name: '' });
      expect(result.success).toBe(false);
    });

    it('should reject tmuxNew with oversized name', () => {
      const result = clientMessageSchema.safeParse({ type: 'tmuxNew', name: 'a'.repeat(65) });
      expect(result.success).toBe(false);
    });

    it('should accept parameterless messages', () => {
      expect(clientMessageSchema.safeParse({ type: 'tmuxList' }).success).toBe(true);
      expect(clientMessageSchema.safeParse({ type: 'tmuxDetach' }).success).toBe(true);
    });

    // ── tmuxCommand ──

    it('should accept valid tmuxCommand messages', () => {
      const commands = [
        'splitH',
        'splitV',
        'newWindow',
        'nextWindow',
        'prevWindow',
        'nextPane',
        'zoomPane',
        'killPane',
      ];
      for (const command of commands) {
        expect(
          clientMessageSchema.safeParse({ type: 'tmuxCommand', name: 'main', command }).success,
        ).toBe(true);
      }
    });

    it('should reject tmuxCommand with invalid command', () => {
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxCommand', name: 'main', command: 'invalid' })
          .success,
      ).toBe(false);
    });

    it('should reject tmuxCommand with invalid session name', () => {
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxCommand', name: '', command: 'splitH' }).success,
      ).toBe(false);
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxCommand', name: 'a;b', command: 'splitH' })
          .success,
      ).toBe(false);
    });

    // ── tmuxCapture ──

    it('should accept valid tmuxCapture message', () => {
      expect(clientMessageSchema.safeParse({ type: 'tmuxCapture', name: 'main' }).success).toBe(
        true,
      );
    });

    it('should reject tmuxCapture with invalid session name', () => {
      expect(clientMessageSchema.safeParse({ type: 'tmuxCapture', name: '' }).success).toBe(false);
      expect(clientMessageSchema.safeParse({ type: 'tmuxCapture', name: 'a b' }).success).toBe(
        false,
      );
    });

    // ── tmuxListWindows ──

    it('should accept valid tmuxListWindows message', () => {
      expect(clientMessageSchema.safeParse({ type: 'tmuxListWindows', name: 'main' }).success).toBe(
        true,
      );
    });

    it('should reject tmuxListWindows with invalid session name', () => {
      expect(clientMessageSchema.safeParse({ type: 'tmuxListWindows', name: '' }).success).toBe(
        false,
      );
    });

    // ── tmuxSelectWindow ──

    it('should accept valid tmuxSelectWindow message', () => {
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxSelectWindow', name: 'main', index: 0 }).success,
      ).toBe(true);
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxSelectWindow', name: 'main', index: 5 }).success,
      ).toBe(true);
    });

    it('should reject tmuxSelectWindow with negative index', () => {
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxSelectWindow', name: 'main', index: -1 })
          .success,
      ).toBe(false);
    });

    it('should reject tmuxSelectWindow with missing index', () => {
      expect(
        clientMessageSchema.safeParse({ type: 'tmuxSelectWindow', name: 'main' }).success,
      ).toBe(false);
    });

    // ── getUsage ──

    it('should accept valid getUsage message', () => {
      expect(clientMessageSchema.safeParse({ type: 'getUsage', provider: 'claude' }).success).toBe(
        true,
      );
    });

    it('should reject getUsage with invalid provider', () => {
      expect(clientMessageSchema.safeParse({ type: 'getUsage', provider: 'unknown' }).success).toBe(
        false,
      );
    });

    it('should reject getUsage with missing provider', () => {
      expect(clientMessageSchema.safeParse({ type: 'getUsage' }).success).toBe(false);
    });
  });

  describe('Message Serialization', () => {
    it('should serialize and deserialize client messages', () => {
      const original: ClientMessage = { type: 'input', data: 'test\n' };
      const serialized = JSON.stringify(original);
      const deserialized = JSON.parse(serialized) as ClientMessage;
      expect(deserialized).toEqual(original);
    });

    it('should serialize and deserialize server messages', () => {
      const original: ServerMessage = {
        type: 'output',
        sessionId: 'test-id',
        data: 'Hello\x1b[32mWorld\x1b[0m',
      };
      const serialized = JSON.stringify(original);
      const deserialized = JSON.parse(serialized) as ServerMessage;
      expect(deserialized).toEqual(original);
    });

    it('should handle special characters in data', () => {
      const msg: InputMessage = { type: 'input', data: '\r\n\t\x1b[A' };
      const roundTrip = JSON.parse(JSON.stringify(msg)) as InputMessage;
      expect(roundTrip.data).toBe(msg.data);
    });
  });
});
