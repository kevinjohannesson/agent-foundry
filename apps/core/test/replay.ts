/**
 * Replays a recorded hook spool together with the transcripts written at the same time, on a simulated clock,
 * through the real tailer, core and projector. Transcript lines are copied into a temp folder as their timestamps
 * come due and the tailer polls every tick, so it sees them the way it would have live; hook events are recorded
 * at their own timestamps in between. Nothing is read from or written to the real data folders except reading.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { emptyState, replay as project, StoredEvent, type FoundryState, type HookEvent, type LoggedEvent, type SessionStatus } from "@foundry/protocol";
import { Core } from "../src/core";
import { EventLog } from "../src/db";
import { Tailer } from "../src/tailer";
import { classify, readLine, type SessionFacts } from "../src/transcript";

export interface ReplayOptions {
  spool: string;
  /** The real projects folder (read only). */
  projects: string;
  tickMs?: number;
  /** Keep simulating this long after the last hook event. */
  tailMs?: number;
}

export interface StatusChange {
  sessionId: string;
  at: number;
  from: SessionStatus | "none";
  to: SessionStatus;
  by: string;
  /** Time since the session's previous hook event, or null if it had none. */
  sinceHookMs: number | null;
}

export interface ReplayResult {
  spool: { lines: number; parsed: number };
  start: number;
  end: number;
  files: number;
  hooks: HookEvent[];
  /** The state at the end of the spool window, from hooks plus transcripts. */
  atEnd: FoundryState;
  /** The same hooks through the projector alone, for comparison. */
  hooksOnly: FoundryState;
  /** What each session's transcript said at the end of the window (read independently of the tailer). */
  factsAtEnd: Map<string, SessionFacts>;
  /** The state after the rest of each transcript was written, as on a live start today. */
  final: FoundryState;
  changes: StatusChange[];
  /** Events recorded by one more poll after the end with nothing changed. */
  idleEvents: number;
  /** A core rebuilt from the same log, and a fresh tailer over the same files. */
  restart: { sameState: boolean; events: LoggedEvent[] };
  elapsedMs: number;
}

interface Line { at: number; text: string }
interface TimedFile { rel: string; lines: Line[]; written: number }

const NL = "\n";

/** A file's complete lines with a time each: its own timestamp, or the one before it, kept non-decreasing. */
function timedLines(path: string): Line[] {
  const text = readFileSync(path, "utf8");
  const parts = text.split(NL);
  parts.pop(); // after the last newline: empty, or a line still being written
  let at = 0;
  return parts.filter(Boolean).map((t) => {
    try { const ts = Date.parse(JSON.parse(t).timestamp); if (!Number.isNaN(ts)) at = Math.max(at, ts); } catch { /* keep time */ }
    return { at, text: t };
  });
}

const list = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };

