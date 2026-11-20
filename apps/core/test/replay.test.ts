/**
 * Replays this machine's recorded hook spool and transcripts (see replay.ts). Opt-in, because the data only exists
 * locally and never goes in the repo: run `pnpm replay`. The spool is found at FOUNDRY_REPLAY_SPOOL, or as
 * ~/.agent-foundry/spool.jsonl, or as the oldest ingested copy the core moved aside.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { transcriptTurnApplies, type FoundryState, type SessionState } from "@foundry/protocol";
import { runReplay, type ReplayResult } from "./replay";

const home = process.env.FOUNDRY_HOME || join(homedir(), ".agent-foundry");
const projects = process.env.FOUNDRY_TRANSCRIPTS || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
function findSpool(): string | null {
  if (process.env.FOUNDRY_REPLAY_SPOOL) return process.env.FOUNDRY_REPLAY_SPOOL;
  if (existsSync(join(home, "spool.jsonl"))) return join(home, "spool.jsonl");
  const ingested = (existsSync(home) ? readdirSync(home) : []).filter((n) => /^spool\.jsonl\.\d+\.ingested$/.test(n)).sort();
  return ingested[0] ? join(home, ingested[0]) : null;
}
const spool = findSpool();
const enabled = process.env.FOUNDRY_REPLAY === "1" && spool !== null && existsSync(projects);

const short = (id: string) => id.slice(0, 8);
const visible = (st: FoundryState) => Object.values(st.sessions).filter((s) => !s.pending);

function invariants(st: FoundryState): string[] {
  const bad: string[] = [];
  for (const s of Object.values(st.sessions)) {
    const agents = Object.values(s.agents);
    if (s.activeSubagents !== agents.filter((a) => a.running).length) bad.push(`${short(s.id)}: activeSubagents ${s.activeSubagents} vs ${agents.filter((a) => a.running).length} running`);
    if (s.subagentsTotal !== agents.length) bad.push(`${short(s.id)}: subagentsTotal ${s.subagentsTotal} vs ${agents.length} agents`);
    if (s.pending !== (!s.hasTranscript && !s.lastPrompt && s.toolCalls === 0)) bad.push(`${short(s.id)}: pending is ${s.pending}`);
    if (s.hasTranscript && !s.entrypoint) bad.push(`${short(s.id)}: transcript but no entrypoint`);
    if (s.title && s.nameSource !== "title" && s.nameSource !== "set") bad.push(`${short(s.id)}: has a title but named from ${s.nameSource}`);
    if (s.status !== "idle" && s.statusFrom === null) bad.push(`${short(s.id)}: status ${s.status} with no source`);
    if (s.turnHookAt !== null && (s.lastHookAt === null || s.turnHookAt > s.lastHookAt)) bad.push(`${short(s.id)}: turnHookAt after lastHookAt`);
    for (const a of agents) if (a.running && !a.background && s.status === "waiting" && s.statusFrom === "hooks") bad.push(`${short(s.id)}: foreground agent ${a.id} running after the turn ended`);
  }
  return bad;
}

function report(r: ReplayResult) {
  const rows = Object.values(r.final.sessions).sort((a, b) => b.lastActivityAt - a.lastActivityAt).map((s: SessionState) => {
    const e = r.atEnd.sessions[s.id];
    const h = r.hooksOnly.sessions[s.id];
    const f = r.factsAtEnd.get(s.id);
    return {
      session: short(s.id), app: s.entrypoint ?? "-", name: s.name.slice(0, 24),
      "hooks only": h ? h.status : "-", "transcript @end": f?.turn ?? "-", "@end": e ? `${e.status}${e.pending ? " (hidden)" : ""} (${e.statusFrom ?? "-"})` : "-",
      final: `${s.status}${s.pending ? " (hidden)" : ""} (${s.statusFrom ?? "-"})`, agents: `${s.activeSubagents}/${s.subagentsTotal}`,
    };
  });
  console.log(`replay: ${r.spool.parsed}/${r.spool.lines} hook events, ${r.files} files, ${new Date(r.start).toISOString()} → ${new Date(r.end).toISOString()}, took ${r.elapsedMs} ms`);
  console.table(rows);
}

describe.runIf(enabled)("replay of this machine's spool and transcripts", () => {
  let r: ReplayResult;
  beforeAll(async () => { r = await runReplay({ spool: spool!, projects }); report(r); }, 300_000);

  it("parses every spooled hook event", () => {
    expect(r.spool.parsed).toBe(r.spool.lines);
  });

  it("keeps state consistent at the end of the window and today", () => {
    expect(invariants(r.atEnd)).toEqual([]);
    expect(invariants(r.final)).toEqual([]);
  });

  it("hides ghosts: sessions that only started and ended and never wrote a transcript", () => {
    const ghosts = [...new Set(r.hooks.map((h) => h.payload.session_id))].filter((id) => {
      const evs = r.hooks.filter((h) => h.payload.session_id === id).map((h) => h.payload.hook_event_name);
      return evs.every((e) => e === "SessionStart" || e === "SessionEnd") && !r.factsAtEnd.has(id);
    });
    for (const id of ghosts) expect(r.final.sessions[id]?.pending ?? true, short(id)).toBe(true);
  });

  it("agrees with the hooks wherever the transcript has nothing newer", () => {
    const off: string[] = [];
    for (const h of Object.values(r.hooksOnly.sessions)) {
      const s = r.atEnd.sessions[h.id]!;
      const f = r.factsAtEnd.get(h.id);
      const transcriptNewer = f?.turnAt !== undefined && transcriptTurnApplies(h, f.turnAt, f.interrupted);
      if (!transcriptNewer && s.status !== h.status) off.push(`${short(h.id)}: ${s.status}, hooks say ${h.status}`);
    }
    expect(off).toEqual([]);
  });

  it("follows the transcript where hooks were silent or older", () => {
    const off: string[] = [];
    for (const [id, f] of r.factsAtEnd) {
      const s = r.atEnd.sessions[id];
      if (!s || !f.turn || f.turnAt === undefined) continue;
      const hookNewer = !transcriptTurnApplies(s, f.turnAt, f.interrupted);
      if (!hookNewer && s.status !== f.turn) off.push(`${short(id)}: ${s.status}, transcript says ${f.turn}`);
    }
    expect(off).toEqual([]);
  });

  it("never flickers: the hooks don't undo what the transcript said", () => {
    // The transcript often reports a turn's end (or start) a moment before the hook arrives. That's fine as long as the
    // hook agrees; a transcript change that the next hook for the turn reverses within seconds would show as a flicker.
    // A hook that agreed in between makes the reversal a new turn (a short one), not a flicker.
    const flicker: string[] = [];
    const bySession = new Map<string, typeof r.changes>();
    for (const c of r.changes) bySession.set(c.sessionId, [...(bySession.get(c.sessionId) ?? []), c]);
    const turnHookBetween = (id: string, from: number, to: number) => r.hooks.some((h) =>
      h.payload.session_id === id && !h.payload.agent_id && !h.payload.hook_event_name.startsWith("Subagent") && h.ts >= from && h.ts < to);
    for (const list of bySession.values()) {
      for (let i = 1; i < list.length; i++) {
        const [x, y] = [list[i - 1]!, list[i]!];
        if (x.by === "transcript.observed" && y.by.startsWith("hook") && y.to === x.from && y.at - x.at < 10_000 && !turnHookBetween(x.sessionId, x.at, y.at))
          flicker.push(`${short(x.sessionId)} ${x.from}→${x.to} by the transcript, back by ${y.by} after ${y.at - x.at} ms`);
      }
    }
    expect(flicker).toEqual([]);
  });

  it("leaves hooks in charge of a session unless its transcript is newer", () => {
    for (const s of Object.values(r.atEnd.sessions)) {
      const h = r.hooksOnly.sessions[s.id];
      const f = r.factsAtEnd.get(s.id);
      const transcriptNewer = f?.turnAt !== undefined && !!h && transcriptTurnApplies(h, f.turnAt, f.interrupted);
      if (h && !transcriptNewer) expect(s.statusFrom, short(s.id)).toBe("hooks");
    }
  });

  it("names every session it can see and knows its app", () => {
    for (const s of visible(r.final)) {
      expect(s.name, short(s.id)).not.toBe("New session");
      if (s.hasTranscript) expect(s.entrypoint, short(s.id)).toBeTruthy();
    }
  });

  it("records nothing more when nothing changes, and rebuilds the same state on restart", () => {
    expect(r.idleEvents).toBe(0);
    expect(r.restart.sameState).toBe(true);
    expect(r.restart.events.map((e) => JSON.stringify(e))).toEqual([]);
  });
});
