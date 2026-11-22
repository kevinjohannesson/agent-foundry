import type { Area, FoundryState, SessionState } from "./state";

/**
 * The map's layout rules, shared by the core (which checks intents with them) and renderers (which draw with them),
 * so both agree on where everything is. Pure functions of the state.
 *
 * Areas are the Unassigned lot and the workstreams. A session takes one slot: a 2x2 machine with its name under it.
 * Positions are whole tiles, relative to the area's top-left corner.
 */

/** The lot's area id. No workstream gets this id. */
export const LOT_ID = "unassigned";
/** A slot is this many tiles wide and high. */
export const SLOT = 3;
/** The least room between two areas, so their labels and chests don't touch. */
export const AREA_GAP = 2;
/** The smallest area holds one session; the largest is generous but bounded. */
export const MIN_AREA = SLOT;
export const MAX_AREA = 300;
/** A new workstream's area when you don't draw one: 5 x 4 slots. */
export const DEFAULT_WORKSTREAM_SIZE = { w: 15, h: 12 } as const;
/** How wide a row of areas gets before a new workstream goes on the next row. */
const MAX_ROW = 100;

/** Sessions the map draws. Pending ones haven't done anything yet (or were pre-warmed ghosts); archived ones are in a chest. */
export const onMap = (s: SessionState) => !s.pending && !s.archived;
export const areaIdOf = (s: Pick<SessionState, "workstreamId">) => s.workstreamId ?? LOT_ID;
export const areaIds = (state: FoundryState) => [LOT_ID, ...Object.keys(state.workstreams)];

export function declaredArea(state: FoundryState, areaId: string): Area | undefined {
  return areaId === LOT_ID ? state.lot.area : state.workstreams[areaId]?.area;
}

/** Whether a slot at (x, y) lies entirely inside an area of this size. */
export function fits(area: Pick<Area, "w" | "h">, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x + SLOT <= area.w && y + SLOT <= area.h;
}

const slotsHit = (ax: number, ay: number, bx: number, by: number) =>
  ax < bx + SLOT && ax + SLOT > bx && ay < by + SLOT && ay + SLOT > by;
export const rectsOverlap = (a: Area, b: Area) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const grow = (a: Area, d: number): Area => ({ x: a.x - d, y: a.y - d, w: a.w + 2 * d, h: a.h + 2 * d });
/** Closer than AREA_GAP tiles. */
const tooClose = (a: Area, b: Area) => rectsOverlap(grow(a, AREA_GAP / 2), grow(b, AREA_GAP / 2));

/** Packing order for sessions you haven't placed: live ones before ended ones, then oldest first. */
function packOrder(a: SessionState, b: SessionState): number {
  return Number(a.status === "ended") - Number(b.status === "ended") || a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1);
}

export interface Spot {
  areaId: string;
  /** Tiles from the area's top-left. */
  x: number;
  y: number;
  /** You put it here (true), or it was packed into the first free slot (false). */
  placed: boolean;
}

export interface AreaLayout {
  id: string;
  /** The area as set. */
  declared: Area;
  /** As drawn: the declared area, made taller when more sessions are packed into it than it holds. */
  rect: Area;
  /** Session ids on the map in this area. */
  sessions: string[];
}

export interface Layout {
  areas: Record<string, AreaLayout>;
  spots: Record<string, Spot>;
}

/**
 * Where every session on the map is. Placed sessions keep their spot; the rest fill the free slots of a 3-tile grid,
 * row by row, in packOrder. An area that runs out of room grows downward rather than hiding anything.
 */
export function layout(state: FoundryState): Layout {
  const areas: Record<string, AreaLayout> = {};
  const spots: Record<string, Spot> = {};
  const byArea = new Map<string, SessionState[]>(areaIds(state).map((id) => [id, []]));
  for (const s of Object.values(state.sessions)) {
    if (!onMap(s)) continue;
    (byArea.get(areaIdOf(s)) ?? byArea.get(LOT_ID)!).push(s);
  }
  for (const [id, list] of byArea) {
    const declared = declaredArea(state, id)!;
    const taken: { x: number; y: number }[] = [];
    const loose: SessionState[] = [];
    for (const s of list) {
      // A session whose workstream is gone falls back to the lot; its old position meant the other area.
      const p = areaIdOf(s) === id ? s.position : null;
      if (p && fits(declared, p.x, p.y) && !taken.some((t) => slotsHit(t.x, t.y, p.x, p.y))) {
        taken.push(p);
        spots[s.id] = { areaId: id, x: p.x, y: p.y, placed: true };
      } else loose.push(s);
    }
    loose.sort(packOrder);
    const cols = Math.max(1, Math.floor(declared.w / SLOT));
    let cell = 0;
    for (const s of loose) {
      for (;; cell++) {
        const x = (cell % cols) * SLOT, y = Math.floor(cell / cols) * SLOT;
        if (taken.some((t) => slotsHit(t.x, t.y, x, y))) continue;
        taken.push({ x, y });
        spots[s.id] = { areaId: id, x, y, placed: false };
        cell++;
        break;
      }
    }
    const h = Math.max(declared.h, ...taken.map((t) => t.y + SLOT));
    areas[id] = { id, declared, rect: { ...declared, h }, sessions: list.map((s) => s.id) };
  }
  return { areas, spots };
}

/** Why a session can't be put at (x, y) in an area, or null if it can. Only placed sessions block a spot. */
export function placeProblem(state: FoundryState, areaId: string, x: number, y: number, sessionId?: string): string | null {
  const area = declaredArea(state, areaId);
  if (!area) return `There is no area ${areaId}`;
  if (!fits(area, x, y)) return "That spot is outside the area";
  for (const s of Object.values(state.sessions)) {
    if (s.id === sessionId || !onMap(s) || areaIdOf(s) !== areaId || !s.position) continue;
    if (fits(area, s.position.x, s.position.y) && slotsHit(s.position.x, s.position.y, x, y)) return `${s.name} is already there`;
  }
  return null;
}

/** Why an area can't be set to `area` (too small or big, or too close to another area), or null if it can. */
export function areaProblem(state: FoundryState, area: Area, exceptId?: string): string | null {
  if (![area.x, area.y, area.w, area.h].every(Number.isInteger)) return "Areas sit on whole tiles";
  if (area.w < MIN_AREA || area.h < MIN_AREA) return `An area is at least ${MIN_AREA} x ${MIN_AREA} tiles`;
  if (area.w > MAX_AREA || area.h > MAX_AREA) return `An area is at most ${MAX_AREA} x ${MAX_AREA} tiles`;
  const lay = layout(state);
  for (const a of Object.values(lay.areas)) {
    if (a.id === exceptId) continue;
    if (tooClose(area, a.rect)) return `Too close to ${a.id === LOT_ID ? "the Unassigned lot" : state.workstreams[a.id]!.name}`;
  }
  return null;
}

/** The first free spot for a new area of this size: left to right in rows next to the existing areas, then below. */
export function freeArea(state: FoundryState, w: number = DEFAULT_WORKSTREAM_SIZE.w, h: number = DEFAULT_WORKSTREAM_SIZE.h): Area {
  const rects = Object.values(layout(state).areas).map((a) => a.rect);
  const minX = Math.min(...rects.map((r) => r.x)), minY = Math.min(...rects.map((r) => r.y));
  for (let y = minY; ; y += SLOT) {
    for (let x = minX; x + w <= minX + Math.max(MAX_ROW, w); x++) {
      const a = { x, y, w, h };
      if (!rects.some((r) => tooClose(a, r))) return a;
    }
  }
}
