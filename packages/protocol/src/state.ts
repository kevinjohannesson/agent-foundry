/**
 * The projected state every renderer draws from.
 * Renderers never compute status themselves; they read it from here.
 */
export type SessionStatus =
  | "idle" // a new session, no prompt yet
  | "working" // a turn is running
  | "waiting" // the turn ended, or you reopened a session: it's your move
  | "needs_you" // Claude Code raised a notification (permission prompt or idle reminder), or the turn failed
  | "ended"; // the process ended

/** Where the session's name came from. A later source only replaces an earlier one in this order. */
export type NameSource =
  | "default" // nothing yet: "New session"
  | "prompt" // the first prompt
  | "title" // the app's title (desktop custom title, VS Code and CLI AI title)
  | "set"; // you or a controller renamed it; nothing replaces this

/** A subagent or workflow agent of a session (rendered as a bot). */
export interface AgentState {
  /** The agent id from its transcript (`agent-<id>.jsonl`), or the Agent tool_use id until the transcript links it. */
  id: string;
  /** e.g. "general-purpose", "Explore". */
  type: string;
  description: string | null;
  /** The parent's Agent tool_use id; null for workflow agents. */
  toolUseId: string | null;
  /** Set for agents a workflow started. */
  workflowId: string | null;
  /** Started with run_in_background, so it can outlive the turn. */
  background: boolean;
  running: boolean;
  startedAt: number;
  lastActivityAt: number;
}

export interface SessionState {
  id: string;
  cwd: string | null;
  transcriptPath: string | null;
  /** Which app runs it: "claude-desktop", "claude-vscode", "cli" or "sdk-cli". From the transcript; hooks don't say. */
  entrypoint: string | null;
  /** Short human name, e.g. "Button tokens". */
  name: string;
  nameSource: NameSource;
  /** The app's own title for the session, full length. */
  title: string | null;
  /** Two letters derived from the name, unique within its workstream. */
  mono: string;
  /** Tracker id if there is one. */
  ticket: string | null;
  /** The workstream it belongs to; null puts it in the Unassigned lot. */
  workstreamId: string | null;
  status: SessionStatus;
  /** What last set the status: a hook event, or the transcript (when hooks aren't arriving for it). */
  statusFrom: "hooks" | "transcript" | null;
  notification: string | null;
  lastPrompt: string | null;
  lastTool: string | null;
  toolCalls: number;
  permissionMode: string | null;
  /** Subagents running right now (rendered as bots). Always the number of running entries in `agents`. */
  activeSubagents: number;
  subagentsTotal: number;
  agents: Record<string, AgentState>;
  /**
   * Where you put it, in tiles from the top-left of its area (its workstream, or the lot), so moving an area carries
   * its sessions along. Null until you place it: renderers then pack it into the area's first free slot (see layout.ts).
   */
  position: { x: number; y: number } | null;
  archived: { at: number; handoff: boolean } | null;
  startedAt: number;
  lastActivityAt: number;
  /** When the last hook event arrived, of any kind. */
  lastHookAt: number | null;
  /**
   * When a hook last spoke for the session's own turn. Subagents' events and Claude Code's internal agents don't count.
   * A transcript turn newer than this wins over the hook status (hooks missing or stopped, or an interrupt).
   */
  turnHookAt: number | null;
  /** The tailer has read this session's transcript. */
  hasTranscript: boolean;
  /**
   * Nothing real has happened yet: no prompt, no tool call, no transcript.
   * Renderers hide pending sessions. One that ends while still pending was a pre-warmed ghost and stays hidden.
   */
  pending: boolean;
}

/** A rectangle on the map, in tiles. */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How a workstream's sessions and items are drawn, so areas can be told apart without colour. */
export const SHAPES = ["square", "circle", "triangle", "hex"] as const;
export type Shape = (typeof SHAPES)[number];

/**
 * Something outside the foundry a workstream stands for. Nothing sets it yet: it is here so a workstream can later be
 * linked to a Claude Project (which may become its controller; decided before M3) without changing the state's shape.
 */
export interface WorkstreamLink {
  kind: "claude-project";
  url: string;
}

export interface Workstream {
  id: string;
  name: string;
  color: string;
  shape: Shape;
  area: Area;
  link: WorkstreamLink | null;
}

/** What a hotbar slot holds. Sessions for now; proposals join in M3. */
export type PinRef = { kind: "session"; id: string };
export const HOTBAR_SLOTS = 10;

export interface FoundryState {
  seq: number;
  sessions: Record<string, SessionState>;
  workstreams: Record<string, Workstream>;
  /** The Unassigned lot: where sessions that belong to no workstream sit. */
  lot: { area: Area };
  /** The hotbar, one entry per slot (keys 1-9, then 0). */
  pins: (PinRef | null)[];
}

/** Where the lot starts out, before you move it. */
export const DEFAULT_LOT_AREA: Area = { x: 0, y: 0, w: 21, h: 15 };

export const emptyState = (): FoundryState => ({
  seq: 0, sessions: {}, workstreams: {}, lot: { area: { ...DEFAULT_LOT_AREA } }, pins: Array(HOTBAR_SLOTS).fill(null),
});
