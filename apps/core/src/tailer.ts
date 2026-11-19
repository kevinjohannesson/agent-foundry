/**
 * Follows Claude Code's transcripts under ~/.claude/projects and reports what they say.
 * It polls instead of watching: a few hundred stats a second is cheap, and polling never misses a moved file.
 * Session files modified within the backfill window are read; older ones only when the core asks (`track`).
 * It reports everything it reads; the core decides what is new enough to record.
 */
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { classify, readLine, titleOf, type SessionFacts } from "./transcript";
import type { TranscriptTurn } from "@foundry/protocol";

export interface SessionObservation {
  sessionId: string;
  transcriptPath: string;
  entrypoint?: string;
  title?: string;
  cwd?: string;
  lastPrompt?: string;
  startedAt?: number;
  lastActivityAt?: number;
  turn?: TranscriptTurn;
  turnAt?: number;
}

export interface AgentObservation {
  sessionId: string;
  agentId: string;
  agentType: string;
  description: string | null;
  toolUseId: string | null;
  workflowId: string | null;
  running: boolean;
  startedAt: number;
  lastActivityAt: number;
}

export interface TailerOptions {
  /** The projects folder, normally ~/.claude/projects. */
  root: string;
  /** Session files modified this recently are read without being asked for. */
  windowMs: number;
  /** An agent whose transcript hasn't changed this long, and never said it finished, counts as done. */
  staleMs?: number;
  now?: () => number;
  onSession: (o: SessionObservation) => void;
  onAgent: (o: AgentObservation) => void;
}

interface SessionFile {
  path: string;
  sessionId: string;
  offset: number;
  /** Bytes after the last newline: a line still being written. */
  rest: Buffer;
  mtimeMs: number;
  facts: SessionFacts;
  agents: Map<string, AgentFile>;
  workflows: string[];
}

interface AgentFile {
  path: string;
  agentId: string;
  workflowId: string | null;
  meta: Record<string, unknown>;
  startedAt: number;
  lastActivityAt: number;
  /** What was last reported; null before the first report. */
  running: boolean | null;
}

const CHUNK = 4 * 1024 * 1024;
const NEWLINE = 0x0a;
const MISSING_TRACK_MS = 10 * 60_000;

export class Tailer {
  private sessions = new Map<string, SessionFile>();
  private dirMtimes = new Map<string, number>();
  /** Paths the core asked for, with when. Kept until found, or dropped after a while if they never appear. */
  private wanted = new Map<string, number>();
  /** Session ids whose file disappeared: probably moved to another project folder. */
  private moved = new Set<string>();
  private polling: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly staleMs: number;

  constructor(private opts: TailerOptions) {
    this.now = opts.now ?? Date.now;
    this.staleMs = opts.staleMs ?? 10 * 60_000;
  }

  /** Read this session file even if it is older than the window (a resumed session, or one the core already knows). */
  track(path: string) {
    if (!this.sessions.has(path) && !this.wanted.has(path)) this.wanted.set(path, this.now());
  }

