import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { HookPayload, Intent, type ServerMessage } from "@foundry/protocol";
import type { Core } from "./core";

/** Where `pnpm build:factory` puts the factory. */
const FACTORY_DIST = fileURLToPath(new URL("../../factory/dist", import.meta.url));

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Agent Foundry</title>
<body style="font:14px system-ui;padding:2rem;background:#14161a;color:#e9e5db">
<p>The factory isn't built yet. Run <code>pnpm build:factory</code>, then reload. For development, <code>pnpm dev:factory</code>
serves it with hot reload. The <a style="color:#f0b44a" href="/">table view</a> works without a build.</p>`;

export function createApp(core: Core, opts: { factoryDir?: string } = {}) {
  const app = new Hono();
  const factoryDir = opts.factoryDir ?? FACTORY_DIST;

  /** The table view: a plain renderer of the state, no build step. Read per request so edits show on reload. */
  app.get("/", async (c) => c.html(await readFile(new URL("../public/index.html", import.meta.url), "utf8")));

  /** The factory view, as built by Vite. Checked per request, so building it while the core runs is enough. */
  let factory: MiddlewareHandler | undefined;
  app.get("/factory", (c) => c.redirect("/factory/"));
  app.use("/factory/*", async (c, next) => {
    if (!existsSync(join(factoryDir, "index.html"))) return c.html(NOT_BUILT, 503);
    factory ??= serveStatic({ root: factoryDir, rewriteRequestPath: (p) => p.replace(/^\/factory/, "") });
    return factory(c, next);
  });

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
