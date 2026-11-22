import { z } from "zod";
import { PinRefSchema, ShapeSchema } from "./events";
import { HOTBAR_SLOTS } from "./state";

const tile = z.number().int();
const Position = z.object({ x: tile, y: tile });
const Area = z.object({ x: tile, y: tile, w: tile.positive(), h: tile.positive() });
const Color = z.string().regex(/^#[0-9a-f]{6}$/i, "a colour is #rrggbb");
const Name = z.string().trim().min(1).max(40);

/**
 * What a renderer may ask the core to do. The core checks each one against the state (see layout.ts) and turns it
 * into foundry events, or refuses it with a message the renderer can show.
 */
export const Intent = z.discriminatedUnion("type", [
  /** Into a workstream, or back to the Unassigned lot (null). With a position it lands there; without one it is packed. */
  z.object({ type: z.literal("assign"), sessionId: z.string(), workstreamId: z.string().nullable(), position: Position.optional() }),
  /** To another spot in the area it is already in. */
  z.object({ type: z.literal("move"), sessionId: z.string(), x: tile, y: tile }),
  z.object({ type: z.literal("rename"), sessionId: z.string(), name: Name, mono: z.string().length(2).optional() }),
  z.object({ type: z.literal("archive"), sessionId: z.string(), handoff: z.boolean() }),
  z.object({ type: z.literal("restore"), sessionId: z.string() }),
  /** Without an area the core finds a free spot next to the others; without a shape it picks the next one. */
  z.object({ type: z.literal("createWorkstream"), name: Name, color: Color, shape: ShapeSchema.optional(), area: Area.optional() }),
  z.object({ type: z.literal("updateWorkstream"), workstreamId: z.string(), name: Name.optional(), color: Color.optional(), shape: ShapeSchema.optional() }),
  /** Its sessions go back to the lot. */
  z.object({ type: z.literal("removeWorkstream"), workstreamId: z.string() }),
  /** Moves or resizes the lot ("unassigned") or a workstream's area. */
  z.object({ type: z.literal("setArea"), areaId: z.string(), area: Area }),
  /** Puts a session in a hotbar slot (0-9), or empties the slot. */
  z.object({ type: z.literal("pin"), slot: z.number().int().min(0).max(HOTBAR_SLOTS - 1), ref: PinRefSchema.nullable() }),
]);
export type Intent = z.infer<typeof Intent>;

/** Messages on the WebSocket from core to renderer. */
export type ServerMessage =
  | { type: "snapshot"; state: import("./state").FoundryState }
  | { type: "event"; event: import("./events").LoggedEvent; state: import("./state").FoundryState }
  | { type: "error"; message: string };
