/**
 * M0 spike: learn what this machine's Claude Code actually records, without copying anything private.
 *
 *   pnpm spike                 scan transcripts (+ spooled hook events if you recorded some)
 *   pnpm spike --sample 20     inspect the newest 20 files of each kind in detail (default 20)
 *   pnpm spike --copy 3        also copy the 3 newest session transcripts to ./fixtures/transcripts (stays local, gitignored)
 *
 * Writes ./fixtures/spike-report.json. The report holds only structure and counts:
 * field names, event types, tool names, versions. No prompts, no code, no file contents.
 *
 * Kinds of file under ~/.claude/projects (paths as seen on Claude Code 2.1.3xx):
 *   session    <project>/<sessionId>.jsonl
 *   subagent   <project>/<sessionId>/subagents/agent-<id>.jsonl                    + agent-<id>.meta.json
 *   workflow   <project>/<sessionId>/subagents/workflows/wf_<id>/agent-<id>.jsonl  + agent-<id>.meta.json
 *   journal    <project>/<sessionId>/subagents/workflows/wf_<id>/journal.jsonl
 * Sampling the newest N files overall picks mostly subagent files, so each kind is sampled on its own,
 * and sessions once per entrypoint (claude-desktop, claude-vscode, cli, ...).
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

const claudeDir = process.env.CLAUDE_DIR || join(homedir(), ".claude");
const foundryDir = process.env.FOUNDRY_HOME || join(homedir(), ".agent-foundry");
const projectsDir = join(claudeDir, "projects");
const args = process.argv.slice(2);
/** `--flag N`: N if given, `ifBare` if the flag has no number, `ifAbsent` without the flag. */
const numArg = (flag: string, ifBare: number, ifAbsent: number) => {
  const i = args.indexOf(flag);
  if (i < 0) return ifAbsent;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : ifBare;
};
const copyN = numArg("--copy", 3, 0);
const SAMPLE = numArg("--sample", 20, 20); // newest files per kind to inspect in detail
const HEAD_BYTES = 1 << 20; // how much of each file the census reads

type Counter = Record<string, number>;
const inc = (c: Counter, k: string, n = 1) => { c[k] = (c[k] ?? 0) + n; };
const top = (c: Counter, n = 40) => Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n));
const mb = (bytes: number) => +(bytes / 1e6).toFixed(1);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (name.endsWith(".jsonl") || name.endsWith(".json")) out.push(p);
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

/** Path with project names and ids erased, e.g. `<project>/<uuid>/subagents/agent-<id>.meta.json`. */
const anonPath = (rel: string[]) => ["<project>", ...rel.slice(1)].join("/")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
  .replace(/wf_[A-Za-z0-9_-]+/g, "wf_<id>")
  .replace(/agent-[0-9a-z]+/gi, "agent-<id>")
  .replace(/toolu_[A-Za-z0-9]+/g, "toolu_<id>")
  .replace(/[A-Za-z0-9_-]{24,}/g, "<id>");

/** Complete lines in the first HEAD_BYTES of a file. */
function headLines(p: string, size: number): string[] {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    if (n < size) lines.pop(); // cut off mid-line
    return lines;
  } finally { closeSync(fd); }
}

/** First value of a top-level string field in the file's head, or null. */
function headField(f: FileInfo, field: string): string | null {
  for (const line of headLines(f.p, f.size)) {
    if (!line.includes(`"${field}"`)) continue;
    try { const v = JSON.parse(line)[field]; if (typeof v === "string") return v; } catch { /* partial or bad line */ }
  }
  return null;
}

type Kind = "session" | "subagent" | "workflow" | "journal" | "other";
const KINDS: Kind[] = ["session", "subagent", "workflow", "journal", "other"];
function kindOf(rel: string[]): Kind {
  const name = rel[rel.length - 1]!;
  if (rel.length === 2) return "session";
  if (rel[2] !== "subagents") return "other";
  if (rel[3] === "workflows") return name === "journal.jsonl" ? "journal" : name.startsWith("agent-") ? "workflow" : "other";
  return name.startsWith("agent-") ? "subagent" : "other";
}

