import { appendFileSync, mkdirSync, mkdtempSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Core } from "../src/core";
import { EventLog } from "../src/db";
import { Tailer, type AgentObservation, type SessionObservation } from "../src/tailer";
import { classify, readLine, titleOf, type SessionFacts } from "../src/transcript";

// Synthetic transcripts only: real ones hold prompts and code and never go in the repo.
const SID = "11111111-2222-3333-4444-555555555555";
const at = (sec: number) => new Date(Date.UTC(2026, 10, 19, 10, 0, sec)).toISOString();
const jsonl = (...lines: object[]) => lines.map((l) => JSON.stringify(l) + "\n").join("");
const prompt = (sec: number, text: string) => ({ type: "user", timestamp: at(sec), entrypoint: "cli", cwd: "/repo", message: { role: "user", content: text } });
const reply = (sec: number, stop: string) => ({ type: "assistant", timestamp: at(sec), message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text: "ok" }] } });

function facts(...lines: object[]): SessionFacts {
  const f: SessionFacts = {};
  for (const l of lines) readLine(f, l);
  return f;
}

describe("classify", () => {
  it("tells sessions, subagents and workflow agents apart", () => {
    expect(classify(`p/${SID}.jsonl`)).toEqual({ kind: "session", sessionId: SID });
    expect(classify(`p/${SID}/subagents/agent-a1b2.jsonl`)).toEqual({ kind: "agent", sessionId: SID, agentId: "a1b2", workflowId: null });
    expect(classify(`p/${SID}/subagents/workflows/wf_9/agent-c3.jsonl`)).toEqual({ kind: "agent", sessionId: SID, agentId: "c3", workflowId: "wf_9" });
    expect(classify(`p/${SID}/subagents/workflows/wf_9/journal.jsonl`)).toBeNull();
    expect(classify(`p/notes.jsonl`)).toBeNull();
  });
});

describe("readLine", () => {
  it("follows the turn", () => {
    expect(facts(prompt(1, "go")).turn).toBe("working");
    expect(facts(prompt(1, "go"), reply(2, "tool_use")).turn).toBe("working");
    expect(facts(prompt(1, "go"), reply(2, "end_turn"))).toMatchObject({ turn: "waiting", turnAt: Date.parse(at(2)) });
    expect(facts(prompt(1, "go"), prompt(2, "[Request interrupted by user for tool use]")).turn).toBe("waiting");
    expect(facts(prompt(1, "go"), reply(2, "end_turn"), { ...prompt(3, "side"), isSidechain: true }).turn).toBe("waiting");
    expect(facts(prompt(1, "<command-name>/model</command-name>"), prompt(2, "<local-command-stdout>Set model</local-command-stdout>")).turn).toBe("waiting");
  });

  it("keeps the first entrypoint, the latest title and folder, and prefers the custom title", () => {
    const f = facts(
      prompt(1, "go"),
      { type: "ai-title", aiTitle: "AI title" },
      { type: "custom-title", customTitle: "Mine" },
      { type: "relocated", relocatedCwd: "/elsewhere" },
      { ...reply(5, "end_turn"), entrypoint: "claude-desktop" },
      { type: "last-prompt", lastPrompt: "go" },
    );
    expect(f).toMatchObject({ entrypoint: "cli", cwd: "/elsewhere", lastPrompt: "go", startedAt: Date.parse(at(1)), lastActivityAt: Date.parse(at(5)) });
    expect(titleOf(f)).toBe("Mine");
    expect(titleOf(facts({ type: "ai-title", aiTitle: "AI title" }))).toBe("AI title");
  });

  it("skips lines it doesn't understand", () => {
    expect(() => facts({ type: "something-new", foo: 1 }, { type: "assistant" }, null as unknown as object)).not.toThrow();
  });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "foundry-tx-"));
  const proj = join(root, "-Users-me-repo");
  mkdirSync(proj);
  const sessions: SessionObservation[] = [];
  const agents: AgentObservation[] = [];
  const clock = { now: Date.now() };
  const tailer = new Tailer({ root, windowMs: 3_600_000, staleMs: 600_000, now: () => clock.now, onSession: (o) => sessions.push(o), onAgent: (o) => agents.push(o) });
  return { root, proj, tailer, sessions, agents, clock };
}

const old = (path: string) => { const d = new Date(Date.now() - 48 * 3_600_000); utimesSync(path, d, d); };

