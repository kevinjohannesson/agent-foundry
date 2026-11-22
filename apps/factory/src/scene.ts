import { Application, Container, Graphics, Text } from "pixi.js";
import { LOT_ID, SLOT, type Area, type FoundryState, type Intent, type Shape } from "@foundry/protocol";
import {
  chestRect, gripRect, hitTest, LABEL_BAND, MACHINE, planArea, planDrop,
  type AreaView, type DropPlan, type Hit, type MachineView, type Model,
} from "./model";
import { C, HEAD, MONO } from "./theme";

/**
 * The map, drawn with PixiJS from the model. It owns the camera and pointer handling; everything it changes goes back
 * to the core as an intent, and the map only moves once the core's new state arrives.
 */

export type Selection = { kind: "session" | "area" | "chest"; id: string } | null;

export interface SceneEvents {
  select(sel: Selection): void;
  intent(intent: Intent): void;
  pin(slot: number, sessionId: string): void;
  hover(h: { hit: Hit; x: number; y: number } | null): void;
  hint(text: string | null): void;
  toast(text: string): void;
}

/** Pixels per tile at zoom 1. */
const T = 28;
const CAM_KEY = "foundry.factory.cam";

type Drag =
  | { kind: "machine"; id: string; plan: DropPlan | null; w: { x: number; y: number } }
  | { kind: "move" | "resize"; id: string; plan: ReturnType<typeof planArea> }
  | { kind: "pan" };

interface Down { sx: number; sy: number; cx: number; cy: number; hit: Hit | null; w: { x: number; y: number }; moved: boolean }

const hashAngle = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return ((h >>> 0) % 628) / 100; };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Polygon points for a shape centred on (cx, cy), turned by `rot`. Circles are drawn as circles. */
function polyPoints(shape: Shape | "diamond", cx: number, cy: number, r: number, rot = 0): number[] {
  const pts: number[] = [];
  const at = (a: number, rr = r) => pts.push(cx + Math.cos(a + rot) * rr, cy + Math.sin(a + rot) * rr);
  if (shape === "square") for (let i = 0; i < 4; i++) at(Math.PI / 4 + (i * Math.PI) / 2, r * 1.25);
  else if (shape === "diamond") for (let i = 0; i < 4; i++) at((i * Math.PI) / 2);
  else if (shape === "hex") for (let i = 0; i < 6; i++) at(Math.PI / 6 + (i * Math.PI) / 3);
  else if (shape === "triangle") for (let i = 0; i < 3; i++) at(-Math.PI / 2 + (i * 2 * Math.PI) / 3, r * 1.15);
  return pts;
}

function shape(g: Graphics, kind: Shape | "diamond", cx: number, cy: number, r: number, rot = 0): Graphics {
  return kind === "circle" ? g.circle(cx, cy, r) : g.poly(polyPoints(kind, cx, cy, r, rot), true);
}

function dashedRect(g: Graphics, r: Area, dash: number, gap: number) {
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const L = Math.hypot(x2 - x1, y2 - y1), dx = (x2 - x1) / L, dy = (y2 - y1) / L;
    for (let d = 0; d < L; d += dash + gap) { const e = Math.min(L, d + dash); g.moveTo(x1 + dx * d, y1 + dy * d).lineTo(x1 + dx * e, y1 + dy * e); }
  };
  line(r.x, r.y, r.x + r.w, r.y); line(r.x + r.w, r.y, r.x + r.w, r.y + r.h);
  line(r.x + r.w, r.y + r.h, r.x, r.y + r.h); line(r.x, r.y + r.h, r.x, r.y);
}

function brackets(g: Graphics, r: Area, pad: number, len: number) {
  const x = r.x - pad, y = r.y - pad, w = r.w + pad * 2, h = r.h + pad * 2;
  for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]] as const)
    g.moveTo(cx, cy + sy * len).lineTo(cx, cy).lineTo(cx + sx * len, cy);
}

