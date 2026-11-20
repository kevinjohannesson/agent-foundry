import { existsSync, readFileSync, renameSync } from "node:fs";
import {
  apply, emptyState, Intent, StoredEvent, transcriptTurnApplies,
  type FoundryEvent, type FoundryState, type LoggedEvent,
} from "@foundry/protocol";
import type { EventLog } from "./db";
import type { AgentObservation, SessionObservation } from "./tailer";

/** Transcript fields that only get recorded when the transcript changes them (hooks may word them differently). */
const TEXT_FIELDS = ["transcriptPath", "entrypoint", "title", "cwd", "lastPrompt"] as const;
type TextFields = Partial<Pick<SessionObservation, (typeof TEXT_FIELDS)[number]>>;
/** A transcript-only session's activity is recorded at most this often, unless something else changed. */
const ACTIVITY_STEP_MS = 60_000;
/** How many recent hook events to remember, so a spooled copy of one that also arrived over HTTP isn't recorded twice. */
const RECENT_HOOKS = 5000;

type Listener = (ev: LoggedEvent, state: FoundryState) => void;

/** Owns the log and the projected state. Everything goes through `record`. */
export class Core {
  state: FoundryState = emptyState();
  private listeners = new Set<Listener>();
  /** What each session's transcript said when last recorded; rebuilt from the log on start. */
  private transcriptSaid = new Map<string, TextFields>();
  private agentSaid = new Map<string, boolean>();
  private recentHooks = new Set<string>();

  constructor(private log: EventLog) {
    for (const ev of log.since(0)) { apply(this.state, ev); this.remember(ev); }
  }

  private remember(ev: StoredEvent) {
    // What the transcripts said last, rebuilt from the log, so a restart doesn't record it again.
    if (ev.kind === "foundry" && ev.type === "transcript.observed") {
      const said = { ...this.transcriptSaid.get(ev.sessionId) };
      for (const k of TEXT_FIELDS) if (ev[k] !== undefined) said[k] = ev[k];
      this.transcriptSaid.set(ev.sessionId, said);
    }
    if (ev.kind === "foundry" && ev.type === "transcript.agent") this.agentSaid.set(ev.agentId, ev.running);
    if (ev.kind !== "hook") return;
    this.recentHooks.add(JSON.stringify([ev.ts, ev.payload]));
    if (this.recentHooks.size > RECENT_HOOKS) this.recentHooks.delete(this.recentHooks.values().next().value!);
  }

  record(ev: StoredEvent): LoggedEvent {
    this.remember(ev);
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
      if (!parsed.success) continue;
      // The forwarder spools when a request times out, which can happen after the core already recorded it.
      if (parsed.data.kind === "hook" && this.recentHooks.has(JSON.stringify([parsed.data.ts, parsed.data.payload]))) continue;
      this.record(parsed.data); n++;
    }
    return n;
  }

  /**
   * Records what the tailer read from a session transcript, if it adds anything:
   * a new session, a changed title/app/folder/prompt/path, a turn the hooks haven't reported, or a transcript-only
   * session's activity moving on. Returns the recorded event, or null.
   */
  observeSession(o: SessionObservation): LoggedEvent | null {
    const s = this.state.sessions[o.sessionId];
    const known = s?.hasTranscript ?? false;
    const said = this.transcriptSaid.get(o.sessionId) ?? {};
    const changed: TextFields = {};
    for (const k of TEXT_FIELDS) if (o[k] !== undefined && o[k] !== said[k]) changed[k] = o[k];
    this.transcriptSaid.set(o.sessionId, { ...said, ...changed });
    const turnNews = !!s && o.turn !== undefined && o.turnAt !== undefined && s.status !== o.turn && transcriptTurnApplies(s, o.turnAt, o.interrupted);
    const activityNews = !!s && s.lastHookAt === null && (o.lastActivityAt ?? 0) > s.lastActivityAt + ACTIVITY_STEP_MS;
    if (known && Object.keys(changed).length === 0 && !turnNews && !activityNews) return null;
    const ev: FoundryEvent = {
      kind: "foundry", ts: Date.now(), type: "transcript.observed", sessionId: o.sessionId, transcriptPath: o.transcriptPath,
      ...(known ? changed : pickDefined(o, TEXT_FIELDS)),
      startedAt: o.startedAt, lastActivityAt: o.lastActivityAt, turn: o.turn, turnAt: o.turnAt, interrupted: o.interrupted,
    };
    return this.record(dropUndefined(ev));
  }

  /** Records a subagent or workflow agent the tailer found, or a change in whether it is running. */
  observeAgent(o: AgentObservation): LoggedEvent | null {
    const s = this.state.sessions[o.sessionId];
    const existing = s?.agents[o.agentId] ?? (o.toolUseId ? Object.values(s?.agents ?? {}).find((a) => a.toolUseId === o.toolUseId) : undefined);
    const said = this.agentSaid.get(o.agentId) ?? existing?.running;
    this.agentSaid.set(o.agentId, o.running);
    if (existing && existing.id === o.agentId && said === o.running) return null;
    return this.record({ kind: "foundry", ts: Date.now(), type: "transcript.agent", ...o });
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

function pickDefined<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
