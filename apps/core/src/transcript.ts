/**
 * Reading Claude Code transcripts: which file is what, and what a session file's lines say.
 * Pure functions; the tailer does the file system work. Layout and line types are in docs/SPIKE.md.
 * Formats vary by Claude Code version, so every field is optional and unknown lines are skipped.
 */
import type { TranscriptTurn } from "@foundry/protocol";

export type FileKind =
  | { kind: "session"; sessionId: string }
  | { kind: "agent"; sessionId: string; agentId: string; workflowId: string | null };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION = new RegExp(`^[^/]+/(${UUID})\\.jsonl$`);
const AGENT = new RegExp(`^[^/]+/(${UUID})/subagents/(?:workflows/(wf_[^/]+)/)?agent-([^/]+)\\.jsonl$`);

/** Classifies a path relative to the projects folder (`/`-separated). Anything else is null. */
export function classify(rel: string): FileKind | null {
  let m = SESSION.exec(rel);
  if (m) return { kind: "session", sessionId: m[1]! };
  m = AGENT.exec(rel);
  if (m) return { kind: "agent", sessionId: m[1]!, agentId: m[3]!, workflowId: m[2] ?? null };
  return null;
}

/** What a session transcript has said so far. Later lines overwrite earlier ones. */
export interface SessionFacts {
  entrypoint?: string;
  cwd?: string;
  startedAt?: number;
  lastActivityAt?: number;
  customTitle?: string;
  agentName?: string;
  aiTitle?: string;
  lastPrompt?: string;
  turn?: TranscriptTurn;
  turnAt?: number;
}

/** Desktop (and a CLI rename) writes custom-title and agent-name; VS Code and the CLI write ai-title. */
export const titleOf = (f: SessionFacts) => f.customTitle ?? f.agentName ?? f.aiTitle;

const PROMPT_MAX = 500;
const WAITING_STOPS = new Set(["end_turn", "stop_sequence", "refusal"]);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).join(" ");
}

/** The turn a main-thread line implies, or undefined if it says nothing about the turn. */
function turnOf(o: Record<string, any>): TranscriptTurn | undefined {
  if (o.isSidechain || o.isMeta || o.isCompactSummary) return undefined;
  if (o.type === "assistant") {
    if (o.isApiErrorMessage) return "waiting";
    return WAITING_STOPS.has(o.message?.stop_reason) ? "waiting" : "working";
  }
  if (o.type === "user") {
    const text = textOf(o.message?.content).trimStart();
    if (text.startsWith("[Request interrupted")) return "waiting"; // you pressed Esc
    if (text.startsWith("<local-command-stdout>") || text.startsWith("<local-command-stderr>")) return "waiting"; // a local slash command finished
    if (text.startsWith("<command-name>")) return undefined; // a slash command; the expanded prompt or its output follows
    return "working"; // a prompt or a tool result
  }
  if (o.type === "system" && o.subtype === "turn_duration") return "waiting";
  return undefined;
}

/** Folds one parsed line into the facts. */
export function readLine(f: SessionFacts, o: unknown): void {
  if (!o || typeof o !== "object") return;
  const l = o as Record<string, any>;
  const ts = typeof l.timestamp === "string" ? Date.parse(l.timestamp) : NaN;
  if (!Number.isNaN(ts)) {
    f.startedAt ??= ts;
    if (!l.isSidechain) f.lastActivityAt = Math.max(f.lastActivityAt ?? 0, ts);
  }
  if (typeof l.entrypoint === "string" && !f.entrypoint) f.entrypoint = l.entrypoint;
  if (typeof l.cwd === "string" && l.cwd) f.cwd = l.cwd;
  switch (l.type) {
    case "custom-title": if (typeof l.customTitle === "string" && l.customTitle) f.customTitle = l.customTitle; return;
    case "agent-name": if (typeof l.agentName === "string" && l.agentName) f.agentName = l.agentName; return;
    case "ai-title": if (typeof l.aiTitle === "string" && l.aiTitle) f.aiTitle = l.aiTitle; return;
    case "last-prompt": if (typeof l.lastPrompt === "string" && l.lastPrompt) f.lastPrompt = l.lastPrompt.slice(0, PROMPT_MAX); return;
    case "relocated": if (typeof l.relocatedCwd === "string" && l.relocatedCwd) f.cwd = l.relocatedCwd; return;
  }
  const turn = turnOf(l);
  if (turn && !Number.isNaN(ts)) { f.turn = turn; f.turnAt = ts; }
}
