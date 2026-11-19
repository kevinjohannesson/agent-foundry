import { z } from "zod";
import { HookPayload } from "./hooks";

/**
 * Everything the core knows is an append-only list of these.
 * `hook` events come from Claude Code; `foundry` events come from you (through the UI) or the core itself,
 * including what its transcript tailer reads.
 */
export const HookEvent = z.object({
  kind: z.literal("hook"),
  ts: z.number(),
  payload: HookPayload,
});

/** What a transcript's last turn line says: a turn is running, or it ended and it's your move. */
export const TranscriptTurn = z.enum(["working", "waiting"]);
export type TranscriptTurn = z.infer<typeof TranscriptTurn>;

export const FoundryEvent = z.discriminatedUnion("type", [
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("workstream.created"), id: z.string(), name: z.string(), color: z.string(), area: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }) }),
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("session.assigned"), sessionId: z.string(), workstreamId: z.string().nullable() }),
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("session.moved"), sessionId: z.string(), x: z.number(), y: z.number() }),
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("session.renamed"), sessionId: z.string(), name: z.string(), mono: z.string().optional() }),
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("session.archived"), sessionId: z.string(), handoff: z.boolean() }),
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("session.restored"), sessionId: z.string() }),
  /**
   * What the transcript tailer read from a session file. Only fields that changed are set, except the timestamps.
   * `turn` is the state the transcript's last turn line implies, written at `turnAt`; it only wins over hook status
   * when it is newer than the last hook event (see transcriptTurnApplies).
   */
  z.object({
    kind: z.literal("foundry"), ts: z.number(), type: z.literal("transcript.observed"), sessionId: z.string(),
    transcriptPath: z.string(),
    entrypoint: z.string().optional(),
    title: z.string().optional(),
    cwd: z.string().optional(),
    lastPrompt: z.string().optional(),
    startedAt: z.number().optional(),
    lastActivityAt: z.number().optional(),
    turn: TranscriptTurn.optional(),
    turnAt: z.number().optional(),
  }),
  /** A subagent or workflow agent transcript, linked to its parent session. */
  z.object({
    kind: z.literal("foundry"), ts: z.number(), type: z.literal("transcript.agent"), sessionId: z.string(),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string().nullable(),
    toolUseId: z.string().nullable(),
    workflowId: z.string().nullable(),
    running: z.boolean(),
    startedAt: z.number(),
    lastActivityAt: z.number(),
  }),
]);

export const StoredEvent = z.union([HookEvent, ...FoundryEvent.options]);
export type HookEvent = z.infer<typeof HookEvent>;
export type FoundryEvent = z.infer<typeof FoundryEvent>;
export type StoredEvent = z.infer<typeof StoredEvent>;
/** A stored event plus its position in the log. */
export type LoggedEvent = StoredEvent & { seq: number };
