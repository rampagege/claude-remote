import { store } from './store';

type ServerMessage = {
  type: string;
  [key: string]: unknown;
};

type MessageHandler = (msg: ServerMessage) => void;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
const handlers = new Set<MessageHandler>();

export function onMessage(handler: MessageHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function send(msg: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export function connect(url?: string, token?: string): void {
  disconnect();

  const wsUrl = url || store.get('serverUrl');
  const wsToken = token || store.get('token');

  store.set('status', 'connecting');

  try {
    socket = new WebSocket(wsUrl);
  } catch {
    store.set('status', 'disconnected');
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    // Authenticate via message instead of URL query param
    if (wsToken) {
      socket!.send(JSON.stringify({ type: 'auth', token: wsToken }));
    }
    store.set('status', 'connected');
    reconnectDelay = 1000;
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as ServerMessage;
      handlers.forEach((fn) => fn(msg));
    } catch { /* ignore malformed */ }
  };

  socket.onclose = () => {
    store.set('status', 'disconnected');
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose will fire after this
  };
}

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  store.set('status', 'disconnected');
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
}

export function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}
