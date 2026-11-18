import { existsSync, readFileSync, renameSync } from "node:fs";
import {
  apply, emptyState, Intent, StoredEvent, type FoundryEvent, type FoundryState, type LoggedEvent,
} from "@foundry/protocol";
import type { EventLog } from "./db";

type Listener = (ev: LoggedEvent, state: FoundryState) => void;

/** Owns the log and the projected state. Everything goes through `record`. */
export class Core {
  state: FoundryState = emptyState();
  private listeners = new Set<Listener>();

  constructor(private log: EventLog) {
    for (const ev of log.since(0)) apply(this.state, ev);
  }

  record(ev: StoredEvent): LoggedEvent {
    const logged = this.log.append(ev);
    apply(this.state, logged);
    for (const l of this.listeners) l(logged, this.state);
    return logged;
  }

  subscribe(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }

  /** Read hook events that were spooled while the core was down, in order, then move the file aside. */
  drainSpool(path: string): number {
    if (!existsSync(path)) return 0;
    const taken = `${path}.${Date.now()}.ingested`;
    renameSync(path, taken);
    let n = 0;
    for (const line of readFileSync(taken, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let json: unknown;
      try { json = JSON.parse(line); } catch { continue; } // a half-written line from a crash: skip it
      const parsed = StoredEvent.safeParse(json);
      if (parsed.success) { this.record(parsed.data); n++; }
    }
    return n;
  }

  /** Turn a renderer's intent into foundry events, or throw with a message the UI can show. */
  handle(intent: Intent): LoggedEvent[] {
    const ts = Date.now();
    const need = (id: string) => { if (!this.state.sessions[id]) throw new Error(`No session ${id}`); };
    const out: FoundryEvent[] = [];
    switch (intent.type) {
      case "assign":
        need(intent.sessionId);
        if (intent.workstreamId && !this.state.workstreams[intent.workstreamId]) throw new Error(`No workstream ${intent.workstreamId}`);
        out.push({ kind: "foundry", ts, type: "session.assigned", sessionId: intent.sessionId, workstreamId: intent.workstreamId });
        break;
      case "move":
        need(intent.sessionId);
        out.push({ kind: "foundry", ts, type: "session.moved", sessionId: intent.sessionId, x: intent.x, y: intent.y });
        break;
      case "rename":
        need(intent.sessionId);
        out.push({ kind: "foundry", ts, type: "session.renamed", sessionId: intent.sessionId, name: intent.name, mono: intent.mono });
        break;
      case "archive":
        need(intent.sessionId);
        out.push({ kind: "foundry", ts, type: "session.archived", sessionId: intent.sessionId, handoff: intent.handoff });
        break;
      case "restore":
        need(intent.sessionId);
        out.push({ kind: "foundry", ts, type: "session.restored", sessionId: intent.sessionId });
        break;
      case "createWorkstream": {
        const base = intent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ws";
        let id = base, i = 2;
        while (this.state.workstreams[id]) id = `${base}-${i++}`;
        out.push({ kind: "foundry", ts, type: "workstream.created", id, name: intent.name, color: intent.color, area: intent.area });
        break;
      }
    }
    return out.map((e) => this.record(e));
  }
}