export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const t0 = Date.now();
  const tickMs = opts.tickMs ?? 1000;
  const raw = readFileSync(opts.spool, "utf8").split(NL).filter(Boolean);
  const hooks: HookEvent[] = [];
  for (const line of raw) {
    try { const p = StoredEvent.safeParse(JSON.parse(line)); if (p.success && p.data.kind === "hook") hooks.push(p.data); } catch { /* counted below */ }
  }
  hooks.sort((a, b) => a.ts - b.ts);
  const start = hooks[0]!.ts;
  const end = hooks.at(-1)!.ts + (opts.tailMs ?? 5 * 60_000);
  const spoolSessions = new Set(hooks.map((h) => h.payload.session_id));

  // Session files active since the window began, plus every session the spool names, with their agents.
  const tmp = mkdtempSync(join(tmpdir(), "foundry-replay-"));
  const root = join(tmp, "projects");
  const files: TimedFile[] = [];
  const agentFiles: Array<{ rel: string; lines: Line[]; meta: Record<string, unknown> | null; workflowId: string | null; agentId: string; written: number; metaStage: 0 | 1 | 2 }> = [];
  const journals = new Map<string, { rel: string; lines: Line[]; written: number }>();
  for (const project of list(opts.projects)) {
    if (project.startsWith(".")) continue;
    for (const name of list(join(opts.projects, project))) {
      const kind = classify(`${project}/${name}`);
      if (kind?.kind !== "session") continue;
      const path = join(opts.projects, project, name);
      if (statSync(path).mtimeMs < start && !spoolSessions.has(kind.sessionId)) continue;
      files.push({ rel: `${project}/${name}`, lines: timedLines(path), written: 0 });
      const sub = join(opts.projects, project, kind.sessionId, "subagents");
      const agentPaths: Array<[string, string | null]> = list(sub).map((n) => [join(sub, n), null]);
      for (const wf of list(join(sub, "workflows"))) for (const n of list(join(sub, "workflows", wf))) agentPaths.push([join(sub, "workflows", wf, n), wf]);
      for (const [p, wf] of agentPaths) {
        const n = basename(p);
        if (!n.startsWith("agent-") || !n.endsWith(".jsonl")) continue;
        const metaPath = p.slice(0, -".jsonl".length) + ".meta.json";
        const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown> : null;
        const rel = p.slice(opts.projects.length + 1);
        agentFiles.push({ rel, lines: timedLines(p), meta, workflowId: wf, agentId: n.slice(6, -6), written: 0, metaStage: 0 });
      }
    }
  }
  // Workflow journals: their entries carry no time, so "started" and "result" go with the agent's first and last line.
  for (const a of agentFiles) {
    if (!a.workflowId || a.lines.length === 0) continue;
    const rel = join(dirname(a.rel), "journal.jsonl");
    const j = journals.get(rel) ?? { rel, lines: [], written: 0 };
    j.lines.push({ at: a.lines[0]!.at, text: JSON.stringify({ type: "started", agentId: a.agentId }) });
    j.lines.push({ at: a.lines.at(-1)!.at, text: JSON.stringify({ type: "result", agentId: a.agentId }) });
    journals.set(rel, j);
  }
  for (const j of journals.values()) j.lines.sort((x, y) => x.at - y.at);

  const write = (f: { rel: string; lines: Line[]; written: number }, upTo: number): boolean => {
    let n = f.written;
    while (n < f.lines.length && f.lines[n]!.at <= upTo) n++;
    if (n === f.written) return false;
    const path = join(root, f.rel);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, f.lines.slice(f.written, n).map((l) => l.text + NL).join(""));
    f.written = n;
    const at = f.lines[n - 1]!.at || upTo;
    utimesSync(path, at / 1000, at / 1000);
    return true;
  };
  const writeDue = (upTo: number) => {
    for (const f of files) write(f, upTo);
    for (const a of agentFiles) {
      write(a, upTo);
      // The meta appears with the agent; `finished` only once its last line is written.
      const stage = a.written === 0 ? 0 : a.written < a.lines.length ? 1 : 2;
      if (stage !== a.metaStage && a.meta) {
        const meta = stage === 2 ? a.meta : Object.fromEntries(Object.entries(a.meta).filter(([k]) => k !== "finished"));
        writeFileSync(join(root, a.rel.slice(0, -".jsonl".length) + ".meta.json"), JSON.stringify(meta));
        a.metaStage = stage;
      }
    }
    for (const j of journals.values()) write(j, upTo);
  };

  // The real core and tailer, on the simulated clock, with hook paths pointed at the temp copy.
  let now = start - tickMs;
  const dbPath = join(tmp, "foundry.db");
  const core = new Core(new EventLog(dbPath));
  const mkTailer = (c: Core) => new Tailer({ root, windowMs: 24 * 3_600_000, now: () => now, onSession: (o) => c.observeSession(o), onAgent: (o) => c.observeAgent(o) });
  const tailer = mkTailer(core);
  const remap = (p: unknown) => (typeof p === "string" && p.startsWith(opts.projects) ? root + p.slice(opts.projects.length) : p);
  const last = new Map<string, { status: SessionStatus; hookAt: number | null }>();
  const changes: StatusChange[] = [];
  core.subscribe((ev, state) => {
    if (ev.kind === "hook" && typeof ev.payload.transcript_path === "string") tailer.track(ev.payload.transcript_path);
    const id = ev.kind === "hook" ? ev.payload.session_id : "sessionId" in ev ? ev.sessionId : null;
    if (!id) return;
    const s = state.sessions[id];
    const before = last.get(id);
    if (s && s.status !== before?.status) {
      changes.push({ sessionId: id, at: now, from: before?.status ?? "none", to: s.status, by: ev.kind === "hook" ? `hook ${ev.payload.hook_event_name}` : ev.type,
        sinceHookMs: before?.hookAt != null ? now - before.hookAt : null });
    }
    if (s) last.set(id, { status: s.status, hookAt: s.lastHookAt });
  });

  writeDue(now);
  await tailer.poll(); // the backfill a core started at the beginning of the window would do
  let h = 0;
  for (let t = start; t <= end; t += tickMs) {
    while (h < hooks.length && hooks[h]!.ts <= t) {
      const ev = hooks[h++]!;
      now = ev.ts;
      core.record({ ...ev, payload: { ...ev.payload, transcript_path: remap(ev.payload.transcript_path) as string | undefined, agent_transcript_path: remap(ev.payload.agent_transcript_path) } });
    }
    now = t;
    writeDue(t);
    await tailer.poll();
  }
  const atEnd = structuredClone(core.state);
  const factsAtEnd = new Map<string, SessionFacts>();
  for (const f of files) {
    const facts: SessionFacts = {};
    for (const l of f.lines) if (l.at <= end) { try { readLine(facts, JSON.parse(l.text)); } catch { /* skip */ } }
    factsAtEnd.set(classify(f.rel)!.sessionId, facts);
  }

  // Everything written since, read as a core started today would.
  now = Date.now();
  writeDue(Infinity);
  await tailer.poll();
  const final = structuredClone(core.state);
  const seq = core.state.seq;
  await tailer.poll();
  const idleEvents = core.state.seq - seq;

  const again = new Core(new EventLog(dbPath));
  const sameState = JSON.stringify(again.state) === JSON.stringify(core.state);
  const restartEvents: LoggedEvent[] = [];
  again.subscribe((ev) => restartEvents.push(ev));
  await mkTailer(again).poll();

  rmSync(tmp, { recursive: true, force: true }); // the copy holds real transcripts: don't leave it behind
  const hooksOnly = project(hooks.map((e, i) => ({ ...e, seq: i + 1 }) as LoggedEvent), emptyState());
  return {
    spool: { lines: raw.length, parsed: hooks.length }, start, end, files: files.length + agentFiles.length, hooks,
    atEnd, hooksOnly, factsAtEnd, final, changes, idleEvents, restart: { sameState, events: restartEvents }, elapsedMs: Date.now() - t0,
  };
}