  /** Polls every `intervalMs` until the returned function is called. */
  start(intervalMs = 1000): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const loop = async () => {
      await this.poll().catch((e) => console.error("tailer:", e));
      if (!stopped) timer = setTimeout(loop, intervalMs);
    };
    void loop();
    return () => { stopped = true; clearTimeout(timer); };
  }

  /** One pass: find files, read what changed, report. Overlapping calls share one pass. */
  poll(): Promise<void> {
    this.polling ??= this.pass().finally(() => { this.polling = null; });
    return this.polling;
  }

  private async pass() {
    const now = this.now();
    const cutoff = now - this.opts.windowMs;
    const seen = new Set<string>();
    for (const project of await list(this.opts.root)) {
      if (project.startsWith(".")) continue;
      const dir = join(this.opts.root, project);
      for (const name of await list(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        const kind = classify(`${project}/${name}`);
        if (kind?.kind !== "session") continue;
        const st = await stat(path).catch(() => null);
        if (!st) continue;
        seen.add(path);
        const known = this.sessions.has(path);
        if (!known && st.mtimeMs < cutoff && !this.wanted.has(path) && !this.moved.has(kind.sessionId)) continue;
        await this.readSession(path, kind.sessionId, st.size, st.mtimeMs);
      }
    }
    // Asked-for paths outside the projects folder.
    for (const [path, since] of this.wanted) {
      if (seen.has(path)) continue;
      const st = await stat(path).catch(() => null);
      const id = basename(path, ".jsonl");
      if (st) { seen.add(path); await this.readSession(path, id, st.size, st.mtimeMs); }
      else if (now - since > MISSING_TRACK_MS) this.wanted.delete(path);
    }
    for (const [path, f] of this.sessions) {
      if (seen.has(path)) continue;
      this.sessions.delete(path); // gone: deleted, or moved to the folder of its new working directory
      this.moved.add(f.sessionId);
    }
    for (const f of this.sessions.values()) await this.pollAgents(f);
  }

  private async readSession(path: string, sessionId: string, size: number, mtimeMs: number) {
    this.wanted.delete(path);
    this.moved.delete(sessionId);
    let f = this.sessions.get(path);
    const isNew = !f;
    if (!f) {
      f = { path, sessionId, offset: 0, rest: Buffer.alloc(0), mtimeMs, facts: {}, agents: new Map(), workflows: [] };
      this.sessions.set(path, f);
    }
    if (size < f.offset) { f.offset = 0; f.rest = Buffer.alloc(0); f.facts = {}; } // rewritten from scratch
    if (size === f.offset && !isNew) return;
    const fh = await open(path, "r").catch(() => null);
    if (!fh) return;
    try {
      while (f.offset < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - f.offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, f.offset);
        if (bytesRead === 0) break;
        f.offset += bytesRead;
        const data = Buffer.concat([f.rest, buf.subarray(0, bytesRead)]);
        const end = data.lastIndexOf(NEWLINE);
        if (end === -1) { f.rest = data; continue; }
        f.rest = Buffer.from(data.subarray(end + 1));
        for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
          if (!line) continue;
          try { readLine(f.facts, JSON.parse(line)); } catch { /* a line we can't parse: skip it */ }
        }
        await new Promise((r) => setImmediate(r)); // let hook requests through between chunks
      }
    } finally {
      await fh.close();
    }
    f.mtimeMs = mtimeMs;
    // If the session moved and both files exist for a moment, the newer one speaks for it.
    for (const other of this.sessions.values()) if (other !== f && other.sessionId === sessionId && other.mtimeMs > f.mtimeMs) return;
    const facts = f.facts;
    this.opts.onSession({
      sessionId, transcriptPath: path,
      entrypoint: facts.entrypoint, title: titleOf(facts), cwd: facts.cwd, lastPrompt: facts.lastPrompt,
      startedAt: facts.startedAt, lastActivityAt: facts.lastActivityAt, turn: facts.turn, turnAt: facts.turnAt,
    });
  }

  /** Finds the session's subagent and workflow agent transcripts and reports when each starts and stops running. */
  private async pollAgents(f: SessionFile) {
    const dir = join(f.path.slice(0, -".jsonl".length), "subagents");
    const add = (path: string, workflowId: string | null) => {
      const name = basename(path);
      if (!name.startsWith("agent-") || !name.endsWith(".jsonl") || f.agents.has(path)) return;
      f.agents.set(path, { path, agentId: name.slice("agent-".length, -".jsonl".length), workflowId, meta: {}, startedAt: 0, lastActivityAt: 0, running: null });
    };
    for (const n of (await this.listIfChanged(dir)) ?? []) add(join(dir, n), null);
    const wfRoot = join(dir, "workflows");
    const wfs = await this.listIfChanged(wfRoot);
    if (wfs) f.workflows = wfs.filter((n) => n.startsWith("wf_"));
    for (const wf of f.workflows) for (const n of (await this.listIfChanged(join(wfRoot, wf))) ?? []) add(join(wfRoot, wf, n), wf);

    // Finished agents can be continued, so look at them too while the session itself is active.
    const sessionActive = this.now() - f.mtimeMs < this.staleMs;
    const journals = new Map<string, Set<string>>();
    for (const a of f.agents.values()) {
      if (a.running === false && !sessionActive) continue;
      const st = await stat(a.path).catch(() => null);
      if (!st) continue;
      if (a.running === false && st.mtimeMs <= a.lastActivityAt) continue;
      a.startedAt ||= st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
      a.lastActivityAt = st.mtimeMs;
      a.meta = (await readJson(a.path.slice(0, -".jsonl".length) + ".meta.json")) ?? a.meta;
      let finished = a.meta.finished === true;
      if (a.workflowId) {
        let done = journals.get(a.workflowId);
        if (!done) { done = await finishedInJournal(join(wfRoot, a.workflowId, "journal.jsonl")); journals.set(a.workflowId, done); }
        finished ||= done.has(a.agentId);
      }
      const running = !finished && this.now() - st.mtimeMs < this.staleMs;
      if (running === a.running) continue;
      a.running = running;
      this.opts.onAgent({
        sessionId: f.sessionId, agentId: a.agentId,
        agentType: typeof a.meta.agentType === "string" ? a.meta.agentType : "general-purpose",
        description: typeof a.meta.description === "string" ? a.meta.description : null,
        toolUseId: typeof a.meta.toolUseId === "string" ? a.meta.toolUseId : null,
        workflowId: a.workflowId, running, startedAt: a.startedAt, lastActivityAt: st.mtimeMs,
      });
    }
  }

  /** A folder's entries if it changed since the last look (adding or removing a file changes its mtime), else null. */
  private async listIfChanged(dir: string): Promise<string[] | null> {
    const st = await stat(dir).catch(() => null);
    if (!st || this.dirMtimes.get(dir) === st.mtimeMs) return null;
    this.dirMtimes.set(dir, st.mtimeMs);
    return list(dir);
  }
}

async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

/** Agent ids a workflow journal has a `result` for. */
async function finishedInJournal(path: string): Promise<Set<string>> {
  const done = new Set<string>();
  const text = await readFile(path, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { const o = JSON.parse(line); if (o.type === "result" && typeof o.agentId === "string") done.add(o.agentId); } catch { /* skip */ }
  }
  return done;
}
