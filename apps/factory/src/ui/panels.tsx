import { useEffect, useRef, useState, type ReactNode } from "react";
import { HOTBAR_SLOTS, SHAPES, type FoundryState, type Intent, type LoggedEvent, type SessionState, type Shape } from "@foundry/protocol";
import { useBus, type Bus } from "../bus";
import { ago, APPS, folder, LOT_COLOR, PALETTE, STATUS_LABEL, type AreaView, type Counts, type Model } from "../model";
import type { Selection } from "../scene";
import { BotIcon, ChestIcon, LotIcon, ShapeIcon, StateIcon, WarnGlyph, YourMoveGlyph } from "./icons";

export interface Ctx {
  state: FoundryState;
  model: Model;
  selection: Selection;
  select(sel: Selection, fly?: boolean): void;
  /** Sends an intent; shows the core's refusal as a toast. */
  send(intent: Intent): Promise<{ events?: LoggedEvent[]; error?: string }>;
  toast(text: string, bad?: boolean): void;
  zoom(f: number): void;
  fit(): void;
}

const keyOf = (i: number) => (i < 9 ? String(i + 1) : "0");
const areaColor = (ctx: Ctx, s: SessionState) => (s.workstreamId && ctx.state.workstreams[s.workstreamId]?.color) || LOT_COLOR;
const areaName = (ctx: Ctx, id: string | null) => (id && ctx.state.workstreams[id]?.name) || "Unassigned";

export const Chip = ({ mono, color, big }: { mono: string; color: string; big?: boolean }) => (
  <span className={`chip${big ? " big" : ""}`} style={{ color, borderColor: color }}>{mono}</span>
);

const AreaGlyph = ({ a }: { a: AreaView }) => (a.isLot ? <LotIcon color={a.color} /> : <ShapeIcon shape={a.shape} color={a.color} />);

function Stats({ c }: { c: Counts }) {
  return (
    <span className="ov-stats">
      <span className="st"><b>{c.working}</b><small>Working</small></span>
      <span className={`st ${c.needsYou ? "alert" : ""}`}><b>{c.needsYou}</b><small>Need you</small></span>
      <span className={`st ${c.yourMove ? "yours" : ""}`}><b>{c.yourMove}</b><small>Your move</small></span>
      <span className="st"><b>{c.bots}</b><small>Bots</small></span>
      <span className="st"><b>{c.ended}</b><small>Ended</small></span>
    </span>
  );
}

function Title({ children, onClose, extra }: { children: ReactNode; onClose?: () => void; extra?: ReactNode }) {
  return (
    <div className="ttl">
      <span>{children}</span><span className="ridge" />{extra}
      {onClose && <button className="xbtn" onClick={onClose} aria-label="Close">×</button>}
    </div>
  );
}

// ---------- overview ----------
export function Overview({ ctx, conn }: { ctx: Ctx; conn: "connecting" | "live" | "down" }) {
  const [creating, setCreating] = useState(false);
  return (
    <section className="panel" id="overview" aria-label="Overview">
      <Title extra={<span className={`conn ${conn}`}>{conn === "live" ? "live" : conn === "down" ? "reconnecting" : "connecting"}</span>}>Overview</Title>
      <div className="inset">
        <div className="ov-list">
          {ctx.model.areas.map((a) => (
            <button key={a.id} className={`ov-row ${ctx.selection?.kind === "area" && ctx.selection.id === a.id ? "sel" : ""}`}
              onClick={() => ctx.select({ kind: "area", id: a.id }, true)} aria-label={`Go to ${a.name}`}>
              <span className="ov-name"><AreaGlyph a={a} /><span>{a.name}</span></span>
              <Stats c={a.counts} />
            </button>
          ))}
        </div>
      </div>
      {creating && <NewWorkstream ctx={ctx} done={() => setCreating(false)} />}
      <div className="ctl">
        {!creating && <button className="btn go" onClick={() => setCreating(true)}>+ Workstream</button>}
        <span className="sp" />
        <button className="btn" onClick={() => ctx.zoom(0.8)} aria-label="Zoom out">−</button>
        <button className="btn" onClick={() => ctx.zoom(1.25)} aria-label="Zoom in">+</button>
        <button className="btn" onClick={ctx.fit} title="Fit everything (F)">Fit</button>
        <a className="btn" href="/" title="The plain session table">Table</a>
      </div>
    </section>
  );
}

