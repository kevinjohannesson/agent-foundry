import { describe, expect, it } from "vitest";
import type { LoggedEvent } from "./events";
import { replay } from "./project";
import { emptyState } from "./state";

let seq = 0;
const hook = (name: string, extra: Record<string, unknown> = {}, sid = "s1"): LoggedEvent =>
  ({ seq: ++seq, kind: "hook", ts: seq * 1000, payload: { session_id: sid, hook_event_name: name, cwd: "/repo", ...extra } }) as LoggedEvent;

describe("projector", () => {
  it("follows a session through a turn", () => {
    const st = replay([
      hook("SessionStart", { source: "startup" }),
      hook("UserPromptSubmit", { prompt: "Migrate the Button to new tokens" }),
      hook("PreToolUse", { tool_name: "Read" }),
      hook("PreToolUse", { tool_name: "Task" }),
      hook("PostToolUse", { tool_name: "Task" }),
      hook("Stop"),
    ], emptyState());
    const s = st.sessions.s1!;
    expect(s.name).toBe("Migrate Button new");
    expect(s.mono).toBe("Mb");
    expect(s.status).toBe("waiting");
    expect(s.toolCalls).toBe(2);
    expect(s.subagentsTotal).toBe(1);
    expect(s.activeSubagents).toBe(0);
  });

  it("marks notifications as needing you and clears them on the next prompt", () => {
    const st = replay([hook("UserPromptSubmit", { prompt: "go" }, "s2"), hook("Notification", { message: "Claude needs your permission to use Bash" }, "s2")], emptyState());
    expect(st.sessions.s2!.status).toBe("needs_you");
    replay([hook("UserPromptSubmit", { prompt: "yes" }, "s2")], st);
    expect(st.sessions.s2!.status).toBe("working");
    expect(st.sessions.s2!.notification).toBeNull();
  });

  it("treats a failed turn as needing you, and a failed subagent call as finished", () => {
    const st = replay([
      hook("UserPromptSubmit", { prompt: "go" }, "s3"),
      hook("PreToolUse", { tool_name: "Agent" }, "s3"),
      hook("PostToolUseFailure", { tool_name: "Agent", error: "boom" }, "s3"),
    ], emptyState());
    expect(st.sessions.s3!.activeSubagents).toBe(0);
    expect(st.sessions.s3!.status).toBe("working");
    replay([hook("StopFailure", { error: "rate_limit" }, "s3")], st);
    expect(st.sessions.s3!.status).toBe("needs_you");
    expect(st.sessions.s3!.notification).toBe("Turn failed: rate_limit");
  });

  it("ignores benign notifications", () => {
    const st = replay([hook("UserPromptSubmit", { prompt: "go" }, "s4"), hook("Stop", {}, "s4"), hook("Notification", { notification_type: "auth_success", message: "Signed in" }, "s4")], emptyState());
    expect(st.sessions.s4!.status).toBe("waiting");
  });

  it("drops a pre-warmed ghost but keeps a session that did something", () => {
    const st = replay([hook("SessionStart", {}, "g"), hook("SessionStart", {}, "real")], emptyState());
    expect(st.sessions.g!.pending).toBe(true);
    replay([hook("UserPromptSubmit", { prompt: "hi" }, "real"), hook("SessionEnd", {}, "g"), hook("SessionEnd", {}, "real")], st);
    expect(st.sessions.g).toBeUndefined();
    expect(st.sessions.real!.status).toBe("ended");
    expect(st.sessions.real!.pending).toBe(false);
  });

  it("puts a reopened session on your plate and a new one at idle", () => {
    const st = replay([hook("SessionStart", { source: "resume" }, "r1"), hook("SessionStart", { source: "startup" }, "r2")], emptyState());
    expect(st.sessions.r1!.status).toBe("waiting");
    expect(st.sessions.r2!.status).toBe("idle");
    expect(st.sessions.r1!.statusFrom).toBe("hooks");
  });

  it("doesn't let a subagent's tool calls reopen a finished turn", () => {
    const st = replay([
      hook("UserPromptSubmit", { prompt: "go" }, "s5"),
      hook("PreToolUse", { tool_name: "Agent", tool_use_id: "toolu_bg", tool_input: { run_in_background: true, subagent_type: "Explore" } }, "s5"),
      hook("PostToolUse", { tool_name: "Agent", tool_use_id: "toolu_bg" }, "s5"),
      hook("Stop", {}, "s5"),
      hook("PreToolUse", { tool_name: "Read", agent_id: "toolu_bg", agent_type: "Explore" }, "s5"),
    ], emptyState());
    const s = st.sessions.s5!;
    expect(s.status).toBe("waiting");
    expect(s.activeSubagents).toBe(1); // a background agent outlives the turn
    expect(s.agents.toolu_bg!.type).toBe("Explore");
  });
});

const tx = (sid: string, extra: Record<string, unknown>): LoggedEvent =>
  ({ seq: ++seq, kind: "foundry", ts: seq * 1000, type: "transcript.observed", sessionId: sid, transcriptPath: `/t/${sid}.jsonl`, ...extra }) as LoggedEvent;