interface FileInfo { p: string; rel: string[]; kind: Kind; mtime: number; size: number; entrypoint: string | null }

// ---- census: every file, cheaply
const all = walk(projectsDir).map((p) => { const st = statSync(p); return { p, rel: relative(projectsDir, p).split("/"), mtime: st.mtimeMs, size: st.size }; });
const layout: Counter = {};
for (const f of all) inc(layout, anonPath(f.rel));
const files: FileInfo[] = all.filter((f) => f.p.endsWith(".jsonl")).map((f) => ({ ...f, kind: kindOf(f.rel), entrypoint: null as string | null })).sort((a, b) => b.mtime - a.mtime);
for (const f of files) if (f.kind !== "journal") f.entrypoint = headField(f, "entrypoint");

const byKind = Object.fromEntries(KINDS.map((k) => {
  const fs = files.filter((f) => f.kind === k);
  const entrypoints: Counter = {};
  if (k !== "journal") for (const f of fs) inc(entrypoints, f.entrypoint ?? "<none in first 1 MB>");
  return [k, { files: fs.length, MB: mb(fs.reduce((a, f) => a + f.size, 0)), newest: fs[0] ? new Date(fs[0].mtime).toISOString() : null, ...(k !== "journal" && { entrypoints: top(entrypoints) }) }];
}).filter(([, v]) => (v as { files: number }).files > 0));

