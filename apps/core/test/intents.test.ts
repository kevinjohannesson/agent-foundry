import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layout, LOT_ID } from "@foundry/protocol";
import { Core } from "../src/core";
import { EventLog } from "../src/db";
import { createApp } from "../src/server";

const withSessions = (core: Core, ...ids: string[]) => {
  for (const id of ids) core.record({ kind: "hook", ts: Date.now(), payload: { session_id: id, hook_event_name: "UserPromptSubmit", prompt: `Work on ${id}` } });
  return core;
};
const fresh = (...ids: string[]) => withSessions(new Core(new EventLog(":memory:")), ...ids);

describe("intents", () => {
  it("creates workstreams next to the lot, with the next shape, and never with the lot's id", () => {
    const core = fresh();
    core.handle({ type: "createWorkstream", name: "Unassigned", color: "#b38cff" });
    core.handle({ type: "createWorkstream", name: "Composable UI", color: "#4fc3d9" });
    expect(Object.keys(core.state.workstreams)).toEqual(["unassigned-2", "composable-ui"]);
    expect(core.state.workstreams["unassigned-2"]).toMatchObject({ shape: "square", area: { x: 23, y: 0, w: 15, h: 12 }, link: null });
    expect(core.state.workstreams["composable-ui"]).toMatchObject({ shape: "circle", area: { x: 40, y: 0 } });
  });

  it("assigns by drag: checks the spot in the target area and records one event", () => {
    const core = fresh("a", "b");
    core.handle({ type: "createWorkstream", name: "DS", color: "#b38cff" });
    const seq = core.state.seq;
    expect(() => core.handle({ type: "assign", sessionId: "a", workstreamId: "ds", position: { x: 13, y: 0 } })).toThrow(/outside/);
    core.handle({ type: "assign", sessionId: "a", workstreamId: "ds", position: { x: 3, y: 3 } });
    expect(core.state.seq).toBe(seq + 1);
    expect(() => core.handle({ type: "assign", sessionId: "b", workstreamId: "ds", position: { x: 4, y: 4 } })).toThrow(/already there/);
    expect(() => core.handle({ type: "assign", sessionId: "b", workstreamId: "nope" })).toThrow(/No workstream/);
    expect(() => core.handle({ type: "assign", sessionId: "zz", workstreamId: null })).toThrow(/No session/);
    expect(layout(core.state).spots.a).toEqual({ areaId: "ds", x: 3, y: 3, placed: true });
    // Back to the lot by drag.
    core.handle({ type: "assign", sessionId: "a", workstreamId: null, position: { x: 18, y: 12 } });
    expect(layout(core.state).spots.a).toEqual({ areaId: LOT_ID, x: 18, y: 12, placed: true });
  });

  it("moves a session only within its own area", () => {
    const core = fresh("a");
    expect(() => core.handle({ type: "move", sessionId: "a", x: 20, y: 0 })).toThrow(/outside/);
    core.handle({ type: "move", sessionId: "a", x: 6, y: 9 });
    expect(core.state.sessions.a!.position).toEqual({ x: 6, y: 9 });
  });

  it("moves and resizes areas, but keeps them apart", () => {
    const core = fresh();
    core.handle({ type: "createWorkstream", name: "DS", color: "#b38cff" });
    expect(() => core.handle({ type: "setArea", areaId: "ds", area: { x: 10, y: 0, w: 15, h: 12 } })).toThrow(/Too close to the Unassigned lot/);
    expect(() => core.handle({ type: "setArea", areaId: LOT_ID, area: { x: 0, y: 0, w: 30, h: 15 } })).toThrow(/Too close to DS/);
    core.handle({ type: "setArea", areaId: LOT_ID, area: { x: 0, y: 0, w: 12, h: 30 } });
    expect(core.state.lot.area).toEqual({ x: 0, y: 0, w: 12, h: 30 });
    expect(() => core.handle({ type: "setArea", areaId: "nope", area: { x: 90, y: 0, w: 9, h: 9 } })).toThrow(/No workstream/);
  });

  it("updates and removes workstreams", () => {
    const core = fresh("a");
    core.handle({ type: "createWorkstream", name: "DS", color: "#b38cff" });
    core.handle({ type: "assign", sessionId: "a", workstreamId: "ds" });
    expect(() => core.handle({ type: "updateWorkstream", workstreamId: "ds" })).toThrow(/Nothing to change/);
    core.handle({ type: "updateWorkstream", workstreamId: "ds", name: "Design system", shape: "hex" });
    expect(core.state.workstreams.ds).toMatchObject({ name: "Design system", shape: "hex", color: "#b38cff" });
    core.handle({ type: "removeWorkstream", workstreamId: "ds" });
    expect(core.state.workstreams.ds).toBeUndefined();
    expect(core.state.sessions.a!.workstreamId).toBeNull();
  });

  it("pins only sessions it knows", () => {
    const core = fresh("a");
    core.handle({ type: "pin", slot: 2, ref: { kind: "session", id: "a" } });
    expect(core.state.pins[2]).toEqual({ kind: "session", id: "a" });
    expect(() => core.handle({ type: "pin", slot: 3, ref: { kind: "session", id: "zz" } })).toThrow(/No session/);
  });

  it("refuses bad intents over HTTP with a message", async () => {
    const app = createApp(fresh("a"));
    const post = async (b: unknown) => { const r = await app.request("/intents", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }); return [r.status, (await r.json()).error]; };
    expect(await post({ type: "move", sessionId: "a", x: 1.5, y: 0 })).toEqual([400, expect.any(String)]);
    expect(await post({ type: "createWorkstream", name: "DS", color: "purple" })).toEqual([400, "a colour is #rrggbb"]);
    expect(await post({ type: "move", sessionId: "a", x: 30, y: 0 })).toEqual([409, "That spot is outside the area"]);
  });
});