function ColourPicker({ value, onPick }: { value: string; onPick(c: string): void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Colour">
      {PALETTE.map((c) => (
        <button key={c} className={`pick ${c === value ? "sel" : ""}`} style={{ background: c }} onClick={() => onPick(c)} role="radio" aria-checked={c === value} aria-label={c} />
      ))}
    </div>
  );
}

function ShapePicker({ value, color, onPick }: { value: Shape; color: string; onPick(s: Shape): void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Shape">
      {SHAPES.map((s) => (
        <button key={s} className={`pick shape ${s === value ? "sel" : ""}`} onClick={() => onPick(s)} role="radio" aria-checked={s === value} aria-label={s}>
          <ShapeIcon shape={s} color={color} />
        </button>
      ))}
    </div>
  );
}

function NewWorkstream({ ctx, done }: { ctx: Ctx; done(): void }) {
  const used = new Set(Object.values(ctx.state.workstreams).map((w) => w.color));
  const n = Object.keys(ctx.state.workstreams).length;
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE.find((c) => !used.has(c)) ?? PALETTE[n % PALETTE.length]!);
  const [shape, setShape] = useState<Shape>(SHAPES[n % SHAPES.length]!);
  const create = async () => {
    if (!name.trim()) return;
    const r = await ctx.send({ type: "createWorkstream", name: name.trim(), color, shape });
    const ev = r.events?.find((e) => e.kind === "foundry" && e.type === "workstream.created");
    if (ev && ev.kind === "foundry" && ev.type === "workstream.created") {
      done();
      ctx.toast(`Made ${ev.name}. Drag sessions into it from the lot`);
      setTimeout(() => ctx.select({ kind: "area", id: ev.id }, true), 50);
    }
  };
  return (
    <div className="inset newws">
      <div className="lbl">New workstream</div>
      <input className="field" autoFocus placeholder="Name, e.g. Design system" maxLength={40} value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") { e.stopPropagation(); done(); } }} />
      <ColourPicker value={color} onPick={setColor} />
      <ShapePicker value={shape} color={color} onPick={setShape} />
      <p className="note">It goes next to the others on the map. Drag its label to move it, or its corner to resize it.</p>
      <div className="acts"><button className="btn go" disabled={!name.trim()} onClick={create}>Create</button><button className="btn" onClick={done}>Cancel</button></div>
    </div>
  );
}

// ---------- inspector ----------
export function Inspector({ ctx }: { ctx: Ctx }) {
  const sel = ctx.selection;
  if (!sel) return null;
  if (sel.kind === "session") {
    const s = ctx.state.sessions[sel.id];
    return s ? <SessionPanel key={s.id} ctx={ctx} s={s} /> : null;
  }
  const a = ctx.model.area[sel.id];
  if (!a) return null;
  return sel.kind === "chest" ? <ChestPanel ctx={ctx} a={a} /> : <AreaPanel key={a.id} ctx={ctx} a={a} />;
}

