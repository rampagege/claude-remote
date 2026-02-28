import { store, type ConnectionStatus } from './store';

const dotEl = () => document.getElementById('ws-dot') as HTMLElement;
const labelEl = () => document.getElementById('ws-label') as HTMLElement;

const STATUS_MAP: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: { color: 'bg-accent animate-none', label: 'Connected' },
  connecting: { color: 'bg-yellow-400 animate-pulse-dot', label: 'Connecting' },
  disconnected: { color: 'bg-zinc-400', label: 'Offline' },
};

export function initStatus(): void {
  store.subscribe((state, key) => {
    if (key === 'status') updateStatus(state.status);
  });
  updateStatus(store.get('status'));
}

function updateStatus(status: ConnectionStatus) {
  const dot = dotEl();
  const label = labelEl();
  const cfg = STATUS_MAP[status];

  dot.className = `w-2 h-2 rounded-full ${cfg.color}`;
  label.textContent = cfg.label;
}
