/**
 * The projected state every renderer draws from.
 * Renderers never compute status themselves; they read it from here.
 */
export type SessionStatus =
  | "idle" // started, no prompt yet
  | "working" // a turn is running
  | "waiting" // the turn ended; it's your move
  | "needs_you" // Claude Code raised a notification (permission prompt or idle reminder), or the turn failed
  | "ended"; // the process ended

export interface SessionState {
  id: string;
  cwd: string | null;
  transcriptPath: string | null;
  /** Short human name, e.g. "Button tokens". */
  name: string;
  /** Two letters derived from the name, unique within its workstream. */
  mono: string;
  /** Tracker id if there is one. */
  ticket: string | null;
  workstreamId: string | null;
  status: SessionStatus;
  notification: string | null;
  lastPrompt: string | null;
  lastTool: string | null;
  toolCalls: number;
  /** Subagents running right now (rendered as bots). */
  activeSubagents: number;
  subagentsTotal: number;
  position: { x: number; y: number } | null;
  archived: { at: number; handoff: boolean } | null;
  startedAt: number;
  lastActivityAt: number;
  /** True once a name was set by you or a controller, so prompts stop renaming it. */
  named: boolean;
}

export interface Workstream {
  id: string;
  name: string;
  color: string;
  area: { x: number; y: number; w: number; h: number };
}

export interface FoundryState {
  seq: number;
  sessions: Record<string, SessionState>;
  workstreams: Record<string, Workstream>;
}

export const emptyState = (): FoundryState => ({ seq: 0, sessions: {}, workstreams: {} });