function Rename({ value, onSave, onCancel }: { value: string; onSave(v: string): void; onCancel(): void }) {
  const [v, setV] = useState(value);
  return (
    <input className="field" autoFocus maxLength={40} value={v} onChange={(e) => setV(e.target.value)} aria-label="New name"
      onKeyDown={(e) => { if (e.key === "Enter" && v.trim()) onSave(v.trim()); if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
      onBlur={onCancel} />
  );
}

function SessionPanel({ ctx, s }: { ctx: Ctx; s: SessionState }) {
  const [renaming, setRenaming] = useState(false);
  const close = () => ctx.select(null);
  const color = areaColor(ctx, s);
  const agents = Object.values(s.agents).sort((a, b) => Number(b.running) - Number(a.running) || b.lastActivityAt - a.lastActivityAt);
  const pinned = ctx.state.pins.findIndex((p) => p?.id === s.id);
  const free = ctx.state.pins.findIndex((p) => !p || !ctx.model.machine[p.id]);
  const app = (s.entrypoint && APPS[s.entrypoint]) || s.entrypoint || "the app";
  const stateCls = s.archived ? "archived" : s.status;
  return (
    <section className="panel" id="inspector" aria-live="polite">
      <Title onClose={close}>Session</Title>
      <div className="inset">
        <div className="ent-head">
          <Chip mono={s.mono} color={color} big />
          <div style={{ minWidth: 0, flex: 1 }}>
            {renaming
              ? <Rename value={s.name} onCancel={() => setRenaming(false)} onSave={(name) => { setRenaming(false); ctx.send({ type: "rename", sessionId: s.id, name }); }} />
              : <div className="ent-title">{s.name}</div>}
            <div className="ent-sub">{s.title && s.title !== s.name ? <>{s.title}<br /></> : null}{areaName(ctx, s.workstreamId)}</div>
          </div>
        </div>
        <span className={`state ${stateCls}`}>{s.archived ? "In the chest" : STATUS_LABEL[s.status]}</span>
        {s.status === "needs_you" && s.notification && (
          <div className="ask"><p>{s.notification}</p><p className="note">Answer it in {app}. Answers from this panel come with the controllers (M3).</p></div>
        )}
        <dl className="kv">
          <dt>App</dt><dd>{(s.entrypoint && APPS[s.entrypoint]) || s.entrypoint || "—"}</dd>
          <dt>Folder</dt><dd title={s.cwd ?? ""}>{folder(s.cwd)}</dd>
          <dt>Mode</dt><dd>{s.permissionMode ?? "—"}</dd>
          <dt>Tools</dt><dd>{s.lastTool ? `${s.lastTool} ×${s.toolCalls}` : s.toolCalls || "—"}</dd>
          <dt>Bots</dt><dd>{s.subagentsTotal ? `${s.activeSubagents} running · ${s.subagentsTotal} in all` : "—"}</dd>
          <dt>Started</dt><dd title={new Date(s.startedAt).toLocaleString()}>{ago(s.startedAt)} ago</dd>
          <dt>Last active</dt><dd title={new Date(s.lastActivityAt).toLocaleString()}>{ago(s.lastActivityAt)} ago</dd>
          <dt>Status from</dt><dd>{s.statusFrom ?? "—"}</dd>
        </dl>
        {s.lastPrompt && <div><div className="lbl">Your last prompt</div><p className="note clamp">{s.lastPrompt}</p></div>}
        {agents.length > 0 && (
          <div>
            <div className="lbl">Bots ({s.activeSubagents} running)</div>
            <ul className="log">
              {agents.slice(0, 8).map((a) => (
                <li key={a.id} className={a.running ? "run" : ""} title={a.description ?? a.type}>{a.type}{a.description ? ` · ${a.description}` : ""}</li>
              ))}
              {agents.length > 8 && <li>and {agents.length - 8} more</li>}
            </ul>
          </div>
        )}
        {!s.archived && (
          <div>
            <div className="lbl">Workstream</div>
            <select className="field" value={s.workstreamId ?? ""} aria-label="Workstream"
              onChange={(e) => ctx.send({ type: "assign", sessionId: s.id, workstreamId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {Object.values(ctx.state.workstreams).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
        )}
        <div className="acts">
          <button className="btn" onClick={() => setRenaming(true)}>Rename</button>
          {!s.archived && (pinned >= 0
            ? <button className="btn" onClick={() => ctx.send({ type: "pin", slot: pinned, ref: null })}>Unpin from {keyOf(pinned)}</button>
            : <button className="btn" disabled={free < 0} onClick={() => ctx.send({ type: "pin", slot: free, ref: { kind: "session", id: s.id } }).then((r) => { if (!r.error) ctx.toast(`Pinned to slot ${keyOf(free)}`); })}>Pin to hotbar</button>)}
          {s.archived
            ? <button className="btn go" onClick={() => ctx.send({ type: "restore", sessionId: s.id }).then((r) => { if (!r.error) ctx.select({ kind: "session", id: s.id }, true); })}>Restore</button>
            : <button className="btn" onClick={() => ctx.send({ type: "archive", sessionId: s.id, handoff: false }).then((r) => { if (!r.error) { ctx.toast(`${s.name} went into the chest`); close(); } })}>Archive</button>}
        </div>
      </div>
    </section>
  );
}

function AreaPanel({ ctx, a }: { ctx: Ctx; a: AreaView }) {
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const w = a.isLot ? null : ctx.state.workstreams[a.id]!;
  const sessions = a.sessions.map((id) => ctx.state.sessions[id]!).sort((p, q) => q.lastActivityAt - p.lastActivityAt);
  const ended = sessions.filter((s) => s.status === "ended");
  const archiveEnded = async () => {
    let n = 0;
    for (const s of ended) if (!(await ctx.send({ type: "archive", sessionId: s.id, handoff: false })).error) n++;
    ctx.toast(`${n} ended session${n === 1 ? "" : "s"} went into the chest`);
  };
  return (
    <section className="panel" id="inspector" aria-live="polite">
      <Title onClose={() => ctx.select(null)}>{a.isLot ? "Unassigned lot" : "Workstream"}</Title>
      <div className="inset">
        <div className="ent-head">
          <AreaGlyph a={a} />
          <div style={{ minWidth: 0, flex: 1 }}>
            {renaming && w
              ? <Rename value={w.name} onCancel={() => setRenaming(false)} onSave={(name) => { setRenaming(false); ctx.send({ type: "updateWorkstream", workstreamId: w.id, name }); }} />
              : <div className="ent-title">{a.name}</div>}
            <div className="ent-sub">{sessions.length} session{sessions.length === 1 ? "" : "s"} · {a.declared.w}×{a.declared.h} tiles{a.archived.length ? ` · ${a.archived.length} in the chest` : ""}</div>
          </div>
        </div>
        <Stats c={a.counts} />
        {w && (
          <div>
            <div className="lbl">Colour and shape</div>
            <div style={{ display: "grid", gap: 6 }}>
              <ColourPicker value={w.color} onPick={(color) => ctx.send({ type: "updateWorkstream", workstreamId: w.id, color })} />
              <ShapePicker value={w.shape} color={w.color} onPick={(shape) => ctx.send({ type: "updateWorkstream", workstreamId: w.id, shape })} />
            </div>
          </div>
        )}
        {sessions.length > 0 && (
          <div>
            <div className="lbl">Sessions</div>
            <ul className="log">
              {sessions.slice(0, 30).map((s) => (
                <li key={s.id} className="row">
                  <Chip mono={s.mono} color={a.color} />
                  <button className="linkish" onClick={() => ctx.select({ kind: "session", id: s.id }, true)}>{s.name}</button>
                  <span className="muted" style={{ flex: "none" }}>{STATUS_LABEL[s.status]}</span>
                </li>
              ))}
              {sessions.length > 30 && <li>and {sessions.length - 30} more</li>}
            </ul>
          </div>
        )}
        <p className="note">
          {a.isLot
            ? "Sessions that belong to no workstream wait here. Drag one into a workstream to assign it; drag it back to unassign it."
            : "Drag sessions in from the lot. Drag the label above the area to move it, and its bottom-right corner to resize it."}
        </p>
        {confirm && w && (
          <div className="confirm">
            <p className="note">Remove <b>{w.name}</b>? Its {sessions.length} session{sessions.length === 1 ? "" : "s"} go back to the Unassigned lot.</p>
            <div className="acts">
              <button className="btn bad" onClick={() => ctx.send({ type: "removeWorkstream", workstreamId: w.id }).then((r) => { if (!r.error) ctx.select(null); })}>Remove</button>
              <button className="btn" onClick={() => setConfirm(false)}>Keep it</button>
            </div>
          </div>
        )}
        <div className="acts">
          {w && <button className="btn" onClick={() => setRenaming(true)}>Rename</button>}
          {ended.length > 0 && <button className="btn" onClick={archiveEnded}>Archive ended ({ended.length})</button>}
          {a.archived.length > 0 && <button className="btn" onClick={() => ctx.select({ kind: "chest", id: a.id }, true)}>Open chest</button>}
          {w && !confirm && <button className="btn" onClick={() => setConfirm(true)}>Remove…</button>}
        </div>
      </div>
    </section>
  );
}

function ChestPanel({ ctx, a }: { ctx: Ctx; a: AreaView }) {
  const list = a.archived.map((id) => ctx.state.sessions[id]!);
  return (
    <section className="panel" id="inspector" aria-live="polite">
      <Title onClose={() => ctx.select(null)}>Chest</Title>
      <div className="inset">
        <div className="ent-head"><ChestIcon color={a.color} /><div><div className="ent-title">{a.name}</div><div className="ent-sub">Archived sessions, next to their area</div></div></div>
        {list.length ? (
          <ul className="log">
            {list.slice(0, 40).map((s) => (
              <li key={s.id} className="row">
                <Chip mono={s.mono} color={a.color} />
                <button className="linkish" onClick={() => ctx.select({ kind: "session", id: s.id })} title={s.title ?? s.name}>{s.name}</button>
                <span className="muted" style={{ flex: "none" }}>{ago(s.archived!.at)}</span>
                <button className="btn mini" onClick={() => ctx.send({ type: "restore", sessionId: s.id })}>Restore</button>
              </li>
            ))}
            {list.length > 40 && <li>and {list.length - 40} more</li>}
          </ul>
        ) : <p className="note">Empty.</p>}
        <p className="note">Archive takes a session off the map; nothing else disappears. Restore puts it back in its area. Handoffs come in M4.</p>
      </div>
    </section>
  );
}

// ---------- alerts, hotbar, legend ----------
export function Alerts({ ctx }: { ctx: Ctx }) {
  const idx = useRef<Record<string, number>>({});
  const cycle = (k: "needsYou" | "yourMove") => {
    const list = ctx.model[k];
    if (!list.length) return;
    const i = ((idx.current[k] ?? -1) + 1) % list.length;
    idx.current[k] = i;
    ctx.select({ kind: "session", id: list[i]! }, true);
  };
  const { needsYou, yourMove } = ctx.model;
  return (
    <div id="alerts">
      {needsYou.length > 0 && (
        <button className="al red" onClick={() => cycle("needsYou")} aria-label={`Needs you: ${needsYou.length}`} title="Needs you: a permission prompt, a question or a failed turn. Click to go there; click again for the next.">
          <WarnGlyph color="#ff5a4e" /><span className="n">{needsYou.length}</span>
        </button>
      )}
      {yourMove.length > 0 && (
        <button className="al" onClick={() => cycle("yourMove")} aria-label={`Your move: ${yourMove.length}`} title="Your move: the turn ended. Click to go there; click again for the next.">
          <YourMoveGlyph color="#f0b44a" /><span className="n">{yourMove.length}</span>
        </button>
      )}
    </div>
  );
}

const DOT: Record<string, string> = { needs_you: "#ff5a4e", waiting: "#f0b44a", working: "#7bd88f" };

export function Hotbar({ ctx }: { ctx: Ctx }) {
  return (
    <section className="panel" id="hotbar" aria-label="Hotbar">
      {Array.from({ length: HOTBAR_SLOTS }, (_, i) => {
        const m = ctx.model.pins[i];
        if (!m) return (
          <span key={i} className="slot empty" data-hb={i} title="Empty. Drag a session here, or press Pin to hotbar in its panel.">
            <span className="kn">{keyOf(i)}</span>
          </span>
        );
        const sel = ctx.selection?.kind === "session" && ctx.selection.id === m.id;
        return (
          <button key={i} className={`slot ${sel ? "sel" : ""}`} data-hb={i} onClick={() => ctx.select({ kind: "session", id: m.id }, true)}
            onContextMenu={(e) => { e.preventDefault(); ctx.send({ type: "pin", slot: i, ref: null }); }}
            title={`${m.s.name} · ${STATUS_LABEL[m.s.status]}\n${keyOf(i)} to jump there · right-click to unpin`} aria-label={`${m.s.name}, ${STATUS_LABEL[m.s.status]}`}>
            <span className="bgic"><ShapeIcon shape={m.shape} color={m.color} /></span>
            <span className="mg" style={{ color: m.color }}>{m.s.mono}</span>
            <span className="kn">{keyOf(i)}</span>
            {DOT[m.s.status] && <span className="dot" style={{ background: DOT[m.s.status] }} />}
          </button>
        );
      })}
    </section>
  );
}

const LEGEND_KEY = "foundry.factory.legend";

export function Legend() {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(LEGEND_KEY) !== "closed"; } catch { return true; } });
  const set = (v: boolean) => { setOpen(v); try { localStorage.setItem(LEGEND_KEY, v ? "open" : "closed"); } catch { /* not remembered */ } };
  if (!open) return <button className="btn" id="legendOpen" onClick={() => set(true)}>How it works</button>;
  return (
    <section className="panel" id="legend" aria-label="How it works">
      <Title onClose={() => set(false)}>How it works</Title>
      <div className="inset">
        <ul>
          <li><ShapeIcon shape="square" color="#b38cff" /><span><b>Workstreams</b> are areas, each with its own colour and shape. Make one with <b>+ Workstream</b>.</span></li>
          <li><LotIcon color={LOT_COLOR} /><span>The <b>Unassigned lot</b> holds sessions that belong to no workstream. Drag one into an area to assign it.</span></li>
          <li><StateIcon state="working" /><span><b>Machines</b> are sessions. The core spins while it works, turns <b style={{ color: "#f0b44a" }}>amber</b> on your move and <b style={{ color: "#ff5a4e" }}>red</b> when it needs you. Hollow is idle, grey has ended.</span></li>
          <li><BotIcon color="#4fc3d9" /><span><b>Bots</b> circling a machine are its running subagents and workflow agents.</span></li>
          <li><ChestIcon color="#b38cff" /><span>Each area's <b>chest</b> keeps the sessions you archive there. Restore puts one back.</span></li>
        </ul>
        <div className="keys">Drag to pan · wheel to zoom · <kbd>F</kbd> fit · <kbd>1</kbd>–<kbd>0</kbd> hotbar · hold <kbd>Alt</kbd> for titles · <kbd>Esc</kbd> cancel</div>
      </div>
    </section>
  );
}

// ---------- toasts, tooltip, hint ----------
export interface ToastItem { id: number; text: string; bad?: boolean }

export function Toasts({ items }: { items: ToastItem[] }) {
  return <div id="toasts" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.bad ? "bad" : ""}`}>{t.text}</div>)}</div>;
}

export type HoverInfo = { hit: import("../model").Hit; x: number; y: number } | null;

export function Tooltip({ bus, ctx }: { bus: Bus<HoverInfo>; ctx: Ctx }) {
  const h = useBus(bus);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useEffect(() => {
    if (!h || !ref.current) return;
    const el = ref.current;
    setPos({ left: Math.min(h.x + 16, innerWidth - el.offsetWidth - 8), top: Math.min(h.y + 18, innerHeight - el.offsetHeight - 8) });
  }, [h]);
  if (!h) return null;
  let a = "", b = "", c = "", x = "";
  const hit = h.hit;
  if (hit.kind === "machine") {
    const m = ctx.model.machine[hit.id];
    if (!m) return null;
    const s = m.s;
    a = `${s.mono} · ${s.name}`;
    b = [s.status === "needs_you" && s.notification ? s.notification : STATUS_LABEL[s.status], (s.entrypoint && APPS[s.entrypoint]) || s.entrypoint, folder(s.cwd)].filter(Boolean).join(" · ");
    c = s.activeSubagents ? `${s.activeSubagents} bot${s.activeSubagents === 1 ? "" : "s"} working` : s.title && s.title !== s.name ? s.title : "";
    x = "Click for details. Drag it into a workstream, or onto the hotbar to pin it.";
  } else {
    const ar = ctx.model.area[hit.id];
    if (!ar) return null;
    a = ar.name;
    if (hit.kind === "chest") { b = `${ar.archived.length} archived`; x = "Click to see them and restore one."; }
    else if (hit.kind === "grip") x = "Drag to resize the area.";
    else x = "Drag to move the area. Click for details.";
  }
  return (
    <div id="tip" ref={ref} style={pos}>
      <b>{a}</b>{b && <span className="s">{b}</span>}{c && <span className="s">{c}</span>}<span className="s x">{x}</span>
    </div>
  );
}

export function Hint({ bus }: { bus: Bus<string | null> }) {
  const text = useBus(bus);
  return text ? <div id="hint">{text}</div> : null;
}

