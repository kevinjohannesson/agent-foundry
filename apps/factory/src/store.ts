import type { FoundryState, Intent, LoggedEvent, ServerMessage } from "@foundry/protocol";

/**
 * The factory's link to the core: the live state over the WebSocket, intents over HTTP (so each one gets its own
 * answer). The state is never changed here; it is replaced by whatever the core sends next.
 */
export type Conn = "connecting" | "live" | "down";

export class Store {
  state: FoundryState | null = null;
  conn: Conn = "connecting";
  /** Bumped on every change, for useSyncExternalStore. */
  version = 0;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retry = 500;
  private closed = false;

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;

  private emit() { this.version++; for (const l of this.listeners) l(); }

  connect() {
    this.closed = false;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 500; this.conn = "live"; this.emit(); };
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as ServerMessage;
      if (msg.type === "snapshot" || msg.type === "event") { this.state = msg.state; this.emit(); }
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.conn = "down";
      this.emit();
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 10_000);
    };
  }

  close() { this.closed = true; this.ws?.close(); }

  /** Sends an intent; resolves with the events it recorded, or an error message the UI can show. */
  async send(intent: Intent): Promise<{ events: LoggedEvent[]; error?: undefined } | { error: string; events?: undefined }> {
    try {
      const r = await fetch("/intents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intent) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.ok) return { error: body.error ?? `The core answered ${r.status}` };
      return { events: body.events ?? [] };
    } catch {
      return { error: "Can't reach the core. Is it running?" };
    }
  }
}
