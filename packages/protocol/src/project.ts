import type { LoggedEvent } from "./events";
import { SUBAGENT_TOOLS } from "./hooks";
import { deriveMono, nameFromPrompt } from "./names";
import type { FoundryState, SessionState } from "./state";

/**
 * The projector: (state, event) -> state. Pure, so the core, tests and a browser replay all agree.
 * It mutates a structured clone of nothing; callers own the state object.
 */
export function apply(state: FoundryState, ev: LoggedEvent): FoundryState {
  state.seq = ev.seq;
  if (ev.kind === "hook") applyHook(state, ev.payload, ev.ts);
  else applyFoundry(state, ev);
  return state;
}

function takenMonos(state: FoundryState, workstreamId: string | null, except?: string): string[] {
  return Object.values(state.sessions)
    .filter((s) => s.workstreamId === workstreamId && s.id !== except && !s.archived)
    .map((s) => s.mono);
}

function ensureSession(state: FoundryState, id: string, ts: number): SessionState {
  let s = state.sessions[id];
  if (!s) {
    s = {
      id, cwd: null, transcriptPath: null, name: "New session", mono: "", ticket: null, workstreamId: null,
      status: "idle", notification: null, lastPrompt: null, lastTool: null, toolCalls: 0,
      activeSubagents: 0, subagentsTotal: 0, position: null, archived: null,
      startedAt: ts, lastActivityAt: ts, named: false,
    };
    s.mono = deriveMono(s.name, takenMonos(state, null));
    state.sessions[id] = s;
  }
  return s;
}

function applyHook(state: FoundryState, p: import("./hooks").HookPayload, ts: number) {
  const s = ensureSession(state, p.session_id, ts);
  s.lastActivityAt = ts;
  if (p.cwd) s.cwd = p.cwd;
  if (p.transcript_path) s.transcriptPath = p.transcript_path;
  switch (p.hook_event_name) {
    case "SessionStart":
      if (s.status === "ended" || s.status === "idle") s.status = "idle";
      break;
    case "UserPromptSubmit":
      s.status = "working";
      s.notification = null;
      if (p.prompt) {
        s.lastPrompt = p.prompt;
        if (!s.named) {
          s.name = nameFromPrompt(p.prompt);
          s.mono = deriveMono(s.name, takenMonos(state, s.workstreamId, s.id));
          s.named = true; // first prompt names it; later prompts don't rename
        }
      }
      break;
    case "PreToolUse":
      s.status = "working";
      s.notification = null;
      s.toolCalls++;
      s.lastTool = p.tool_name ?? null;
      if (p.tool_name && SUBAGENT_TOOLS.has(p.tool_name)) { s.activeSubagents++; s.subagentsTotal++; }
      break;
    case "PostToolUse":
      if (p.tool_name && SUBAGENT_TOOLS.has(p.tool_name)) s.activeSubagents = Math.max(0, s.activeSubagents - 1);
      break;
    case "Notification":
      s.status = "needs_you";
      s.notification = p.message ?? "Claude Code needs you";
      break;
    case "Stop":
      s.status = "waiting";
      s.activeSubagents = 0;
      break;
    case "SessionEnd":
      s.status = "ended";
      s.activeSubagents = 0;
      break;
    default:
      break; // SubagentStop, PreCompact and future events: recorded, not projected yet
  }
}

function applyFoundry(state: FoundryState, ev: Extract<LoggedEvent, { kind: "foundry" }>) {
  switch (ev.type) {
    case "workstream.created":
      state.workstreams[ev.id] = { id: ev.id, name: ev.name, color: ev.color, area: ev.area };
      break;
    case "session.assigned": {
      const s = state.sessions[ev.sessionId]; if (!s) return;
      s.workstreamId = ev.workstreamId;
      if (takenMonos(state, s.workstreamId, s.id).some((m) => m.toLowerCase() === s.mono.toLowerCase()))
        s.mono = deriveMono(s.name, takenMonos(state, s.workstreamId, s.id));
      break;
    }
    case "session.moved": {
      const s = state.sessions[ev.sessionId]; if (s) s.position = { x: ev.x, y: ev.y };
      break;
    }
    case "session.renamed": {
      const s = state.sessions[ev.sessionId]; if (!s) return;
      s.name = ev.name; s.named = true;
      s.mono = ev.mono ?? deriveMono(ev.name, takenMonos(state, s.workstreamId, s.id));
      break;
    }
    case "session.archived": {
      const s = state.sessions[ev.sessionId]; if (s) s.archived = { at: ev.ts, handoff: ev.handoff };
      break;
    }
    case "session.restored": {
      const s = state.sessions[ev.sessionId]; if (s) s.archived = null;
      break;
    }
  }
}

export function replay(events: LoggedEvent[], state: FoundryState): FoundryState {
  for (const e of events) apply(state, e);
  return state;
}