// ---- sample: the newest files of each kind (sessions also per entrypoint), line by line
const shapes: Record<string, unknown> = {};
function scan(kind: Kind, sample: FileInfo[]) {
  const lineTypes: Counter = {}, topKeys: Counter = {}, contentBlocks: Counter = {}, tools: Counter = {}, versions: Counter = {}, entrypoints: Counter = {}, userTypes: Counter = {};
  let lines = 0, badLines = 0, sidechainLines = 0, withUsage = 0;
  for (const f of sample) for (const line of readFileSync(f.p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    lines++;
    let o: Record<string, any>;
    try { o = JSON.parse(line); } catch { badLines++; continue; }
    const t = String(o.type ?? "<none>");
    inc(lineTypes, t);
    for (const k of Object.keys(o)) inc(topKeys, k);
    const shapeKey = kind === "journal" ? `journal:${t}` : t; // sessions are scanned first, so their shapes win
    if (!shapes[shapeKey]) shapes[shapeKey] = shape(o);
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
  return {
    sampled: sample.length, lines, badLines, sidechainLines, linesWithUsage: withUsage,
    lineTypes: top(lineTypes), topLevelKeys: top(topKeys, 60), contentBlocks: top(contentBlocks), toolUse: top(tools),
    versions: top(versions, 10), entrypoints: top(entrypoints), userTypes: top(userTypes),
  };
}
/** Sample group: `session:<entrypoint>` for sessions, so CLI, VS Code and desktop each get looked at; the kind otherwise. */
const groupOf = (f: FileInfo) => f.kind === "session" ? `session:${f.entrypoint ?? "unknown"}` : f.kind;
const samples: Record<string, FileInfo[]> = {};
for (const k of KINDS) for (const f of files) if (f.kind === k) { const s = (samples[groupOf(f)] ??= []); if (s.length < SAMPLE) s.push(f); }
const sampleStats = Object.fromEntries(Object.entries(samples).map(([g, s]) => [g, scan(s[0]!.kind, s)]));

// ---- subagents: their .meta.json sidecars, and whether they link back to the parent session
const readMeta = (f: FileInfo): Record<string, unknown> | null => {
  const mp = f.p.replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(mp)) return null;
  try { return JSON.parse(readFileSync(mp, "utf8")); } catch { return null; }
};
const metaKeys: Counter = {}, agentTypes: Counter = {}, finished: Counter = {}, spawnDepth: Counter = {};
let agentFiles = 0, withMeta = 0;
for (const f of files) if (f.kind === "subagent" || f.kind === "workflow") {
  agentFiles++;
  const m = readMeta(f);
  if (!m) continue;
  withMeta++;
  for (const k of Object.keys(m)) inc(metaKeys, k);
  inc(agentTypes, `${f.kind}:${String(m.agentType)}`);
  inc(finished, String(m.finished));
  inc(spawnDepth, String(m.spawnDepth));
}
const linkage: Counter = {};
const parentText = new Map<string, string>();
for (const f of [...(samples.subagent ?? []), ...(samples.workflow ?? [])]) {
  const sessionDir = f.rel[1]!;
  inc(linkage, `${f.kind}: sessionId in lines ${headField(f, "sessionId") === sessionDir ? "matches" : "differs from"} its folder`);
  if (f.kind === "workflow") {
    const run = join(projectsDir, f.rel[0]!, sessionDir, "workflows", `${f.rel[4]}.json`);
    inc(linkage, `workflow: run file <session>/workflows/wf_<id>.json ${existsSync(run) ? "exists" : "missing"}`);
  }
  const parentPath = join(projectsDir, f.rel[0]!, `${sessionDir}.jsonl`);
  if (!existsSync(parentPath)) { inc(linkage, `${f.kind}: parent session file missing`); continue; }
  const toolUseId = readMeta(f)?.toolUseId;
  if (typeof toolUseId !== "string") { inc(linkage, `${f.kind}: no toolUseId in meta`); continue; }
  let text = parentText.get(parentPath);
  if (text === undefined) parentText.set(parentPath, text = readFileSync(parentPath, "utf8"));
  inc(linkage, `${f.kind}: meta toolUseId ${text.includes(toolUseId) ? "found" : "not found"} in parent session`);
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
    totalMB: mb(files.reduce((a, f) => a + f.size, 0)),
    newest: files[0] ? new Date(files[0].mtime).toISOString() : null,
    layout: top(layout),
    byKind,
    samplePerKind: SAMPLE,
    sample: sampleStats,
    subagentSidecars: { agentFiles, withMeta, metaKeys: top(metaKeys), agentTypes: top(agentTypes), finished: top(finished), spawnDepth: top(spawnDepth), linkage: top(linkage) },
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
const copied = files.filter((f) => f.kind === "session").slice(0, copyN);
if (copied.length) {
  mkdirSync("fixtures/transcripts", { recursive: true });
  for (const f of copied) copyFileSync(f.p, join("fixtures/transcripts", basename(f.p)));
}

const list = (c: Counter | undefined) => Object.entries(c ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
console.log(`Transcripts: ${report.transcripts.files} files, ${report.transcripts.totalMB} MB, newest ${report.transcripts.newest ?? "none"}`);
for (const [k, v] of Object.entries(byKind) as [string, { files: number; MB: number; entrypoints?: Counter }][]) {
  console.log(`  ${k.padEnd(9)} ${String(v.files).padStart(4)} files ${String(v.MB).padStart(7)} MB${v.entrypoints ? `   entrypoints: ${list(v.entrypoints)}` : ""}`);
}
console.log(`Subagent files with a .meta.json: ${withMeta}/${agentFiles}. Links: ${list(top(linkage))}`);
for (const [g, s] of Object.entries(sampleStats)) if (g.startsWith("session:")) {
  console.log(`Line types, newest ${s.sampled} ${g}: ${list(top(s.lineTypes as Counter, 12))}`);
}
console.log(`Hook events spooled: ${list(report.hooks.events) || "none yet (see docs/SPIKE.md step 3)"}`);
console.log(`\nWrote fixtures/spike-report.json. It holds structure and counts only; paste it to Claude.${copied.length ? `\nCopied ${copied.length} session transcripts to fixtures/transcripts (local only).` : ""}`);
