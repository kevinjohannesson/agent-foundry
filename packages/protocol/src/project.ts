import type { LoggedEvent } from "./events";
import { SUBAGENT_TOOLS, type HookPayload } from "./hooks";
import { deriveMono, nameFromPrompt, nameFromTitle } from "./names";
import type { AgentState, FoundryState, NameSource, SessionState } from "./state";

/**
 * The projector: (state, event) -> state. Pure, so the core, tests and a browser replay all agree.
 * It mutates the state it is given; callers own the state object.
 */
export function apply(state: FoundryState, ev: LoggedEvent): FoundryState {
  state.seq = ev.seq;
  if (ev.kind === "hook") applyHook(state, ev.payload, ev.ts);
  else applyFoundry(state, ev);
  return state;
}

/**
 * How much newer than the last hook event a transcript turn line has to be to override the hook status.
 * Hooks and transcript lines for the same moment land within milliseconds of each other; a bigger gap means
 * hooks aren't arriving for this session (not installed when it started, or uninstalled since).
 */
export const HOOK_SLACK_MS = 5_000;

export function transcriptTurnApplies(s: Pick<SessionState, "lastHookAt">, turnAt: number): boolean {
  return s.lastHookAt === null || turnAt > s.lastHookAt + HOOK_SLACK_MS;
}

/**
 * A prompt that is one tagged block, like <cross-session-message …>…</cross-session-message> or <task-notification>,
 * was sent by another session or the app, not typed by you. It still starts a turn, but it isn't your last prompt.
 * (The transcript's last-prompt line skips these too.)
 */
export const isMachineMessage = (prompt: string) => /^\s*<([a-z][a-z0-9-]*)[\s>][\s\S]*<\/\1>\s*$/.test(prompt);

/** Notification types that don't need you. */
const BENIGN_NOTIFICATIONS = new Set(["auth_success"]);

const NAME_RANK: Record<NameSource, number> = { default: 0, prompt: 1, title: 2, set: 3 };

function takenMonos(state: FoundryState, workstreamId: string | null, except?: string): string[] {
  return Object.values(state.sessions)
    .filter((s) => s.workstreamId === workstreamId && s.id !== except && !s.archived)
    .map((s) => s.mono);
}

/** Names the session unless a better source already did. The first prompt names it; later prompts don't; titles follow the app. */
function setName(state: FoundryState, s: SessionState, name: string, source: NameSource) {
  if (NAME_RANK[source] < NAME_RANK[s.nameSource]) return;
  if (source === "prompt" && s.nameSource === "prompt") return;
  s.nameSource = source;
  if (s.name === name) return;
  s.name = name;
  s.mono = deriveMono(name, takenMonos(state, s.workstreamId, s.id));
}

function ensureSession(state: FoundryState, id: string, ts: number): SessionState {
  let s = state.sessions[id];
  if (!s) {
    s = {
      id, cwd: null, transcriptPath: null, entrypoint: null,
      name: "New session", nameSource: "default", title: null, mono: "", ticket: null, workstreamId: null,
      status: "idle", statusFrom: null, notification: null, lastPrompt: null, lastTool: null, toolCalls: 0, permissionMode: null,
      activeSubagents: 0, subagentsTotal: 0, agents: {}, position: null, archived: null,
      startedAt: ts, lastActivityAt: ts, lastHookAt: null, hasTranscript: false, pending: true,
    };
    s.mono = deriveMono(s.name, takenMonos(state, null));
    state.sessions[id] = s;
  }
  return s;
}

/** Keeps the counters renderers draw in step with `agents`. */
function countAgents(s: SessionState) {
  const all = Object.values(s.agents);
  s.subagentsTotal = all.length;
  s.activeSubagents = all.filter((a) => a.running).length;
}

