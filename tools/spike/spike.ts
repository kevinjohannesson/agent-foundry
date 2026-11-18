/**
 * M0 spike: learn what this machine's Claude Code actually records, without copying anything private.
 *
 *   pnpm spike                 scan transcripts (+ spooled hook events if you recorded some)
 *   pnpm spike --copy 3        also copy the 3 newest transcripts to ./fixtures/transcripts (stays local, gitignored)
 *
 * Writes ./fixtures/spike-report.json. The report holds only structure and counts:
 * field names, event types, tool names, versions. No prompts, no code, no file contents.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

const claudeDir = process.env.CLAUDE_DIR || join(homedir(), ".claude");
const foundryDir = process.env.FOUNDRY_HOME || join(homedir(), ".agent-foundry");
const projectsDir = join(claudeDir, "projects");
const args = process.argv.slice(2);
const copyN = args.includes("--copy") ? Number(args[args.indexOf("--copy") + 1] ?? 3) : 0;
const SAMPLE = 40; // newest transcripts to inspect in detail

type Counter = Record<string, number>;
const inc = (c: Counter, k: string, n = 1) => { c[k] = (c[k] ?? 0) + n; };
const top = (c: Counter, n = 40) => Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n));

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out); else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Shape of a value with strings and numbers erased. */
function shape(v: unknown, depth = 0): unknown {
  if (depth > 3) return "…";
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k], depth + 1)]));
  return typeof v;
}

// ---- transcripts
const files = walk(projectsDir).map((p) => ({ p, mtime: statSync(p).mtimeMs, size: statSync(p).size })).sort((a, b) => b.mtime - a.mtime);
const layout: Counter = {};
for (const f of files) {
  const rel = relative(projectsDir, f.p).split("/");
  inc(layout, rel.length === 2 ? "<project>/<file>.jsonl" : `<project>/${rel.slice(1, -1).map(() => "<dir>").join("/")}/<file>.jsonl (depth ${rel.length})`);
  if (rel.length > 2) inc(layout, `nested dir name: ${rel[rel.length - 2]!.replace(/[0-9a-f-]{8,}/gi, "<id>")}`);
}
const lineTypes: Counter = {}, topKeys: Counter = {}, contentBlocks: Counter = {}, tools: Counter = {}, versions: Counter = {}, entrypoints: Counter = {}, userTypes: Counter = {};
const shapes: Record<string, unknown> = {};
let sidechainLines = 0, lines = 0, badLines = 0, withUsage = 0;
const fileNameStyle: Counter = {};
for (const f of files.slice(0, SAMPLE)) {
  inc(fileNameStyle, basename(f.p).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "<uuid>").replace(/[0-9a-f]{6,}/gi, "<hex>"));
  for (const line of readFileSync(f.p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    lines++;
    let o: Record<string, any>;
    try { o = JSON.parse(line); } catch { badLines++; continue; }
    const t = String(o.type ?? "<none>");
    inc(lineTypes, t);
    for (const k of Object.keys(o)) inc(topKeys, k);
    if (!shapes[t]) shapes[t] = shape(o);
    if (o.isSidechain) sidechainLines++;
    if (o.version) inc(versions, String(o.version));
    if (o.entrypoint) inc(entrypoints, String(o.entrypoint));
    if (o.userType) inc(userTypes, String(o.userType));
    const content = o.message?.content;
    if (o.message?.usage) withUsage++;
    if (Array.isArray(content)) for (const b of content) {
      inc(contentBlocks, `${o.message?.role ?? "?"}:${b?.type ?? "?"}`);
      if (b?.type === "tool_use") inc(tools, String(b.name));
    }
  }
}

// ---- spooled hook events (after `pnpm hooks:install --spool-only` and some real work)
const spoolFiles = existsSync(foundryDir) ? readdirSync(foundryDir).filter((n) => n.startsWith("spool.jsonl")).map((n) => join(foundryDir, n)) : [];
const hookEvents: Counter = {}, hookKeys: Record<string, Counter> = {}, hookTools: Counter = {}, notifications: Counter = {}, sessionSources: Counter = {};
const hookShapes: Record<string, unknown> = {};
const perSession: Record<string, string[]> = {};
for (const sf of spoolFiles) for (const line of readFileSync(sf, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let o: any; try { o = JSON.parse(line); } catch { continue; }
  const p = o.payload ?? {}; const n = String(p.hook_event_name);
  inc(hookEvents, n);
  hookKeys[n] ??= {}; for (const k of Object.keys(p)) inc(hookKeys[n]!, k);
  if (!hookShapes[n]) hookShapes[n] = shape({ ...p, tool_input: p.tool_input ? "<erased>" : undefined, tool_response: p.tool_response ? "<erased>" : undefined });
  if (p.tool_name) inc(hookTools, `${n}:${p.tool_name}`);
  if (n === "Notification" && p.message) inc(notifications, String(p.message).replace(/\b(use|run)\s+\S+/i, "$1 <tool>").slice(0, 80));
  if (n === "SessionStart") inc(sessionSources, String(p.source));
  (perSession[p.session_id] ??= []).push(n);
}
// how sessions flow: the first 12 events of up to 8 sessions, as event names only
const flows = Object.values(perSession).slice(0, 8).map((evs) => evs.slice(0, 12).join(" → "));

const report = {
  generatedAt: new Date().toISOString(),
  claudeDirExists: existsSync(claudeDir),
  transcripts: {
    files: files.length,
    totalMB: +(files.reduce((a, f) => a + f.size, 0) / 1e6).toFixed(1),
    newest: files[0] ? new Date(files[0].mtime).toISOString() : null,
    layout: top(layout),
    sampled: Math.min(SAMPLE, files.length), lines, badLines, sidechainLines, linesWithUsage: withUsage,
    fileNameStyle: top(fileNameStyle, 10),
    lineTypes: top(lineTypes), topLevelKeys: top(topKeys, 60), contentBlocks: top(contentBlocks), toolUse: top(tools),
    versions: top(versions, 10), entrypoints: top(entrypoints), userTypes: top(userTypes),
    shapeByType: shapes,
  },
  hooks: {
    spoolFiles: spoolFiles.length,
    events: top(hookEvents), keysByEvent: Object.fromEntries(Object.entries(hookKeys).map(([k, v]) => [k, top(v)])),
    tools: top(hookTools), notifications: top(notifications, 15), sessionStartSources: top(sessionSources),
    sessions: Object.keys(perSession).length, flows, shapeByEvent: hookShapes,
  },
};

mkdirSync("fixtures", { recursive: true });
writeFileSync("fixtures/spike-report.json", JSON.stringify(report, null, 2) + "\n");
if (copyN > 0) {
  mkdirSync("fixtures/transcripts", { recursive: true });
  for (const f of files.slice(0, copyN)) copyFileSync(f.p, join("fixtures/transcripts", basename(f.p)));
}

console.log(`Transcripts: ${report.transcripts.files} files, ${report.transcripts.totalMB} MB, newest ${report.transcripts.newest ?? "none"}`);
console.log(`Line types (newest ${report.transcripts.sampled}): ${Object.entries(report.transcripts.lineTypes).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`Entrypoints seen: ${Object.keys(report.transcripts.entrypoints).join(", ") || "none recorded"}`);
console.log(`Hook events spooled: ${Object.entries(report.hooks.events).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet (see docs/SPIKE.md step 3)"}`);
console.log(`\nWrote fixtures/spike-report.json. It holds structure and counts only; paste it to Claude.${copyN ? `\nCopied ${copyN} transcripts to fixtures/transcripts (local only).` : ""}`);
