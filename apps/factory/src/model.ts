import {
  areaProblem, areaIdOf, layout, LOT_ID, placeProblem, SLOT,
  type AgentState, type Area, type FoundryState, type Intent, type SessionState, type SessionStatus, type Shape,
} from "@foundry/protocol";

/**
 * What the factory draws, worked out from the core's state. Pure, so it is tested without a canvas.
 * The view never decides a status or a spot itself: statuses come from the state, spots from the protocol's layout.
 */

export const LOT_COLOR = "#9b978e";
/** Colours offered for new workstreams. Red and amber are kept for "needs you" and "your move". */
export const PALETTE = ["#b38cff", "#4fc3d9", "#7bd88f", "#ff7eb6", "#7aa2ff", "#d8c3a5"];

/** Where a machine sits inside its slot, in tiles from the slot's top-left. */
export const MACHINE = { cx: SLOT / 2, cy: 1.2, r: 0.85, labelY: 2.6 } as const;

export const STATUS_LABEL: Record<SessionStatus, string> = {
  needs_you: "Needs you", working: "Working", waiting: "Your move", idle: "Idle", ended: "Ended",
};
export const APPS: Record<string, string> = { "claude-desktop": "Desktop", "claude-vscode": "VS Code", cli: "CLI", "sdk-cli": "SDK" };

export interface Counts { working: number; needsYou: number; yourMove: number; idle: number; ended: number; bots: number }

export interface AreaView {
  id: string;
  isLot: boolean;
  name: string;
  color: string;
  /** Sessions in the lot are drawn as circles in a neutral colour. */
  shape: Shape;
  /** As drawn (grown to fit what was packed into it). */
  rect: Area;
  /** As set: moving and resizing start from this. */
  declared: Area;
  sessions: string[];
  /** Archived sessions whose chest is this area's. */
  archived: string[];
  counts: Counts;
}

export interface MachineView {
  id: string;
  s: SessionState;
  areaId: string;
  /** The slot's top-left on the map, in tiles. */
  x: number;
  y: number;
  /** Relative to the area, as the core stores it. */
  rx: number;
  ry: number;
  placed: boolean;
  color: string;
  shape: Shape;
  /** Running subagents and workflow agents, drawn as bots. */
  bots: AgentState[];
}

export interface Model {
  areas: AreaView[];
  area: Record<string, AreaView>;
  machines: MachineView[];
  machine: Record<string, MachineView>;
  /** Sessions to look at, most urgent first, then most recent. */
  needsYou: string[];
  yourMove: string[];
  /** Hotbar slots; null when empty or when the pinned session isn't on the map. */
  pins: (MachineView | null)[];
  /** Everything drawn, for Fit. */
  bounds: Area;
}

const emptyCounts = (): Counts => ({ working: 0, needsYou: 0, yourMove: 0, idle: 0, ended: 0, bots: 0 });

export function count(c: Counts, s: SessionState) {
  if (s.status === "working") c.working++;
  else if (s.status === "needs_you") c.needsYou++;
  else if (s.status === "waiting") c.yourMove++;
  else if (s.status === "idle") c.idle++;
  else c.ended++;
  c.bots += s.activeSubagents;
}

export function buildModel(state: FoundryState): Model {
  const lay = layout(state);
  const areas: AreaView[] = [];
  const area: Record<string, AreaView> = {};
  for (const a of Object.values(lay.areas)) {
    const w = a.id === LOT_ID ? null : state.workstreams[a.id]!;
    const v: AreaView = {
      id: a.id, isLot: !w, name: w ? w.name : "Unassigned", color: w ? w.color : LOT_COLOR, shape: w ? w.shape : "circle",
      rect: a.rect, declared: a.declared, sessions: a.sessions, archived: [], counts: emptyCounts(),
    };
    areas.push(v);
    area[v.id] = v;
  }
  const machines: MachineView[] = [];
  const machine: Record<string, MachineView> = {};
  for (const s of Object.values(state.sessions)) {
    if (s.pending) continue;
    if (s.archived) { (area[areaIdOf(s)] ?? area[LOT_ID]!).archived.push(s.id); continue; }
    const spot = lay.spots[s.id];
    if (!spot) continue;
    const a = area[spot.areaId]!;
    const m: MachineView = {
      id: s.id, s, areaId: a.id, x: a.rect.x + spot.x, y: a.rect.y + spot.y, rx: spot.x, ry: spot.y, placed: spot.placed,
      color: a.color, shape: a.shape, bots: Object.values(s.agents).filter((g) => g.running),
    };
    machines.push(m);
    machine[s.id] = m;
    count(a.counts, s);
  }
  for (const a of areas) a.archived.sort((p, q) => (state.sessions[q]!.archived!.at - state.sessions[p]!.archived!.at));
  const recent = (p: string, q: string) => machine[q]!.s.lastActivityAt - machine[p]!.s.lastActivityAt;
  const needsYou = machines.filter((m) => m.s.status === "needs_you").map((m) => m.id).sort(recent);
  const yourMove = machines.filter((m) => m.s.status === "waiting").map((m) => m.id).sort(recent);
  const pins = state.pins.map((p) => (p && machine[p.id]) || null);
  const xs = areas.flatMap((a) => [a.rect.x, a.rect.x + a.rect.w]), ys = areas.flatMap((a) => [a.rect.y, a.rect.y + a.rect.h]);
  const bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  return { areas, area, machines, machine, needsYou, yourMove, pins, bounds };
}

