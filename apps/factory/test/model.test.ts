import { describe, expect, it } from "vitest";
import { emptyState, LOT_ID, replay, type FoundryState, type LoggedEvent } from "@foundry/protocol";
import { buildModel, folder, hitTest, planArea, planDrop } from "../src/model";

let seq = 0;
const ev = (e: Record<string, unknown>): LoggedEvent => ({ seq: ++seq, ts: seq * 1000, ...e }) as LoggedEvent;
const hook = (sid: string, name: string, extra: Record<string, unknown> = {}) => ev({ kind: "hook", payload: { session_id: sid, hook_event_name: name, ...extra } });
const prompt = (sid: string, text = `Work on ${sid}`) => hook(sid, "UserPromptSubmit", { prompt: text });
const f = (type: string, e: Record<string, unknown>) => ev({ kind: "foundry", type, ...e });
// The lot is at 0,0 (21 x 15); "ds" sits to its right at 30,0 (15 x 12).
const world = (...more: LoggedEvent[]): FoundryState => replay([
  f("workstream.created", { id: "ds", name: "Design system", color: "#b38cff", shape: "circle", area: { x: 30, y: 0, w: 15, h: 12 } }),
  prompt("a"), prompt("b"), prompt("c"), ...more,
], emptyState());

describe("the factory's model of the state", () => {
  it("puts every session on the map in an area, with counts, alerts and pins", () => {
    const st = world(
      hook("a", "Notification", { message: "Claude needs your permission to use Bash" }),
      hook("b", "Stop"),
      hook("c", "PreToolUse", { tool_name: "Agent", tool_use_id: "t1", tool_input: { subagent_type: "Explore" } }),
      f("session.assigned", { sessionId: "c", workstreamId: "ds", position: { x: 3, y: 3 } }),
      f("pin.set", { slot: 0, ref: { kind: "session", id: "c" } }),
      hook("ghost", "SessionStart"),
    );
    const m = buildModel(st);
    expect(m.areas.map((a) => a.id)).toEqual([LOT_ID, "ds"]);
    expect(m.machine.c).toMatchObject({ areaId: "ds", x: 33, y: 3, rx: 3, ry: 3, placed: true, color: "#b38cff", shape: "circle" });
    expect(m.machine.c!.bots.map((b) => b.id)).toEqual(["t1"]);
    expect(m.machine.ghost).toBeUndefined();
    expect(m.area[LOT_ID]!.counts).toMatchObject({ needsYou: 1, yourMove: 1, working: 0 });
    expect(m.area.ds!.counts).toMatchObject({ working: 1, bots: 1 });
    expect(m.needsYou).toEqual(["a"]);
    expect(m.yourMove).toEqual(["b"]);
    expect(m.pins[0]?.id).toBe("c");
    expect(m.bounds).toEqual({ x: 0, y: 0, w: 45, h: 15 });
  });

  it("files archived sessions in their area's chest", () => {
    const st = world(f("session.assigned", { sessionId: "a", workstreamId: "ds" }), f("session.archived", { sessionId: "a", handoff: false }));
    const m = buildModel(st);
    expect(m.machine.a).toBeUndefined();
    expect(m.area.ds!.archived).toEqual(["a"]);
    expect(m.area[LOT_ID]!.archived).toEqual([]);
  });

  it("finds what is under the pointer: a machine, a chest, an area's label or corner", () => {
    const m = buildModel(world());
    expect(hitTest(m, 1, 1)).toEqual({ kind: "machine", id: "a" });
    expect(hitTest(m, 44.5, -0.5)).toEqual({ kind: "chest", id: "ds" });
    expect(hitTest(m, 31, -0.5)).toEqual({ kind: "label", id: "ds" });
    expect(hitTest(m, 44.5, 11.5)).toEqual({ kind: "grip", id: "ds" });
    expect(hitTest(m, 35, 6)).toEqual({ kind: "area", id: "ds" });
    expect(hitTest(m, 25, 6)).toBeNull();
  });

  it("turns a drop into an assign, a move, nothing, or a refusal", () => {
    const st = world();
    const m = buildModel(st);
    // Into another area: one assign with the spot under the pointer (the slot is centred on it).
    expect(planDrop(st, m, "a", 36.5, 4.5)).toMatchObject({ areaId: "ds", x: 5, y: 3, problem: null,
      intent: { type: "assign", sessionId: "a", workstreamId: "ds", position: { x: 5, y: 3 } } });
    // Within its own area: a move. Near the edge it is nudged inside.
    expect(planDrop(st, m, "a", 20.9, 14.9)?.intent).toEqual({ type: "move", sessionId: "a", x: 18, y: 12 });
    // Back where it already is: nothing to send.
    expect(planDrop(st, m, "a", 1.5, 1.5)).toMatchObject({ intent: null, problem: null });
    // Onto another session, even a packed one: refused here rather than shoving it along.
    expect(planDrop(st, m, "a", 4.5, 1.5)).toMatchObject({ intent: null, problem: "Something is already there" });
    // Outside every area.
    expect(planDrop(st, m, "a", 25, 6)).toBeNull();
  });

  it("drops a session from a workstream back into the lot", () => {
    const st = world(f("session.assigned", { sessionId: "a", workstreamId: "ds" }));
    expect(planDrop(st, buildModel(st), "a", 10.5, 10.5)?.intent).toEqual({ type: "assign", sessionId: "a", workstreamId: null, position: { x: 9, y: 9 } });
  });

  it("plans moving and resizing an area, and refuses one that crowds another", () => {
    const st = world();
    const m = buildModel(st);
    expect(planArea(st, m, "ds", "move", 2.4, 3.6, 0, 0)).toMatchObject({ area: { x: 32, y: 4, w: 15, h: 12 }, problem: null, intent: { type: "setArea", areaId: "ds" } });
    expect(planArea(st, m, "ds", "move", -8, 0, 0, 0)).toMatchObject({ intent: null, problem: "Too close to the Unassigned lot" });
    expect(planArea(st, m, "ds", "resize", 0, 0, 40.2, 8.7)).toMatchObject({ area: { x: 30, y: 0, w: 10, h: 9 }, problem: null });
    expect(planArea(st, m, "ds", "resize", 0, 0, 30.5, 0.5).area).toMatchObject({ w: 3, h: 3 });
    expect(planArea(st, m, "ds", "move", 0.2, -0.3, 0, 0)).toMatchObject({ intent: null, problem: null });
  });

  it("shortens folders the way the table does", () => {
    expect(folder("/Users/me/Projects/agent-foundry/.claude/worktrees/brave-otter")).toBe("agent-foundry ⎇ brave-otter");
    expect(folder("/Users/me/Projects/site")).toBe("site");
    expect(folder(null)).toBe("—");
  });
});