function findAgent(s: SessionState, id: string | null | undefined, toolUseId: string | null | undefined): AgentState | undefined {
  if (id && s.agents[id]) return s.agents[id];
  if (toolUseId) return Object.values(s.agents).find((a) => a.toolUseId === toolUseId);
  return undefined;
}

/** The turn ended: agents it started in the foreground are done; background ones run on until they report. */
function endTurnAgents(s: SessionState) {
  for (const a of Object.values(s.agents)) if (!a.background) a.running = false;
}

/** A hook event says what the status is; even when it only confirms what the transcript said first, hooks now own it. */
function hookStatus(s: SessionState, status: SessionState["status"]) {
  s.status = status;
  s.statusFrom = "hooks";
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

function applyHook(state: FoundryState, p: HookPayload, ts: number) {
  const s = ensureSession(state, p.session_id, ts);
  s.lastActivityAt = Math.max(s.lastActivityAt, ts);
  s.lastHookAt = ts;
  if (p.cwd) s.cwd = p.cwd;
  if (p.transcript_path) s.transcriptPath = p.transcript_path;
  if (p.permission_mode) s.permissionMode = p.permission_mode;
  // Tool events inside a subagent carry its agent_id. They count, but they don't change the session's turn.
  const inAgent = p.agent_id ? s.agents[p.agent_id] : undefined;
  if (inAgent) inAgent.lastActivityAt = ts;
  switch (p.hook_event_name) {
    case "SessionStart":
      // Reopening a session (the desktop app always resumes) puts it back on your plate; a new one waits for its first prompt.
      if (s.status === "ended" || s.status === "idle") hookStatus(s, p.source === "resume" ? "waiting" : "idle");
      break;
    case "UserPromptSubmit":
      hookStatus(s, "working");
      s.notification = null;
      if (p.prompt && !isMachineMessage(p.prompt)) {
        s.lastPrompt = p.prompt;
        setName(state, s, nameFromPrompt(p.prompt), "prompt");
      }
      if (p.session_title) {
        s.title = p.session_title;
        setName(state, s, nameFromTitle(p.session_title), "title");
      }
      break;
    case "PreToolUse":
      s.toolCalls++;
      s.lastTool = p.tool_name ?? null;
      if (!p.agent_id) { hookStatus(s, "working"); s.notification = null; }
      if (p.tool_name && SUBAGENT_TOOLS.has(p.tool_name) && !findAgent(s, null, p.tool_use_id)) {
        // A placeholder until the tailer links the agent's transcript by this tool_use_id.
        const input = (p.tool_input ?? {}) as Record<string, unknown>;
        const id = p.tool_use_id ?? `call-${ts}-${s.toolCalls}`;
        s.agents[id] = {
          id, type: str(input.subagent_type) ?? "general-purpose", description: str(input.description),
          toolUseId: p.tool_use_id ?? null, workflowId: null, background: input.run_in_background === true,
          running: true, startedAt: ts, lastActivityAt: ts,
        };
        countAgents(s);
      }
      break;
    case "PostToolUse":
    case "PostToolUseFailure": // a failed call gets this instead of PostToolUse
      if (p.tool_name && SUBAGENT_TOOLS.has(p.tool_name)) {
        const a = p.tool_use_id
          ? findAgent(s, null, p.tool_use_id)
          : Object.values(s.agents).find((x) => x.running && !x.background && !x.workflowId);
        // A background launch returns at once; that agent runs on until SubagentStop or its transcript says it finished.
        if (a && (!a.background || p.hook_event_name === "PostToolUseFailure")) a.running = false;
        countAgents(s);
      }
      break;
    case "SubagentStop": {
      // An empty agent_type is one of Claude Code's internal agents (no transcript, mostly right after a Stop): ignore it.
      if (!p.agent_type) break;
      const a = findAgent(s, p.agent_id, null);
      if (a) { a.running = false; countAgents(s); }
      break;
    }
    case "Notification":
      if (p.notification_type && BENIGN_NOTIFICATIONS.has(p.notification_type)) break;
      hookStatus(s, "needs_you");
      s.notification = p.message ?? "Claude Code needs you";
      break;
    case "Stop":
      hookStatus(s, "waiting");
      endTurnAgents(s);
      countAgents(s);
      break;
    case "StopFailure": // the turn ended on an API error instead of a Stop
      hookStatus(s, "needs_you");
      s.notification = `Turn failed: ${typeof p.error === "string" ? p.error : "API error"}`;
      endTurnAgents(s);
      countAgents(s);
      break;
    case "SessionEnd":
      // A session still pending here is usually a pre-warmed ghost. It stays hidden rather than deleted: the tailer may
      // not have read its transcript yet (the core was down, or the spool is being drained), and then it really ended.
      hookStatus(s, "ended");
      for (const a of Object.values(s.agents)) a.running = false;
      countAgents(s);
      break;
    default:
      break; // SubagentStart, PermissionRequest/Denied, Pre/PostCompact, CwdChanged and future events: recorded, not projected yet
  }
  updatePending(s);
}

function updatePending(s: SessionState) {
  s.pending = !s.hasTranscript && !s.lastPrompt && s.toolCalls === 0;
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
      s.name = ev.name; s.nameSource = "set";
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
    case "transcript.observed": {
      const isNew = !state.sessions[ev.sessionId];
      const s = ensureSession(state, ev.sessionId, ev.startedAt ?? ev.ts);
      if (isNew) s.lastActivityAt = ev.lastActivityAt ?? s.startedAt;
      s.hasTranscript = true;
      s.transcriptPath = ev.transcriptPath;
      if (ev.entrypoint) s.entrypoint = ev.entrypoint;
      if (ev.cwd) s.cwd = ev.cwd;
      if (ev.lastPrompt) {
        s.lastPrompt = ev.lastPrompt;
        setName(state, s, nameFromPrompt(ev.lastPrompt), "prompt");
      }
      if (ev.title) {
        s.title = ev.title;
        setName(state, s, nameFromTitle(ev.title), "title");
      }
      if (ev.startedAt !== undefined) s.startedAt = Math.min(s.startedAt, ev.startedAt);
      if (ev.lastActivityAt !== undefined) s.lastActivityAt = Math.max(s.lastActivityAt, ev.lastActivityAt);
      if (ev.turn && ev.turnAt !== undefined && transcriptTurnApplies(s, ev.turnAt) && s.status !== ev.turn) {
        s.status = ev.turn;
        s.statusFrom = "transcript";
        s.notification = null;
        if (ev.turn === "waiting") { endTurnAgents(s); countAgents(s); }
      }
      updatePending(s);
      break;
    }
    case "transcript.agent": {
      const s = ensureSession(state, ev.sessionId, ev.startedAt);
      let a = findAgent(s, ev.agentId, ev.toolUseId);
      if (a && a.id !== ev.agentId) { delete s.agents[a.id]; a.id = ev.agentId; } // link the hook placeholder to its transcript
      a ??= {
        id: ev.agentId, type: ev.agentType, description: null, toolUseId: null, workflowId: null,
        background: false, running: ev.running, startedAt: ev.startedAt, lastActivityAt: ev.lastActivityAt,
      };
      a.type = ev.agentType;
      a.description = ev.description ?? a.description;
      a.toolUseId = ev.toolUseId ?? a.toolUseId;
      a.workflowId = ev.workflowId;
      a.running = ev.running;
      a.startedAt = Math.min(a.startedAt, ev.startedAt);
      a.lastActivityAt = Math.max(a.lastActivityAt, ev.lastActivityAt);
      s.agents[ev.agentId] = a;
      s.lastActivityAt = Math.max(s.lastActivityAt, ev.lastActivityAt);
      countAgents(s);
      break;
    }
  }
}

export function replay(events: LoggedEvent[], state: FoundryState): FoundryState {
  for (const e of events) apply(state, e);
  return state;
}
