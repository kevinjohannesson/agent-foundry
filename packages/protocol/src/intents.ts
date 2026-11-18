import { z } from "zod";

/** What a renderer may ask the core to do. The core turns accepted intents into foundry events. */
export const Intent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("assign"), sessionId: z.string(), workstreamId: z.string().nullable() }),
  z.object({ type: z.literal("move"), sessionId: z.string(), x: z.number().int(), y: z.number().int() }),
  z.object({ type: z.literal("rename"), sessionId: z.string(), name: z.string().min(1).max(40), mono: z.string().length(2).optional() }),
  z.object({ type: z.literal("archive"), sessionId: z.string(), handoff: z.boolean() }),
  z.object({ type: z.literal("restore"), sessionId: z.string() }),
  z.object({ type: z.literal("createWorkstream"), name: z.string().min(1).max(40), color: z.string(), area: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().positive(), h: z.number().int().positive() }) }),
]);
export type Intent = z.infer<typeof Intent>;

/** Messages on the WebSocket from core to renderer. */
export type ServerMessage =
  | { type: "snapshot"; state: import("./state").FoundryState }
  | { type: "event"; event: import("./events").LoggedEvent; state: import("./state").FoundryState }
  | { type: "error"; message: string };
