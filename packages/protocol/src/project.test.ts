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
