import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { HookPayload, Intent, type ServerMessage } from "@foundry/protocol";
import type { Core } from "./core";

export function createApp(core: Core) {
  const app = new Hono();

  /** The table view: a plain renderer of the state, no build step. Read per request so edits show on reload. */
  app.get("/", async (c) => c.html(await readFile(new URL("../public/index.html", import.meta.url), "utf8")));

  app.get("/health", (c) => c.json({ ok: true, seq: core.state.seq }));

  /** Called by the hook forwarder. Always answers fast; a bad payload is dropped, never retried. */
  app.post("/hooks", async (c) => {
    const body = await c.req.json().catch(() => null);
    const payload = HookPayload.safeParse(body?.payload);
    if (!payload.success) return c.json({ ok: false, error: "bad hook payload" }, 400);
    const ev = core.record({ kind: "hook", ts: typeof body.ts === "number" ? body.ts : Date.now(), payload: payload.data });
    return c.json({ ok: true, seq: ev.seq });
  });

  app.get("/state", (c) => c.json(core.state));

  app.post("/intents", async (c) => {
    const parsed = Intent.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "bad intent" }, 400);
    try { return c.json({ ok: true, events: core.handle(parsed.data) }); }
    catch (e) { return c.json({ ok: false, error: (e as Error).message }, 409); }
  });

  return app;
}

/** The live channel: a snapshot on connect, then every event with the new state. Intents can come back the same way. */
export function addWebSocket(app: Hono, core: Core, upgradeWebSocket: UpgradeWebSocket) {
    app.get("/ws", upgradeWebSocket(() => {
      let off: (() => void) | undefined;
      return {
        onOpen(_e, ws) {
          const send = (m: ServerMessage) => ws.send(JSON.stringify(m));
          send({ type: "snapshot", state: core.state });
          off = core.subscribe((event, state) => send({ type: "event", event, state }));
        },
        onMessage(e, ws) {
          const parsed = Intent.safeParse(JSON.parse(String(e.data)));
          if (!parsed.success) { ws.send(JSON.stringify({ type: "error", message: "bad intent" } satisfies ServerMessage)); return; }
          try { core.handle(parsed.data); } catch (err) { ws.send(JSON.stringify({ type: "error", message: (err as Error).message } satisfies ServerMessage)); }
        },
        onClose() { off?.(); },
      };
    }));
}