export class Scene {
  readonly app = new Application();
  on: SceneEvents;
  selection: Selection = null;
  alt = false;
  private world = new Container();
  private grid = new Graphics();
  private areas = new Graphics();
  private machines = new Graphics();
  private over = new Graphics();
  private labels = new Container();
  private texts = new Map<string, { t: Text; sig: string }>();
  private used = new Set<string>();
  private model: Model | null = null;
  private state: FoundryState | null = null;
  private cam = { x: 10, y: 8, z: 1 };
  private camTarget: { x: number; y: number } | null = null;
  private camSaved = "";
  private camSavedAt = 0;
  private fitted = false;
  private down: Down | null = null;
  private drag: Drag | null = null;
  private hoverArea: string | null = null;
  private reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private ready = false;
  private gone = false;

  constructor(private host: HTMLElement, on: SceneEvents) {
    this.on = on;
    try {
      const c = JSON.parse(localStorage.getItem(CAM_KEY) || "null");
      if (c && [c.x, c.y, c.z].every(Number.isFinite)) { this.cam = c; this.fitted = true; }
    } catch { /* no saved camera: Fit on the first state */ }
  }

  async init() {
    await this.app.init({ resizeTo: this.host, background: C.ground, antialias: true, autoDensity: true, resolution: Math.min(2, devicePixelRatio || 1) });
    if (this.gone) { this.app.destroy(true); return; }
    this.app.canvas.setAttribute("aria-label", "Factory map of your Claude Code sessions");
    this.host.appendChild(this.app.canvas);
    this.world.addChild(this.grid, this.areas, this.machines, this.over);
    this.app.stage.addChild(this.world, this.labels);
    this.bindPointer(this.app.canvas);
    this.app.ticker.add((t) => this.frame(t.deltaMS / 1000));
    this.ready = true;
    if (this.model && !this.fitted) { this.fit(); this.fitted = true; }
    // Text drawn before the web fonts load keeps the fallback font: draw it again once they are in.
    const fonts = ['600 12px "Chakra Petch"', '700 12px "Chakra Petch"', '500 12px "IBM Plex Mono"'];
    Promise.all(fonts.map((f) => document.fonts.load(f))).catch(() => {}).then(() => {
      for (const { t } of this.texts.values()) t.destroy();
      this.texts.clear();
    });
  }

  destroy() {
    this.gone = true;
    if (this.ready) this.app.destroy(true, { children: true });
  }

  setData(model: Model, state: FoundryState) {
    this.model = model;
    this.state = state;
    if (!this.fitted && this.ready) { this.fit(); this.fitted = true; }
    if (this.drag?.kind === "machine" && !model.machine[this.drag.id]) this.cancelDrag();
  }

  // ---------- camera ----------
  private get S() { return T * this.cam.z; }
  private get vw() { return this.app.screen.width; }
  private get vh() { return this.app.screen.height; }
  private s2w(sx: number, sy: number) { return { x: this.cam.x + (sx - this.vw / 2) / this.S, y: this.cam.y + (sy - this.vh / 2) / this.S }; }
  private w2s(x: number, y: number) { return { x: (x - this.cam.x) * this.S + this.vw / 2, y: (y - this.cam.y) * this.S + this.vh / 2 }; }

  /** Everything in view, leaving room for the overview panel on the left and the hotbar at the bottom. */
  fit() {
    if (!this.model || !this.ready) return;
    // On a phone the overview sits across the top instead of on the left.
    const b = this.model.bounds, left = this.vw > 1000 ? 330 : 0, top = this.vw <= 760 ? 250 : 0, bottom = 80;
    const w = b.w + 4, h = b.h + 6;
    this.cam.z = clamp(Math.min((this.vw - left - 40) / (w * T), (this.vh - top - bottom - 40) / (h * T)), 0.3, 1.6);
    this.cam.x = b.x + b.w / 2 - left / 2 / this.S;
    this.cam.y = b.y - 1 + b.h / 2 + (bottom - top) / 2 / this.S;
    this.camTarget = null;
  }

