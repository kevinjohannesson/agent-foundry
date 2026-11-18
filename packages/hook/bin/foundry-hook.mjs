#!/usr/bin/env node
// Agent Foundry hook forwarder. Claude Code runs this for every hook event.
// Rules: be fast, never fail, never print (stdout from some hooks is added to Claude's context).
// It POSTs the event to the local core; if the core is not running it appends to a spool file
// that the core reads on its next start.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const port = process.env.FOUNDRY_PORT || "7717";
const dir = process.env.FOUNDRY_HOME || join(homedir(), ".agent-foundry");
const spool = join(dir, "spool.jsonl");

function toSpool(line) {
  try { mkdirSync(dir, { recursive: true }); appendFileSync(spool, line + "\n"); } catch {}
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(raw);
    const line = JSON.stringify({ kind: "hook", ts: Date.now(), payload });
    if (process.env.FOUNDRY_SPOOL_ONLY === "1") { toSpool(line); return; }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: line,
        signal: AbortSignal.timeout(400),
      });
      if (!res.ok) toSpool(line);
    } catch { toSpool(line); }
  } catch {}
  process.exit(0);
});
