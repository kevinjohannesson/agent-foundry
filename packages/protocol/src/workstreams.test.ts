import { describe, expect, it } from "vitest";
import type { LoggedEvent } from "./events";
import { layout, LOT_ID } from "./layout";
import { replay } from "./project";
import { emptyState } from "./state";

let seq = 0;
const ev = (e: Record<string, unknown>): LoggedEvent => ({ seq: ++seq, ts: seq * 1000, ...e }) as LoggedEvent;
const prompt = (sid: string, text: string) => ev({ kind: "hook", payload: { session_id: sid, hook_event_name: "UserPromptSubmit", prompt: text } });
const f = (type: string, e: Record<string, unknown>) => ev({ kind: "foundry", type, ...e });
const area = { x: 30, y: 0, w: 15, h: 12 };

describe("workstreams, areas and pins", () => {
  it("creates a workstream with no link yet; events from before M2 make it a square", () => {
    const st = replay([
      f("workstream.created", { id: "ds", name: "Design system", color: "#b38cff", area }),
      f("workstream.created", { id: "ui", name: "Composable UI", color: "#4fc3d9", shape: "circle", area: { ...area, x: 50 } }),
    ], emptyState());
    expect(st.workstreams.ds).toEqual({ id: "ds", name: "Design system", color: "#b38cff", shape: "square", area, link: null });
    expect(st.workstreams.ui!.shape).toBe("circle");
  });

  it("updates a workstream's name, colour and shape, one field at a time", () => {
    const st = replay([
      f("workstream.created", { id: "ds", name: "Design system", color: "#b38cff", area }),
      f("workstream.updated", { id: "ds", name: "Tokens" }),
      f("workstream.updated", { id: "ds", shape: "hex" }),
      f("workstream.updated", { id: "gone", name: "x" }),
    ], emptyState());
    expect(st.workstreams.ds).toMatchObject({ name: "Tokens", color: "#b38cff", shape: "hex" });
    expect(st.workstreams.gone).toBeUndefined();
  });

  it("assigns with a spot, drops the spot when it changes area without one, and keeps it otherwise", () => {
    const st = replay([
      f("workstream.created", { id: "ds", name: "Design system", color: "#b38cff", area }),
      prompt("s", "Button tokens"),
      f("session.assigned", { sessionId: "s", workstreamId: "ds", position: { x: 3, y: 6 } }),
    ], emptyState());
    expect(st.sessions.s).toMatchObject({ workstreamId: "ds", position: { x: 3, y: 6 } });
    expect(layout(st).spots.s).toEqual({ areaId: "ds", x: 3, y: 6, placed: true });
    replay([f("session.assigned", { sessionId: "s", workstreamId: "ds" })], st);
    expect(st.sessions.s!.position).toEqual({ x: 3, y: 6 });
    replay([f("session.assigned", { sessionId: "s", workstreamId: null })], st);
    expect(st.sessions.s).toMatchObject({ workstreamId: null, position: null });
    // A workstream that doesn't exist puts it in the lot.
    replay([f("session.assigned", { sessionId: "s", workstreamId: "nope", position: { x: 0, y: 0 } })], st);
    expect(st.sessions.s!.workstreamId).toBeNull();
  });

  it("keeps monograms unique within the area a session moves into", () => {
    const st = replay([
      f("workstream.created", { id: "ds", name: "Design system", color: "#b38cff", area }),
      prompt("a", "Button tokens"),
      f("session.assigned", { sessionId: "a", workstreamId: "ds" }),
      prompt("b", "Button theme"),
    ], emptyState());
    expect(st.sessions.a!.mono).toBe("Bt");
    expect(st.sessions.b!.mono).toBe("Bt"); // unique in the lot, where nothing else has it
    replay([f("session.assigned", { sessionId: "b", workstreamId: "ds" })], st);
    expect(st.sessions.b!.mono).not.toBe("Bt");
  });

  it("moves an area with its sessions, and repacks the ones a smaller area no longer holds", () => {
    const st = replay([
      f("workstream.created", { id: "ds", name: "Design system", color: "#b38cff", area }),
      prompt("a", "One"), prompt("b", "Two"),
      f("session.assigned", { sessionId: "a", workstreamId: "ds", position: { x: 0, y: 0 } }),
      f("session.assigned", { sessionId: "b", workstreamId: "ds", position: { x: 9, y: 6 } }),
      f("area.set", { areaId: "ds", area: { x: 40, y: 20, w: 15, h: 12 } }),
    ], emptyState());
    expect(st.sessions.b!.position).toEqual({ x: 9, y: 6 });
    replay([f("area.set", { areaId: "ds", area: { x: 40, y: 20, w: 6, h: 6 } })], st);
    expect(st.sessions.a!.position).toEqual({ x: 0, y: 0 });
    expect(st.sessions.b!.position).toBeNull();
    expect(layout(st).spots.b).toEqual({ areaId: "ds", x: 3, y: 0, placed: false });
    replay([f("area.set", { areaId: LOT_ID, area: { x: -30, y: 0, w: 9, h: 9 } })], st);
    expect(st.lot.area).toEqual({ x: -30, y: 0, w: 9, h: 9 });
  });

  it("sends a removed workstream's sessions back to the lot", () => {
    const st = replay([
      f("workstream.created", { id: "ds", name: "Design system", color: "#b38cff", area }),
      prompt("a", "Button tokens"), prompt("b", "Button theme"),
      f("session.assigned", { sessionId: "a", workstreamId: "ds", position: { x: 3, y: 3 } }),
      f("workstream.removed", { id: "ds" }),
    ], emptyState());
    expect(st.workstreams.ds).toBeUndefined();
    expect(st.sessions.a).toMatchObject({ workstreamId: null, position: null });
    expect(st.sessions.a!.mono).not.toBe(st.sessions.b!.mono);
  });

  it("pins a session to one hotbar slot at a time, and ignores slots that don't exist", () => {
    const st = replay([
      prompt("a", "One"),
      f("pin.set", { slot: 0, ref: { kind: "session", id: "a" } }),
      f("pin.set", { slot: 4, ref: { kind: "session", id: "a" } }),
      f("pin.set", { slot: 12, ref: { kind: "session", id: "a" } }),
    ], emptyState());
    expect(st.pins).toHaveLength(10);
    expect(st.pins[0]).toBeNull();
    expect(st.pins[4]).toEqual({ kind: "session", id: "a" });
    replay([f("pin.set", { slot: 4, ref: null })], st);
    expect(st.pins.every((p) => p === null)).toBe(true);
  });
});