const agent = (sid: string, extra: Record<string, unknown>): LoggedEvent =>
  ({ seq: ++seq, kind: "foundry", ts: seq * 1000, type: "transcript.agent", sessionId: sid, agentType: "general-purpose", description: null,
    toolUseId: null, workflowId: null, running: true, startedAt: 1, lastActivityAt: 2, ...extra }) as LoggedEvent;

describe("projector with transcripts", () => {
  it("backfills a session from its transcript alone", () => {
    const st = replay([tx("t1", { entrypoint: "claude-vscode", title: "Vehicle status telemetry data flow", cwd: "/repo", lastPrompt: "trace it",
      startedAt: 100, lastActivityAt: 500, turn: "waiting", turnAt: 500 })], emptyState());
    const s = st.sessions.t1!;
    expect(s).toMatchObject({ entrypoint: "claude-vscode", name: "Vehicle status telemetry", nameSource: "title", status: "waiting",
      startedAt: 100, lastActivityAt: 500, hasTranscript: true, pending: false, lastHookAt: null });
  });

  it("names from the app title over the prompt, but never over a rename", () => {
    const st = replay([hook("UserPromptSubmit", { prompt: "Fix the flaky login test" }, "n1")], emptyState());
    expect(st.sessions.n1!.name).toBe("Fix flaky login");
    replay([tx("n1", { title: "Login test flakiness" })], st);
    expect(st.sessions.n1!.name).toBe("Login test flakiness");
    replay([{ seq: ++seq, kind: "foundry", ts: 1, type: "session.renamed", sessionId: "n1", name: "Auth flake" } as LoggedEvent,
      tx("n1", { title: "Something else" }), hook("UserPromptSubmit", { prompt: "now this", session_title: "Another" }, "n1")], st);
    expect(st.sessions.n1!.name).toBe("Auth flake");
    expect(st.sessions.n1!.title).toBe("Another");
  });

  it("lets a transcript turn override hook status only when it is newer than the last hook", () => {
    const st = replay([hook("UserPromptSubmit", { prompt: "go" }, "h1")], emptyState());
    const last = st.sessions.h1!.lastHookAt!;
    replay([tx("h1", { turn: "waiting", turnAt: last + 1000 })], st);
    expect(st.sessions.h1!.status).toBe("working"); // the Stop hook is on its way
    replay([tx("h1", { turn: "waiting", turnAt: last + 60_000 })], st);
    expect(st.sessions.h1!.status).toBe("waiting"); // hooks stopped arriving; the transcript knows better
    expect(st.sessions.h1!.statusFrom).toBe("transcript");
  });

  it("links a subagent transcript to the Agent call that started it", () => {
    const st = replay([
      hook("UserPromptSubmit", { prompt: "go" }, "a1"),
      hook("PreToolUse", { tool_name: "Agent", tool_use_id: "toolu_1", tool_input: { description: "Find it", subagent_type: "Explore" } }, "a1"),
      agent("a1", { agentId: "abc", agentType: "Explore", description: "Find it", toolUseId: "toolu_1" }),
      agent("a1", { agentId: "wf1", workflowId: "wf_9", running: true }),
    ], emptyState());
    const s = st.sessions.a1!;
    expect(Object.keys(s.agents).sort()).toEqual(["abc", "wf1"]);
    expect(s.activeSubagents).toBe(2);
    replay([hook("PostToolUse", { tool_name: "Agent", tool_use_id: "toolu_1" }, "a1"), agent("a1", { agentId: "wf1", workflowId: "wf_9", running: false })], st);
    expect(s.activeSubagents).toBe(0);
    expect(s.subagentsTotal).toBe(2);
  });

  it("ignores internal SubagentStop events and stops typed ones", () => {
    const st = replay([
      hook("UserPromptSubmit", { prompt: "go" }, "a2"),
      agent("a2", { agentId: "bg1", running: true }),
      hook("SubagentStop", { agent_id: "bg1", agent_type: "" }, "a2"),
    ], emptyState());
    expect(st.sessions.a2!.agents.bg1!.running).toBe(true);
    replay([hook("SubagentStop", { agent_id: "bg1", agent_type: "general-purpose" }, "a2")], st);
    expect(st.sessions.a2!.agents.bg1!.running).toBe(false);
  });
});

describe("monograms", () => {
  it("keeps monograms unique within a workstream", () => {
    const st = emptyState();
    replay([
      { seq: ++seq, kind: "foundry", ts: 1, type: "workstream.created", id: "ds", name: "Design system", color: "#b38cff", area: { x: 0, y: 0, w: 10, h: 10 } },
      hook("UserPromptSubmit", { prompt: "Card spacing" }, "a"),
      hook("UserPromptSubmit", { prompt: "Card shadows" }, "b"),
      { seq: ++seq, kind: "foundry", ts: 2, type: "session.assigned", sessionId: "a", workstreamId: "ds" },
      { seq: ++seq, kind: "foundry", ts: 3, type: "session.assigned", sessionId: "b", workstreamId: "ds" },
    ] as LoggedEvent[], st);
    expect(st.sessions.a!.mono).toBe("Cs");
    expect(st.sessions.b!.mono).not.toBe("Cs");
  });
});
