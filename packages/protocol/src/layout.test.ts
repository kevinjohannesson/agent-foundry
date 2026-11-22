import { describe, expect, it } from "vitest";
import type { LoggedEvent } from "./events";
import { areaProblem, freeArea, layout, LOT_ID, placeProblem } from "./layout";
import { replay } from "./project";
import { emptyState, type FoundryState } from "./state";

let seq = 0;
const ev = (e: Record<string, unknown>): LoggedEvent => ({ seq: ++seq, ts: seq * 1000, ...e }) as LoggedEvent;
const prompt = (sid: string, text = `Work on ${sid}`) => ev({ kind: "hook", payload: { session_id: sid, hook_event_name: "UserPromptSubmit", prompt: text } });
const hook = (sid: string, name: string) => ev({ kind: "hook", payload: { session_id: sid, hook_event_name: name } });
const f = (type: string, e: Record<string, unknown>) => ev({ kind: "foundry", type, ...e });
const ws = (id: string, area: { x: number; y: number; w: number; h: number }) => f("workstream.created", { id, name: id.toUpperCase(), color: "#4fc3d9", area });
const at = (st: FoundryState, sid: string) => { const s = layout(st).spots[sid]; return s && [s.areaId, s.x, s.y, s.placed]; };

describe("layout", () => {
  it("packs unplaced sessions row by row, live ones before ended ones, oldest first", () => {
    const st = replay([prompt("a"), prompt("b"), hook("a", "SessionEnd"), prompt("c")], emptyState());
    // The lot is 21 wide: 7 slots of 3 tiles per row.
    expect(at(st, "b")).toEqual([LOT_ID, 0, 0, false]);
    expect(at(st, "c")).toEqual([LOT_ID, 3, 0, false]);
    expect(at(st, "a")).toEqual([LOT_ID, 6, 0, false]);
  });

  it("leaves pending and archived sessions off the map", () => {
    const st = replay([hook("ghost", "SessionStart"), prompt("a"), prompt("b"), f("session.archived", { sessionId: "a", handoff: false })], emptyState());
    expect(Object.keys(layout(st).spots)).toEqual(["b"]);
    expect(layout(st).areas[LOT_ID]!.sessions).toEqual(["b"]);
  });

  it("keeps placed sessions where you put them and packs the rest around them", () => {
    const st = replay([prompt("a"), prompt("b"), prompt("c"), f("session.moved", { sessionId: "c", x: 1, y: 0 })], emptyState());
    expect(at(st, "c")).toEqual([LOT_ID, 1, 0, true]);
    // (0,0) and (3,0) both touch c's slot at x 1..4.
    expect(at(st, "a")).toEqual([LOT_ID, 6, 0, false]);
    expect(at(st, "b")).toEqual([LOT_ID, 9, 0, false]);
  });

  it("grows an area downward when more is packed into it than it holds", () => {
    const evs = [ws("w", { x: 30, y: 0, w: 6, h: 3 })];
    for (const id of ["a", "b", "c"]) evs.push(prompt(id), f("session.assigned", { sessionId: id, workstreamId: "w" }));
    const st = replay(evs, emptyState());
    expect(at(st, "c")).toEqual(["w", 0, 3, false]);
    expect(layout(st).areas.w!.rect).toEqual({ x: 30, y: 0, w: 6, h: 6 });
    expect(layout(st).areas.w!.declared.h).toBe(3);
  });

  it("checks a spot: inside the area, and not on a placed session other than the one moving", () => {
    const st = replay([prompt("a"), prompt("b"), f("session.moved", { sessionId: "a", x: 3, y: 3 })], emptyState());
    expect(placeProblem(st, LOT_ID, 19, 0)).toBe("That spot is outside the area");
    expect(placeProblem(st, LOT_ID, -1, 0)).toBe("That spot is outside the area");
    expect(placeProblem(st, LOT_ID, 4, 4, "b")).toMatch(/already there/);
    expect(placeProblem(st, LOT_ID, 4, 4, "a")).toBeNull();
    // b is only packed at (0,0); packed sessions make room rather than block.
    expect(placeProblem(st, LOT_ID, 0, 0, "a")).toBeNull();
    expect(placeProblem(st, "nope", 0, 0)).toMatch(/no area/);
  });

  it("keeps areas apart and within bounds", () => {
    const st = replay([ws("w", { x: 30, y: 0, w: 9, h: 9 })], emptyState());
    expect(areaProblem(st, { x: 22, y: 0, w: 6, h: 6 })).toMatch(/Unassigned lot/);
    expect(areaProblem(st, { x: 23, y: 0, w: 5, h: 6 })).toBeNull();
    expect(areaProblem(st, { x: 23, y: 0, w: 6, h: 6 })).toMatch(/W/);
    expect(areaProblem(st, { x: 30, y: 0, w: 12, h: 9 }, "w")).toBeNull();
    expect(areaProblem(st, { x: 50, y: 0, w: 2, h: 9 })).toMatch(/at least/);
  });

  it("finds room for a new area next to the others, then on the next row", () => {
    const st = emptyState();
    expect(freeArea(st)).toEqual({ x: 23, y: 0, w: 15, h: 12 });
    const full = replay([ws("w1", { x: 23, y: 0, w: 76, h: 12 })], emptyState());
    // No room left in the first row of 100 tiles: the next free spot is under w1, beside the lot.
    expect(freeArea(full)).toEqual({ x: 23, y: 15, w: 15, h: 12 });
  });
});
