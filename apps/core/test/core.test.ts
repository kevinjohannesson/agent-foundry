import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Core } from "../src/core";
import { EventLog } from "../src/db";
import { createApp } from "../src/server";

const fresh = () => new Core(new EventLog(":memory:"));
const hookBody = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: "hook", ts: Date.now(), payload: { session_id: "s1", hook_event_name: name, cwd: "/repo", ...extra } });

describe("core over HTTP", () => {
  it("ingests hooks and projects state", async () => {
    const app = createApp(fresh());
    await app.request("/hooks", { method: "POST", body: hookBody("UserPromptSubmit", { prompt: "Extract Toolbar slots" }), headers: { "content-type": "application/json" } });
    await app.request("/hooks", { method: "POST", body: hookBody("Stop"), headers: { "content-type": "application/json" } });
    const st = await (await app.request("/state")).json();
    expect(st.sessions.s1.name).toBe("Extract Toolbar slots");
    expect(st.sessions.s1.status).toBe("waiting");
  });

  it("rejects a bad hook payload without recording it", async () => {
    const core = fresh();
    const res = await createApp(core).request("/hooks", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(core.state.seq).toBe(0);
  });

  it("turns intents into events", async () => {
    const core = fresh();
    const app = createApp(core);
    await app.request("/hooks", { method: "POST", body: hookBody("SessionStart"), headers: { "content-type": "application/json" } });
    const post = (b: unknown) => app.request("/intents", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });
    expect((await post({ type: "createWorkstream", name: "Composable UI", color: "#4fc3d9", area: { x: 2, y: 22, w: 22, h: 13 } })).status).toBe(200);
    expect((await post({ type: "assign", sessionId: "s1", workstreamId: "composable-ui" })).status).toBe(200);
    expect((await post({ type: "assign", sessionId: "nope", workstreamId: null })).status).toBe(409);
    expect(core.state.sessions.s1!.workstreamId).toBe("composable-ui");
  });
});

describe("persistence", () => {
  it("rebuilds the same state from the log on restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-"));
    const path = join(dir, "f.db");
    const a = new Core(new EventLog(path));
    a.record({ kind: "hook", ts: 1, payload: { session_id: "x", hook_event_name: "UserPromptSubmit", prompt: "Card spacing scale" } });
    const b = new Core(new EventLog(path));
    expect(b.state).toEqual(a.state);
  });

  it("drains the spool in order and moves it aside", () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-"));
    const spool = join(dir, "spool.jsonl");
    writeFileSync(spool, [hookBody("UserPromptSubmit", { prompt: "Popover primitive" }), hookBody("Stop"), '{"kind":"hook","ts":1,"payl'].join("\n") + "\n");
    const core = fresh();
    expect(core.drainSpool(spool)).toBe(2);
    expect(existsSync(spool)).toBe(false);
    expect(core.state.sessions.s1!.status).toBe("waiting");
  });
});
