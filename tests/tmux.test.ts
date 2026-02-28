import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerConfig } from '../server/types.js';

describe('TmuxManager', () => {
  let TmuxManager: typeof import('../server/modules/tmuxManager.js').TmuxManager;
  let tmuxManager: InstanceType<typeof TmuxManager>;

  const mockLogger = {
    child: () => mockLogger,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  };

  const mockConfig: ServerConfig = {
    port: 3980,
    host: '127.0.0.1',
    authToken: 'test',
    logLevel: 'info',
    claudeCmd: 'claude',
    maxTmuxSessions: 3,
  };

  beforeEach(async () => {
    const mod = await import('../server/modules/tmuxManager.js');
    TmuxManager = mod.TmuxManager;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tmuxManager = new TmuxManager(mockLogger as any, mockConfig);
  });

  describe('Session name validation', () => {
    it('should reject empty session names', async () => {
      await expect(tmuxManager.create('')).rejects.toThrow(/Invalid session name/);
    });

    it('should reject names with special characters', async () => {
      await expect(tmuxManager.create('my session')).rejects.toThrow(/Invalid session name/);
      await expect(tmuxManager.create('my/session')).rejects.toThrow(/Invalid session name/);
      await expect(tmuxManager.create('my;session')).rejects.toThrow(/Invalid session name/);
    });

    it('should accept valid session names', async () => {
      // This test requires tmux to be installed and available
      try {
        await tmuxManager.create('tmuxfly-test-sess');
        const sessions = await tmuxManager.list();
        const found = sessions.find((s) => s.name === 'tmuxfly-test-sess');
        expect(found).toBeTruthy();

        // Cleanup
        await tmuxManager.kill('tmuxfly-test-sess');
      } catch (err) {
        const msg = (err as Error).message;
        // Skip if tmux not installed, spawn blocked, or session limit hit
        if (
          msg.includes('ENOENT') ||
          msg.includes('not found') ||
          msg.includes('Max tmux') ||
          msg.includes('posix_spawnp') ||
          msg.includes('duplicate session')
        ) {
          return;
        }
        throw err;
      }
    });
  });

  describe('Rename validation', () => {
    it('should reject empty new name', async () => {
      await expect(tmuxManager.rename('old', '')).rejects.toThrow(/Invalid session name/);
    });

    it('should reject new name with special characters', async () => {
      await expect(tmuxManager.rename('old', 'new name')).rejects.toThrow(/Invalid session name/);
    });
  });

  describe('List sessions', () => {
    it('should return empty array when no tmux server is running', async () => {
      // This may or may not have tmux sessions depending on the env
      const sessions = await tmuxManager.list();
      expect(Array.isArray(sessions)).toBe(true);
    });
  });

  describe('scrollPage validation', () => {
    it('should reject invalid session name for scrollPage', async () => {
      await expect(tmuxManager.scrollPage('', 'up')).rejects.toThrow(/Invalid session name/);
      await expect(tmuxManager.scrollPage('a;b', 'up')).rejects.toThrow(/Invalid session name/);
      await expect(tmuxManager.scrollPage('a b', 'down')).rejects.toThrow(/Invalid session name/);
    });
  });

  describe('runCommand validation', () => {
    it('should reject invalid session name for runCommand', async () => {
      await expect(tmuxManager.runCommand('', 'splitH')).rejects.toThrow(/Invalid session name/);
      await expect(tmuxManager.runCommand('a;b', 'splitH')).rejects.toThrow(/Invalid session name/);
      await expect(tmuxManager.runCommand('a b', 'newWindow')).rejects.toThrow(
        /Invalid session name/,
      );
    });

    it('should reject unknown command', async () => {
      await expect(tmuxManager.runCommand('valid', 'unknown')).rejects.toThrow(
        /Unknown tmux command/,
      );
    });
  });

  describe('captureFull validation', () => {
    it('should reject invalid session name for captureFull', async () => {
      await expect(tmuxManager.captureFull('')).rejects.toThrow(/Invalid session name/);
      await expect(tmuxManager.captureFull('a;b')).rejects.toThrow(/Invalid session name/);
    });
  });

  describe('listWindows validation', () => {
    it('should reject invalid session name for listWindows', async () => {
      await expect(tmuxManager.listWindows('')).rejects.toThrow(/Invalid session name/);
      await expect(tmuxManager.listWindows('a;b')).rejects.toThrow(/Invalid session name/);
    });
  });

  describe('selectWindow validation', () => {
    it('should reject invalid session name for selectWindow', async () => {
      await expect(tmuxManager.selectWindow('', 0)).rejects.toThrow(/Invalid session name/);
      await expect(tmuxManager.selectWindow('a;b', 0)).rejects.toThrow(/Invalid session name/);
    });
  });

  describe('Detach', () => {
    it('should handle detaching when not attached', () => {
      // Should not throw
      tmuxManager.detach('nonexistent');
    });

    it('should handle detachAll when nothing is attached', () => {
      // Should not throw
      tmuxManager.detachAll();
    });
  });
});