  zoomBy(f: number, sx = this.vw / 2, sy = this.vh / 2) {
    const w = this.s2w(sx, sy);
    this.cam.z = clamp(this.cam.z * f, 0.25, 2.6);
    this.cam.x = w.x - (sx - this.vw / 2) / this.S;
    this.cam.y = w.y - (sy - this.vh / 2) / this.S;
    this.camTarget = null;
  }

  /** Flies the camera to a session or area, leaving room for the inspector on the right. */
  focus(sel: Selection) {
    if (!sel || !this.model) return;
    const r = this.rectOf(sel);
    if (!r) return;
    const side = this.vw > 760 ? 180 / this.S : 0;
    this.camTarget = { x: r.x + r.w / 2 + side, y: r.y + r.h / 2 };
  }

  private rectOf(sel: NonNullable<Selection>): Area | null {
    const m = this.model!;
    if (sel.kind === "session") { const v = m.machine[sel.id]; return v ? { x: v.x, y: v.y, w: SLOT, h: SLOT } : null; }
    const a = m.area[sel.id];
    if (!a) return null;
    return sel.kind === "chest" ? chestRect(a) : a.rect;
  }

  cancelDrag() {
    if (!this.drag) return false;
    this.drag = null;
    this.down = null;
    this.on.hint(null);
    return true;
  }

