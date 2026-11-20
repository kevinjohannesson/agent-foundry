import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Core } from "./core";
import { EventLog } from "./db";
import { addWebSocket, createApp } from "./server";
import { Tailer } from "./tailer";

const home = process.env.FOUNDRY_HOME || join(homedir(), ".agent-foundry");
const port = Number(process.env.FOUNDRY_PORT || 7717);
const projects = process.env.FOUNDRY_TRANSCRIPTS || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const backfillHours = Number(process.env.FOUNDRY_BACKFILL_HOURS || 24);
mkdirSync(home, { recursive: true });

const log = new EventLog(join(home, "foundry.db"));
const core = new Core(log);
const spool = join(home, "spool.jsonl");
const drained = core.drainSpool(spool);
// The forwarder also spools when the core is up but slow to answer; pick those up as they come.
const spoolTimer = setInterval(() => core.drainSpool(spool), 2000);
let stopTailer: (() => void) | undefined;

const tailer = new Tailer({
  root: projects,
  windowMs: backfillHours * 3_600_000,
  onSession: (o) => core.observeSession(o),
  onAgent: (o) => core.observeAgent(o),
});
// Sessions the log knows that may have moved on without hooks (hooks uninstalled, or not loaded yet).
for (const s of Object.values(core.state.sessions)) if (s.transcriptPath && s.status !== "ended" && !s.archived) tailer.track(s.transcriptPath);
// A resumed session can be older than the backfill window: read its transcript as soon as a hook names it.
core.subscribe((ev) => { if (ev.kind === "hook" && ev.payload.transcript_path) tailer.track(ev.payload.transcript_path); });

const app = createApp(core);
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
addWebSocket(app, core, upgradeWebSocket);

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, async (info) => {
  console.log(`Agent Foundry core on http://127.0.0.1:${info.port}  (data: ${home})`);
  const before = core.state.seq;
  await tailer.poll();
  const visible = Object.values(core.state.sessions).filter((s) => !s.pending).length;
  console.log(`${visible} sessions, ${drained} spooled events ingested, ${core.state.seq - before} transcript events from the last ${backfillHours}h.`);
  if (!stopping) stopTailer = tailer.start(1000);
});
injectWebSocket(server);

// Ctrl+C (or a kill): stop reading, close the log and exit cleanly. Hook events go to the spool until the next start.
// The signal can arrive more than once (pnpm and tsx pass it on too), so only the first one counts.
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  stopTailer?.();
  clearInterval(spoolTimer);
  server.close();
  log.close();
  console.log("Agent Foundry core stopped.");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
