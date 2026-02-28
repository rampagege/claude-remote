import { send, onMessage } from './ws';

interface UsageQuota {
  label: string;
  percentUsed: number;
  resetText: string;
}

interface ExtraUsage {
  spent: string;
  budget: string;
  percentUsed: number;
  resetText: string;
}

interface ClaudeUsageData {
  accountTier: string;
  accountInfo: string;
  quotas: UsageQuota[];
  extraUsage: ExtraUsage | null;
  todayTokens: number;
  weekTokens: number;
  [key: string]: unknown;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a quota progress bar */
function renderQuota(q: UsageQuota): string {
  const pct = Math.max(0, Math.min(100, q.percentUsed));
  const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-accent';
  return `<div class="mb-2">
  <div class="flex justify-between items-baseline mb-0.5">
    <span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">${esc(q.label)}</span>
    <span class="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">${pct}% used</span>
  </div>
  <div class="w-full h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
    <div class="${color} h-full rounded-full transition-all" style="width:${pct}%"></div>
  </div>
  ${q.resetText ? `<p class="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5">${esc(q.resetText)}</p>` : ''}
</div>`;
}

function renderUsage(data: ClaudeUsageData): string {
  const lines: string[] = [];

  // 1. Account header + quotas (live probe)
  if (data.accountInfo || data.quotas.length > 0) {
    if (data.accountInfo) {
      lines.push(
        `<p class="font-medium text-zinc-700 dark:text-zinc-200 text-sm">${esc(data.accountInfo)}</p>`,
      );
    }

    // 2. Quotas
    if (data.quotas.length > 0) {
      lines.push('<div class="mt-3">');
      for (const q of data.quotas) {
        lines.push(renderQuota(q));
      }
      lines.push('</div>');
    }
  } else {
    // Probe failed or returned no data
    lines.push(
      `<p class="text-xs text-zinc-400 dark:text-zinc-500 italic">Live quota unavailable (claude CLI not reachable)</p>`,
    );
  }

  // 3. Extra usage
  if (data.extraUsage) {
    const eu = data.extraUsage;
    const pct = Math.max(0, Math.min(100, eu.percentUsed));
    const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-accent';
    lines.push('<div class="mt-3">');
    lines.push('<div class="flex justify-between items-baseline mb-0.5">');
    lines.push(
      `<span class="text-xs font-medium text-zinc-600 dark:text-zinc-300">Extra Usage</span>`,
    );
    lines.push(
      `<span class="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">${esc(eu.spent)} / ${esc(eu.budget)}</span>`,
    );
    lines.push('</div>');
    lines.push(
      `<div class="w-full h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden"><div class="${color} h-full rounded-full transition-all" style="width:${pct}%"></div></div>`,
    );
    if (eu.resetText) {
      lines.push(
        `<p class="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5">${esc(eu.resetText)}</p>`,
      );
    }
    lines.push('</div>');
  }

  // 4. Today / This Week tokens
  if (data.todayTokens > 0 || data.weekTokens > 0) {
    lines.push('<div class="mt-3 flex gap-4">');
    lines.push(
      `<div><p class="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">Today</p><p class="text-lg font-semibold text-zinc-700 dark:text-zinc-200 tabular-nums">${formatTokens(data.todayTokens)}</p><p class="text-[10px] text-zinc-400 dark:text-zinc-500">tokens</p></div>`,
    );
    lines.push(
      `<div><p class="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">This Week</p><p class="text-lg font-semibold text-zinc-700 dark:text-zinc-200 tabular-nums">${formatTokens(data.weekTokens)}</p><p class="text-[10px] text-zinc-400 dark:text-zinc-500">tokens</p></div>`,
    );
    lines.push('</div>');
  }

  return lines.join('\n');
}

const CACHE_KEY = 'tmuxfly:usage-cache';

interface UsageCache {
  data: ClaudeUsageData;
  timestamp: number;
}

function loadCache(): UsageCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as UsageCache;
  } catch {
    return null;
  }
}

function saveCache(data: ClaudeUsageData): void {
  const cache: UsageCache = { data, timestamp: Date.now() };
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function formatTimeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function renderWithTimestamp(data: ClaudeUsageData, ts: number | null): string {
  const body = renderUsage(data);
  if (ts) {
    return `<p class="text-[10px] text-zinc-400 dark:text-zinc-500 mb-2">Updated ${formatTimeAgo(ts)}</p>${body}`;
  }
  return body;
}

export function initUsage(): void {
  const btn = document.getElementById('btn-refresh-usage');
  const content = document.getElementById('usage-content');
  if (!btn || !content) return;

  // Show cached data immediately
  const cached = loadCache();
  if (cached) {
    content.innerHTML = renderWithTimestamp(cached.data, cached.timestamp);
  }

  let loading = false;

  btn.addEventListener('click', () => {
    if (loading) return;
    loading = true;
    // Show loading indicator but keep cached content visible
    if (cached) {
      const indicator = content.querySelector('.usage-loading');
      if (!indicator) {
        content.insertAdjacentHTML(
          'afterbegin',
          '<p class="usage-loading text-[10px] text-accent mb-2">Refreshing...</p>',
        );
      }
    } else {
      content.innerHTML = '<span class="text-zinc-400 dark:text-zinc-500">Loading...</span>';
    }
    send({ type: 'getUsage', provider: 'claude' });
  });

  onMessage((msg) => {
    if (msg.type === 'usageResult' && msg.provider === 'claude') {
      loading = false;
      const data = msg.data as ClaudeUsageData;
      saveCache(data);
      content.innerHTML = renderWithTimestamp(data, Date.now());
    }
    if (msg.type === 'error' && loading) {
      loading = false;
      // Keep cached content, just remove loading indicator
      const indicator = content.querySelector('.usage-loading');
      if (indicator) {
        indicator.textContent = 'Refresh failed';
        indicator.classList.remove('text-accent');
        indicator.classList.add('text-red-500');
      } else {
        content.innerHTML = '<span class="text-red-500">Failed to load usage data</span>';
      }
    }
  });
}
