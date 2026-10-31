import { WebSocket, WebSocketServer } from 'ws';
import { getStore } from './db/store';

const clients = new Set<WebSocket>();

export function attachWs(wss: WebSocketServer, hello: () => Promise<unknown>) {
  wss.on('connection', async (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    try {
      ws.send(JSON.stringify({ type: 'hello', payload: await hello(), ts: Date.now() }));
    } catch {
      /* ignore */
    }
  });
}

/** Write to the append-only event log and push to every connected dashboard. */
export function emit(type: string, payload: unknown) {
  getStore()
    .appendEvent(type, payload)
    .catch(() => undefined);
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}