describe("Tailer", () => {
  it("reads recent sessions, then only what was appended, waiting for a line to be complete", async () => {
    const { proj, tailer, sessions } = setup();
    const path = join(proj, `${SID}.jsonl`);
    writeFileSync(path, jsonl(prompt(1, "go"), { type: "custom-title", customTitle: "Fix login" }));
    await tailer.poll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: SID, transcriptPath: path, entrypoint: "cli", title: "Fix login", turn: "working" });

    await tailer.poll();
    expect(sessions).toHaveLength(1); // nothing changed, nothing read

    const done = JSON.stringify(reply(9, "end_turn"));
    appendFileSync(path, done.slice(0, 20));
    await tailer.poll();
    expect(sessions.at(-1)!.turn).toBe("working"); // half a line isn't a line
    appendFileSync(path, done.slice(20) + "\n");
    await tailer.poll();
    expect(sessions.at(-1)).toMatchObject({ turn: "waiting", title: "Fix login" });
  });

  it("leaves old sessions alone until asked, and follows a session that moved", async () => {
    const { root, proj, tailer, sessions } = setup();
    const path = join(proj, `${SID}.jsonl`);
    writeFileSync(path, jsonl(prompt(1, "go")));
    old(path);
    await tailer.poll();
    expect(sessions).toHaveLength(0);
    tailer.track(path);
    await tailer.poll();
    expect(sessions).toHaveLength(1);

    const other = join(root, "-Users-me-repo-worktree");
    mkdirSync(other);
    renameSync(path, join(other, `${SID}.jsonl`));
    old(join(other, `${SID}.jsonl`)); // a rename keeps the old mtime
    await tailer.poll(); // notices it's gone
    await tailer.poll(); // and picks it up in its new folder
    expect(sessions.at(-1)!.transcriptPath).toBe(join(other, `${SID}.jsonl`));
  });

  it("reports subagents and workflow agents, and when they stop", async () => {
    const { proj, tailer, agents, clock } = setup();
    writeFileSync(join(proj, `${SID}.jsonl`), jsonl(prompt(1, "go")));
    const sub = join(proj, SID, "subagents");
    const wf = join(sub, "workflows", "wf_7");
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(sub, "agent-a1.jsonl"), jsonl(prompt(2, "find it")));
    writeFileSync(join(sub, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find it", toolUseId: "toolu_1" }));
    writeFileSync(join(wf, "agent-w1.jsonl"), jsonl(prompt(3, "scope")));
    writeFileSync(join(wf, "agent-w1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "scope", workflowPhase: "Scope" }));
    writeFileSync(join(wf, "journal.jsonl"), jsonl({ type: "launched" }, { type: "started", agentId: "w1" }));
    writeFileSync(join(wf, "agent-w2.jsonl"), jsonl(prompt(3, "stale")));
    await tailer.poll();
    expect(agents.map((a) => [a.agentId, a.running, a.workflowId, a.toolUseId])).toEqual(expect.arrayContaining([
      ["a1", true, null, "toolu_1"], ["w1", true, "wf_7", null], ["w2", true, "wf_7", null],
    ]));

    writeFileSync(join(sub, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find it", toolUseId: "toolu_1", finished: true }));
    appendFileSync(join(sub, "agent-a1.jsonl"), jsonl(reply(4, "end_turn")));
    appendFileSync(join(wf, "journal.jsonl"), jsonl({ type: "result", agentId: "w1" }));
    await tailer.poll();
    expect(agents.slice(3).map((a) => [a.agentId, a.running]).sort()).toEqual([["a1", false], ["w1", false]]);

    clock.now += 11 * 60_000; // w2 never finished and went quiet
    await tailer.poll();
    expect(agents.at(-1)).toMatchObject({ agentId: "w2", running: false });
  });
});

describe("Core.observeSession", () => {
  const obs = (extra: Partial<SessionObservation> = {}): SessionObservation =>
    ({ sessionId: "t1", transcriptPath: "/t/t1.jsonl", entrypoint: "cli", title: "Fix login", lastPrompt: "go", startedAt: 1000, lastActivityAt: 2000, turn: "waiting", turnAt: 2000, ...extra });

  it("records a new session once, then only what changed", () => {
    const core = new Core(new EventLog(":memory:"));
    expect(core.observeSession(obs())).not.toBeNull();
    expect(core.observeSession(obs())).toBeNull();
    const ev = core.observeSession(obs({ title: "Login flake" }));
    expect(ev).toMatchObject({ type: "transcript.observed", title: "Login flake" });
    expect(ev).not.toHaveProperty("lastPrompt");
    expect(core.state.sessions.t1).toMatchObject({ status: "waiting", title: "Login flake", entrypoint: "cli" });
  });

  it("only records a turn change the hooks haven't reported", () => {
    const core = new Core(new EventLog(":memory:"));
    core.record({ kind: "hook", ts: 10_000, payload: { session_id: "t1", hook_event_name: "UserPromptSubmit", prompt: "go" } });
    core.observeSession(obs({ turn: "working", turnAt: 10_000 }));
    expect(core.observeSession(obs({ turn: "waiting", turnAt: 11_000 }))).toBeNull(); // the Stop hook will say so
    expect(core.observeSession(obs({ turn: "waiting", turnAt: 90_000 }))).not.toBeNull();
    expect(core.state.sessions.t1!.status).toBe("waiting");
  });

  it("doesn't record anything again after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-"));
    const a = new Core(new EventLog(join(dir, "f.db")));
    a.observeSession(obs());
    a.observeAgent({ sessionId: "t1", agentId: "x", agentType: "Explore", description: null, toolUseId: null, workflowId: null, running: false, startedAt: 1, lastActivityAt: 2 });
    const b = new Core(new EventLog(join(dir, "f.db")));
    expect(b.observeSession(obs())).toBeNull();
    expect(b.observeAgent({ sessionId: "t1", agentId: "x", agentType: "Explore", description: null, toolUseId: null, workflowId: null, running: false, startedAt: 1, lastActivityAt: 2 })).toBeNull();
  });
});

describe("spool", () => {
  it("skips a spooled copy of an event that already arrived", () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-"));
    const core = new Core(new EventLog(":memory:"));
    const ev = { kind: "hook" as const, ts: 5, payload: { session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "hi" } };
    core.record(ev);
    writeFileSync(join(dir, "spool.jsonl"), JSON.stringify(ev) + "\n" + JSON.stringify({ ...ev, ts: 6 }) + "\n");
    expect(core.drainSpool(join(dir, "spool.jsonl"))).toBe(1);
  });
});