describe("layout across a restart", () => {
  it("rebuilds workstreams, assignments, spots, areas and pins from the log", () => {
    const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "f.db");
    const log = new EventLog(path);
    const a = withSessions(new Core(log), "a", "b", "c");
    a.handle({ type: "createWorkstream", name: "DS", color: "#b38cff", shape: "hex" });
    a.handle({ type: "assign", sessionId: "a", workstreamId: "ds", position: { x: 6, y: 3 } });
    a.handle({ type: "assign", sessionId: "b", workstreamId: "ds" });
    a.handle({ type: "move", sessionId: "c", x: 9, y: 6 });
    a.handle({ type: "setArea", areaId: "ds", area: { x: 25, y: 4, w: 12, h: 9 } });
    a.handle({ type: "pin", slot: 0, ref: { kind: "session", id: "a" } });
    log.close();
    const b = new Core(new EventLog(path));
    expect(b.state).toEqual(a.state);
    expect(layout(b.state)).toEqual(layout(a.state));
    expect(layout(b.state).spots).toMatchObject({
      a: { areaId: "ds", x: 6, y: 3, placed: true },
      b: { areaId: "ds", x: 0, y: 0, placed: false },
      c: { areaId: LOT_ID, x: 9, y: 6, placed: true },
    });
  });
});

describe("factory route", () => {
  it("serves the built factory under /factory, and says how to build it when it isn't", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-"));
    const app = createApp(fresh(), { factoryDir: dir });
    expect((await app.request("/factory")).headers.get("location")).toBe("/factory/");
    const missing = await app.request("/factory/");
    expect(missing.status).toBe(503);
    expect(await missing.text()).toMatch(/pnpm build:factory/);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    writeFileSync(join(dir, "index.html"), "<p>factory</p>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    expect(await (await app.request("/factory/")).text()).toBe("<p>factory</p>");
    const js = await app.request("/factory/assets/app.js");
    expect(js.headers.get("content-type")).toMatch(/javascript/);
  });
});