  // ---------- pointer ----------
  private bindPointer(cv: HTMLCanvasElement) {
    const local = (e: PointerEvent | WheelEvent) => { const r = cv.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; };
    cv.addEventListener("pointerdown", (e) => {
      if (e.button === 2) { this.cancelDrag(); return; }
      if (e.button !== 0 || !this.model) return;
      const { sx, sy } = local(e), w = this.s2w(sx, sy);
      this.down = { sx, sy, cx: this.cam.x, cy: this.cam.y, hit: hitTest(this.model, w.x, w.y), w, moved: false };
      cv.setPointerCapture(e.pointerId);
      this.on.hover(null);
    });
    cv.addEventListener("pointermove", (e) => {
      const { sx, sy } = local(e), w = this.s2w(sx, sy);
      const d = this.down;
      if (d && this.model && this.state) {
        if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) > 5) {
          d.moved = true;
          const h = d.hit;
          if (h?.kind === "machine") this.drag = { kind: "machine", id: h.id, plan: null, w };
          else if (h?.kind === "label") this.drag = { kind: "move", id: h.id, plan: planArea(this.state, this.model, h.id, "move", 0, 0, w.x, w.y) };
          else if (h?.kind === "grip") this.drag = { kind: "resize", id: h.id, plan: planArea(this.state, this.model, h.id, "resize", 0, 0, w.x, w.y) };
          else this.drag = { kind: "pan" };
          cv.style.cursor = this.drag.kind === "pan" ? "grabbing" : this.drag.kind === "resize" ? "nwse-resize" : this.drag.kind === "move" ? "move" : "grabbing";
        }
        const g = this.drag;
        if (g?.kind === "pan") { this.cam.x = d.cx - (sx - d.sx) / this.S; this.cam.y = d.cy - (sy - d.sy) / this.S; this.camTarget = null; }
        else if (g?.kind === "machine") {
          g.w = w;
          g.plan = planDrop(this.state, this.model, g.id, w.x, w.y);
          const name = this.model.machine[g.id]?.s.name ?? "it";
          const into = g.plan ? this.model.area[g.plan.areaId]!.name : null;
          this.on.hint(g.plan?.problem ? `${g.plan.problem}` : into ? `Drop ${name} in ${into}` : `Drop ${name} inside an area, or on a hotbar slot to pin it`);
        } else if (g) {
          g.plan = planArea(this.state, this.model, g.id, g.kind, w.x - d.w.x, w.y - d.w.y, w.x, w.y);
          this.on.hint(g.plan.problem ?? (g.kind === "move" ? "Drop to move the area" : "Drop to resize the area"));
        }
        return;
      }
      if (!this.model) return;
      const hit = hitTest(this.model, w.x, w.y);
      this.hoverArea = hit && hit.kind !== "machine" ? hit.id : null;
      cv.style.cursor = !hit || hit.kind === "area" ? "grab" : hit.kind === "label" ? "move" : hit.kind === "grip" ? "nwse-resize" : "pointer";
      this.on.hover(hit && hit.kind !== "area" ? { hit, x: e.clientX, y: e.clientY } : null);
    });
    cv.addEventListener("pointerup", (e) => {
      const d = this.down, g = this.drag;
      this.down = null;
      this.drag = null;
      cv.style.cursor = "grab";
      if (!d || !this.model) return;
      if (g) this.on.hint(null);
      if (!d.moved) { this.click(d.hit); return; }
      if (g?.kind === "machine") {
        const slot = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-hb]");
        if (slot) { this.on.pin(Number(slot.dataset.hb), g.id); return; }
        if (!g.plan) this.on.toast("Drop it inside an area");
        else if (g.plan.problem) this.on.toast(g.plan.problem);
        else if (g.plan.intent) this.on.intent(g.plan.intent);
      } else if (g && g.kind !== "pan") {
        if (g.plan.problem) this.on.toast(g.plan.problem);
        else if (g.plan.intent) this.on.intent(g.plan.intent);
      }
    });
    cv.addEventListener("pointerleave", () => { this.on.hover(null); this.hoverArea = null; });
    cv.addEventListener("wheel", (e) => { e.preventDefault(); const { sx, sy } = local(e); this.zoomBy(Math.exp(-e.deltaY * 0.0015), sx, sy); }, { passive: false });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private click(hit: Hit | null) {
    if (!hit) { this.on.select(null); return; }
    if (hit.kind === "machine") this.on.select({ kind: "session", id: hit.id });
    else if (hit.kind === "chest") this.on.select({ kind: "chest", id: hit.id });
    else this.on.select({ kind: "area", id: hit.id });
  }

  // ---------- drawing ----------
  private text(key: string, str: string, x: number, y: number, o: { size: number; color: string; weight?: string; family?: string; ax?: number; ay?: number; alpha?: number; wrap?: number }) {
    const sig = `${o.size}|${o.color}|${o.weight ?? "500"}|${o.family ?? MONO}|${o.wrap ?? 0}`;
    let e = this.texts.get(key);
    if (!e) {
      e = { t: new Text({ text: str, resolution: Math.min(2, devicePixelRatio || 1) }), sig: "" };
      this.labels.addChild(e.t);
      this.texts.set(key, e);
    }
    const t = e.t;
    if (e.sig !== sig) {
      t.style = { fontFamily: o.family ?? MONO, fontSize: o.size, fill: o.color, fontWeight: (o.weight ?? "500") as "500", wordWrap: !!o.wrap, wordWrapWidth: o.wrap ?? 0, breakWords: true, align: "center", lineHeight: o.size * 1.15 };
      e.sig = sig;
    }
    if (t.text !== str) t.text = str;
    t.anchor.set(o.ax ?? 0.5, o.ay ?? 0.5);
    t.position.set(Math.round(x), Math.round(y));
    t.alpha = o.alpha ?? 1;
    t.visible = true;
    this.used.add(key);
  }

  private frame(dt: number) {
    if (this.camTarget) {
      const k = Math.min(1, dt * 6);
      this.cam.x += (this.camTarget.x - this.cam.x) * k;
      this.cam.y += (this.camTarget.y - this.cam.y) * k;
      if (Math.hypot(this.camTarget.x - this.cam.x, this.camTarget.y - this.cam.y) < 0.02) this.camTarget = null;
    }
    this.saveCam();
    const S = this.S;
    this.world.scale.set(S);
    this.world.position.set(this.vw / 2 - this.cam.x * S, this.vh / 2 - this.cam.y * S);
    const rt = this.reduce ? 0 : performance.now() / 1000;
    this.drawGrid();
    this.areas.clear(); this.machines.clear(); this.over.clear();
    if (this.model) { this.drawAreas(); this.drawMachines(rt); this.drawOverlay(); }
    for (const [k, e] of this.texts) if (!this.used.has(k)) e.t.visible = false;
    this.used.clear();
  }

  private saveCam() {
    const now = performance.now();
    if (now - this.camSavedAt < 500) return;
    this.camSavedAt = now;
    const s = JSON.stringify({ x: +this.cam.x.toFixed(2), y: +this.cam.y.toFixed(2), z: +this.cam.z.toFixed(3) });
    if (s === this.camSaved) return;
    this.camSaved = s;
    try { localStorage.setItem(CAM_KEY, s); } catch { /* the camera just won't be remembered */ }
  }

  private drawGrid() {
    const g = this.grid, S = this.S;
    g.clear();
    const a = this.s2w(0, 0), b = this.s2w(this.vw, this.vh);
    const x0 = Math.floor(a.x) - 1, x1 = Math.ceil(b.x) + 1, y0 = Math.floor(a.y) - 1, y1 = Math.ceil(b.y) + 1;
    if (S > 9) {
      for (let x = x0; x <= x1; x++) g.moveTo(x, y0).lineTo(x, y1);
      for (let y = y0; y <= y1; y++) g.moveTo(x0, y).lineTo(x1, y);
      g.stroke({ width: 1 / S, color: C.grid });
    }
    for (let x = Math.ceil(x0 / 9) * 9; x <= x1; x += 9) g.moveTo(x, y0).lineTo(x, y1);
    for (let y = Math.ceil(y0 / 9) * 9; y <= y1; y += 9) g.moveTo(x0, y).lineTo(x1, y);
    g.stroke({ width: 1 / S, color: C.grid2 });
  }

  private drawAreas() {
    const g = this.areas, S = this.S, model = this.model!;
    const dragArea = this.drag && this.drag.kind !== "pan" && this.drag.kind !== "machine" ? this.drag.id : null;
    const dropArea = this.drag?.kind === "machine" ? this.drag.plan?.areaId : null;
    for (const a of model.areas) {
      const sel = this.selection && this.selection.kind !== "session" && this.selection.id === a.id;
      const active = sel || this.hoverArea === a.id || dropArea === a.id || dragArea === a.id;
      const r = a.rect;
      g.rect(r.x, r.y, r.w, r.h).fill({ color: a.color, alpha: active ? 0.09 : 0.045 });
      dashedRect(g, r, 0.45, 0.3);
      g.stroke({ width: (active ? 2 : 1.5) / S, color: a.color, alpha: active ? 0.9 : 0.4 });
      if (r.h > a.declared.h) {
        // Grown to fit: show where the area as set ends.
        g.moveTo(r.x, r.y + a.declared.h).lineTo(r.x + r.w, r.y + a.declared.h).stroke({ width: 1 / S, color: a.color, alpha: 0.18 });
      }
      const lp = this.w2s(r.x + 0.15, r.y - 0.5);
      const label = a.isLot ? "UNASSIGNED" : a.name.toUpperCase();
      this.text(`area:${a.id}`, label, lp.x, lp.y, { size: clamp(Math.round(S * 0.5), 10, 14), color: a.color, weight: "600", family: HEAD, ax: 0, alpha: 0.95 });
      // The chest: archived sessions of this area.
      const c = chestRect(a), n = a.archived.length;
      g.rect(c.x, c.y, c.w, c.h).fill({ color: C.chest, alpha: n ? 1 : 0.5 }).stroke({ width: 1.5 / S, color: a.color, alpha: n ? 0.7 : 0.3 });
      g.moveTo(c.x, c.y + 0.35).lineTo(c.x + c.w, c.y + 0.35).stroke({ width: 1.5 / S, color: a.color, alpha: n ? 0.7 : 0.3 });
      g.rect(c.x + c.w / 2 - 0.1, c.y + 0.25, 0.2, 0.22).fill({ color: a.color, alpha: n ? 0.7 : 0.3 });
      if (n && S > 11) { const p = this.w2s(c.x + c.w / 2, c.y + 0.78); this.text(`chest:${a.id}`, String(n), p.x, p.y, { size: clamp(Math.round(S * 0.38), 8, 11), color: C.ink }); }
      if (active) {
        const q = gripRect(a);
        g.poly([q.x + q.w, q.y + 0.2, q.x + q.w, q.y + q.h, q.x + 0.2, q.y + q.h], true).fill({ color: a.color, alpha: 0.6 });
      }
    }
  }

  private drawMachines(rt: number) {
    const g = this.machines, S = this.S, model = this.model!;
    const dragging = this.drag?.kind === "machine" ? this.drag.id : null;
    for (const m of model.machines) this.drawMachine(g, m, S, rt, m.id === dragging ? 0.35 : 1);
  }

  private drawMachine(g: Graphics, m: MachineView, S: number, rt: number, alpha: number) {
    const s = m.s, st = s.status, cx = m.x + MACHINE.cx, cy = m.y + MACHINE.cy;
    const ended = st === "ended", needs = st === "needs_you", yours = st === "waiting", working = st === "working", idle = st === "idle";
    const a = alpha * (ended ? 0.6 : 1);
    if (yours) shape(g, m.shape, cx, cy, 1.02).stroke({ width: 1.5 / S, color: C.amber, alpha: 0.55 * a });
    shape(g, m.shape, cx, cy, MACHINE.r).fill({ color: C.body, alpha }).stroke({ width: 2.5 / S, color: m.color, alpha: (ended ? 0.35 : 1) * alpha });
    const rot = working ? rt * 1.6 : 0;
    // In the lot the area colour is grey, which reads as ended: a working core there is green instead.
    const workCol = m.areaId === LOT_ID ? C.green : m.color;
    if (idle) shape(g, m.shape, cx, cy, 0.5).stroke({ width: 2 / S, color: m.color, alpha: 0.5 * a });
    else shape(g, m.shape, cx, cy, 0.5, rot).fill({ color: needs ? C.red : yours ? C.amber : working ? workCol : C.coreOff, alpha: a });
    if (working) {
      g.moveTo(cx + Math.cos(rot - 0.5) * 0.5, cy + Math.sin(rot - 0.5) * 0.5).arc(cx, cy, 0.5, rot - 0.5, rot + 0.5).stroke({ width: 3 / S, color: C.body, alpha });
    }
    if (needs) {
      const pr = this.reduce ? 1 : 0.55 + 0.45 * Math.abs(Math.sin(rt * 3.2));
      shape(g, m.shape, cx, cy, 1.05).stroke({ width: 3 / S, color: C.red, alpha: pr * alpha });
      const bx = cx + 0.85, by = cy - 0.95;
      g.poly([bx, by - 0.45, bx + 0.45, by + 0.33, bx - 0.45, by + 0.33], true).fill({ color: C.red, alpha: pr * alpha });
      g.rect(bx - 0.045, by - 0.2, 0.09, 0.28).fill({ color: "#ffffff", alpha });
      g.rect(bx - 0.045, by + 0.14, 0.09, 0.09).fill({ color: "#ffffff", alpha });
    }
    // Bots: running subagents and workflow agents circling their session.
    const bots = m.bots.slice(0, 8);
    bots.forEach((b, i) => {
      const base = hashAngle(b.id), speed = 1.6 + (i % 3) * 0.35, R = 1.12 + (i % 2) * 0.2;
      for (let k = 3; k >= 0; k--) {
        const ang = base + rt * speed - k * 0.16;
        const px = cx + Math.cos(ang) * R, py = cy + Math.sin(ang) * R * 0.85;
        if (k) g.rect(px - 0.04, py - 0.04, 0.08, 0.08).fill({ color: workCol, alpha: (0.45 - k * 0.12) * alpha });
        else shape(g, "diamond", px, py, 0.2).fill({ color: workCol, alpha }).stroke({ width: 1 / S, color: "#000000", alpha });
      }
    });
    if (m.bots.length > bots.length && S > 11) {
      const p = this.w2s(cx + 1.25, cy - 1.05);
      this.text(`bots:${m.id}`, `+${m.bots.length - bots.length}`, p.x, p.y, { size: clamp(Math.round(S * 0.36), 8, 11), color: workCol, alpha });
    }
    if (S > 10) {
      const p = this.w2s(cx, cy + 0.02);
      this.text(`mono:${m.id}`, s.mono, p.x, p.y, { size: clamp(Math.round(S * 0.44), 8, 14), color: needs ? "#ffffff" : ended ? C.muted : idle ? C.ink : C.dark, weight: "700", family: HEAD, alpha });
    }
    if (S > 13) {
      const size = clamp(Math.round(S * 0.4), 8, 11), width = SLOT * S - 6, perLine = Math.max(4, Math.floor(width / (size * 0.62)));
      const full = this.alt ? (s.title ?? s.name) : s.name;
      const lines = this.alt ? 2 : 1;
      const str = full.length > perLine * lines ? `${full.slice(0, perLine * lines - 1).trimEnd()}…` : full;
      const p = this.w2s(cx, m.y + MACHINE.labelY);
      this.text(`name:${m.id}`, str, p.x, p.y, { size, color: this.alt ? C.amber : ended ? C.muted : C.ink, ay: 0.3, alpha, wrap: this.alt ? width : 0 });
    }
  }

  private drawOverlay() {
    const g = this.over, S = this.S, model = this.model!;
    if (this.selection) {
      const r = this.rectOf(this.selection);
      if (r) { brackets(g, r, 0.22, 0.5); g.stroke({ width: 2.5 / S, color: C.amber }); }
    }
    const d = this.drag;
    if (d?.kind === "machine") {
      const m = model.machine[d.id];
      if (!m) return;
      const p = d.plan, a = p ? model.area[p.areaId]! : null;
      const x = a ? a.rect.x + p!.x : d.w.x - SLOT / 2, y = a ? a.rect.y + p!.y : d.w.y - SLOT / 2;
      const ok = !!p && !p.problem, col = ok ? C.green : C.red;
      shape(g, a ? a.shape : m.shape, x + MACHINE.cx, y + MACHINE.cy, 1.12).fill({ color: col, alpha: 0.18 }).stroke({ width: 2.5 / S, color: col, alpha: 0.85 });
      this.drawMachine(g, { ...m, x, y, color: a ? a.color : m.color, shape: a ? a.shape : m.shape, bots: [] }, S, 0, 0.75);
    } else if (d && d.kind !== "pan") {
      const ok = !d.plan.problem;
      g.rect(d.plan.area.x, d.plan.area.y, d.plan.area.w, d.plan.area.h).fill({ color: ok ? C.green : C.red, alpha: 0.06 });
      dashedRect(g, d.plan.area, 0.45, 0.3);
      g.stroke({ width: 2 / S, color: ok ? C.green : C.red, alpha: 0.9 });
    }
  }

  /** Labels for an area under the pointer, for the tooltip. */
  areaView(id: string): AreaView | undefined { return this.model?.area[id]; }
}