const inRect = (r: Area, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** The machine whose slot is under a point on the map. */
export function machineAt(model: Model, wx: number, wy: number): MachineView | null {
  for (let i = model.machines.length - 1; i >= 0; i--) {
    const m = model.machines[i]!;
    if (inRect({ x: m.x, y: m.y, w: SLOT, h: SLOT }, wx, wy)) return m;
  }
  return null;
}

/** The area under a point, including its label band above the top edge. */
export function areaAt(model: Model, wx: number, wy: number, withLabel = false): AreaView | null {
  for (const a of model.areas) {
    const r = withLabel ? { ...a.rect, y: a.rect.y - LABEL_BAND, h: a.rect.h + LABEL_BAND } : a.rect;
    if (inRect(r, wx, wy)) return a;
  }
  return null;
}

/** The label band above an area: drag it to move the area. */
export const LABEL_BAND = 1.2;
/** The chest sits at the right end of the label band. */
export const chestRect = (a: AreaView): Area => ({ x: a.rect.x + a.rect.w - 1.6, y: a.rect.y - 1.25, w: 1.6, h: 1.1 });
/** The resize grip in an area's bottom-right corner. */
export const gripRect = (a: AreaView): Area => ({ x: a.rect.x + a.rect.w - 1, y: a.rect.y + a.rect.h - 1, w: 1, h: 1 });

export type Hit =
  | { kind: "machine"; id: string }
  | { kind: "chest"; id: string }
  | { kind: "grip"; id: string }
  | { kind: "label"; id: string }
  | { kind: "area"; id: string };

/** What is under a point on the map, most specific first. */
export function hitTest(model: Model, wx: number, wy: number): Hit | null {
  const m = machineAt(model, wx, wy);
  if (m) return { kind: "machine", id: m.id };
  for (const a of model.areas) {
    if (inRect(chestRect(a), wx, wy)) return { kind: "chest", id: a.id };
    if (inRect(gripRect(a), wx, wy)) return { kind: "grip", id: a.id };
    if (wy >= a.rect.y - LABEL_BAND && wy < a.rect.y && wx >= a.rect.x && wx <= a.rect.x + a.rect.w) return { kind: "label", id: a.id };
  }
  const a = areaAt(model, wx, wy);
  return a ? { kind: "area", id: a.id } : null;
}

const slotsHit = (ax: number, ay: number, bx: number, by: number) => ax < bx + SLOT && ax + SLOT > bx && ay < by + SLOT && ay + SLOT > by;

export interface DropPlan {
  areaId: string;
  /** Relative to the area. */
  x: number;
  y: number;
  /** The intent to send, or null when the session is already there. */
  intent: Intent | null;
  /** Why it can't go there; the ghost turns red and nothing is sent. */
  problem: string | null;
}

/**
 * Where a session dragged to a point would land, and what to ask the core. The spot is the slot centred on the
 * pointer, nudged inside the area. It is stricter than the core: a packed session blocks a spot here too, so a drop
 * never shoves another session along.
 */
export function planDrop(state: FoundryState, model: Model, sessionId: string, wx: number, wy: number): DropPlan | null {
  const a = areaAt(model, wx, wy);
  if (!a) return null;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  const x = clamp(Math.round(wx - a.rect.x - SLOT / 2), a.declared.w - SLOT);
  const y = clamp(Math.round(wy - a.rect.y - SLOT / 2), a.declared.h - SLOT);
  const me = model.machine[sessionId];
  const plan = (intent: Intent | null, problem: string | null): DropPlan => ({ areaId: a.id, x, y, intent: problem ? null : intent, problem });
  if (me && me.areaId === a.id && me.rx === x && me.ry === y) return plan(null, null);
  const problem = placeProblem(state, a.id, x, y, sessionId)
    ?? (model.machines.some((m) => m.id !== sessionId && m.areaId === a.id && slotsHit(m.rx, m.ry, x, y)) ? "Something is already there" : null);
  const intent: Intent = me && me.areaId === a.id
    ? { type: "move", sessionId, x, y }
    : { type: "assign", sessionId, workstreamId: a.isLot ? null : a.id, position: { x, y } };
  return plan(intent, problem);
}

/** Moving an area by whole tiles, or resizing it to the pointer; the ghost shows whether the core would take it. */
export function planArea(state: FoundryState, model: Model, areaId: string, mode: "move" | "resize", dx: number, dy: number, wx: number, wy: number) {
  const a = model.area[areaId]!;
  const d = a.declared;
  const next = mode === "move"
    ? { ...d, x: d.x + Math.round(dx), y: d.y + Math.round(dy) }
    : { ...d, w: Math.max(SLOT, Math.round(wx - d.x)), h: Math.max(SLOT, Math.round(wy - d.y)) };
  const same = next.x === d.x && next.y === d.y && next.w === d.w && next.h === d.h;
  const problem = same ? null : areaProblem(state, next, areaId);
  const intent: Intent | null = same || problem ? null : { type: "setArea", areaId, area: next };
  return { area: next, intent, problem };
}

/** "agent-foundry ⎇ inspiring-wozniak" for a worktree, else the folder's last part. */
export function folder(cwd: string | null): string {
  if (!cwd) return "—";
  const wt = cwd.match(/\/([^/]+)\/\.claude\/worktrees\/([^/]+)/);
  if (wt) return `${wt[1]} ⎇ ${wt[2]}`;
  return cwd.split("/").filter(Boolean).pop() || cwd;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
