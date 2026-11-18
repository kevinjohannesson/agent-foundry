import { z } from "zod";
import { HookPayload } from "./hooks";

/**
 * Everything the core knows is an append-only list of these.
 * `hook` events come from Claude Code; `foundry` events come from you (through the UI) or the core itself.
 */
export const HookEvent = z.object({
  kind: z.literal("hook"),
  ts: z.number(),
  payload: HookPayload,
});

export const FoundryEvent = z.discriminatedUnion("type", [
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("workstream.created"), id: z.string(), name: z.string(), color: z.string(), area: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }) }),
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("session.assigned"), sessionId: z.string(), workstreamId: z.string().nullable() }),
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("session.moved"), sessionId: z.string(), x: z.number(), y: z.number() }),
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("session.renamed"), sessionId: z.string(), name: z.string(), mono: z.string().optional() }),
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("session.archived"), sessionId: z.string(), handoff: z.boolean() }),
  z.object({ kind: z.literal("foundry"), ts: z.number(), type: z.literal("session.restored"), sessionId: z.string() }),
]);

export const StoredEvent = z.union([HookEvent, ...FoundryEvent.options]);
export type HookEvent = z.infer<typeof HookEvent>;
export type FoundryEvent = z.infer<typeof FoundryEvent>;
export type StoredEvent = z.infer<typeof StoredEvent>;
/** A stored event plus its position in the log. */
export type LoggedEvent = StoredEvent & { seq: number };
