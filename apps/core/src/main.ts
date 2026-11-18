import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Core } from "./core";
import { EventLog } from "./db";
import { addWebSocket, createApp } from "./server";

const home = process.env.FOUNDRY_HOME || join(homedir(), ".agent-foundry");
const port = Number(process.env.FOUNDRY_PORT || 7717);
mkdirSync(home, { recursive: true });

const core = new Core(new EventLog(join(home, "foundry.db")));
const drained = core.drainSpool(join(home, "spool.jsonl"));

const app = createApp(core);
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
addWebSocket(app, core, upgradeWebSocket);

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Agent Foundry core on http://127.0.0.1:${info.port}  (data: ${home})`);
  console.log(`${Object.keys(core.state.sessions).length} sessions known, ${drained} spooled events ingested.`);
});
injectWebSocket(server);
