import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FoundryState, Intent } from "@foundry/protocol";
import { Bus } from "./bus";
import { buildModel, type Model } from "./model";
import { Scene, type SceneEvents, type Selection } from "./scene";
import { Store } from "./store";
import { Alerts, Hint, Hotbar, Inspector, Legend, Overview, Toasts, Tooltip, type Ctx, type HoverInfo, type ToastItem } from "./ui/panels";

/** The factory: the map (PixiJS) with the mockup's panels (React) on top, drawing the core's live state. */
export function App() {
  const store = useMemo(() => new Store(), []);
  const hover = useMemo(() => new Bus<HoverInfo>(null), []);
  const hint = useMemo(() => new Bus<string | null>(null), []);
  useEffect(() => { store.connect(); return () => store.close(); }, [store]);
  useSyncExternalStore(store.subscribe, store.getVersion);
  const state = store.state;
  const model = useMemo(() => (state ? buildModel(state) : null), [state]);
  const scene = useRef<Scene | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((text: string, bad = false) => {
    const id = Math.random();
    setToasts((t) => [{ id, text, bad }, ...t].slice(0, 3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  const send = useCallback(async (intent: Intent) => {
    const r = await store.send(intent);
    if (r.error) toast(r.error, true);
    return r;
  }, [store, toast]);
  const select = useCallback((sel: Selection, fly = false) => {
    setSelection(sel);
    if (scene.current) { scene.current.selection = sel; if (fly) scene.current.focus(sel); }
  }, []);

  useNeedsYouToasts(state, toast);
  useKeys(scene, model, select);

  const events: SceneEvents = {
    select: (sel) => select(sel),
    intent: (i) => { send(i); },
    pin: (slot, id) => { send({ type: "pin", slot, ref: { kind: "session", id } }).then((r) => { if (!r.error) toast(`Pinned to slot ${slot < 9 ? slot + 1 : 0}`); }); },
    hover: (h) => hover.set(h),
    hint: (t) => hint.set(t),
    toast: (t) => toast(t, true),
  };

  const ctx: Ctx | null = state && model ? {
    state, model, selection, select, send, toast,
    zoom: (f) => scene.current?.zoomBy(f), fit: () => scene.current?.fit(),
  } : null;

  return (
    <div id="app">
      <MapView model={model} state={state} scene={scene} events={events} />
      {!state && <div className="splash">{store.conn === "down" ? "Can't reach the core. Is pnpm dev:core running?" : "Connecting to the core…"}</div>}
      {ctx && (
        <>
          <Overview ctx={ctx} conn={store.conn} />
          <Legend />
          <Inspector ctx={ctx} />
          <Alerts ctx={ctx} />
          <Hotbar ctx={ctx} />
          <Tooltip bus={hover} ctx={ctx} />
        </>
      )}
      <Hint bus={hint} />
      <Toasts items={toasts} />
    </div>
  );
}

function MapView({ model, state, scene, events }: { model: Model | null; state: FoundryState | null; scene: React.MutableRefObject<Scene | null>; events: SceneEvents }) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ model, state });
  latest.current = { model, state };
  const on = useRef(events);
  on.current = events;
  useEffect(() => {
    const sc = new Scene(host.current!, {
      select: (s) => on.current.select(s), intent: (i) => on.current.intent(i), pin: (a, b) => on.current.pin(a, b),
      hover: (h) => on.current.hover(h), hint: (t) => on.current.hint(t), toast: (t) => on.current.toast(t),
    });
    scene.current = sc;
    sc.init().then(() => { const { model: m, state: s } = latest.current; if (m && s) sc.setData(m, s); });
    return () => { sc.destroy(); scene.current = null; };
  }, [scene]);
  useEffect(() => { if (model && state) scene.current?.setData(model, state); }, [model, state, scene]);
  return <div id="map" ref={host} />;
}

/** A toast when a session starts needing you (not for the ones that already did when the page opened). */
function useNeedsYouToasts(state: FoundryState | null, toast: (t: string, bad?: boolean) => void) {
  const prev = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!state) return;
    const now = new Map(Object.values(state.sessions).map((s) => [s.id, s.status]));
    if (prev.current) for (const s of Object.values(state.sessions)) {
      if (s.status === "needs_you" && prev.current.get(s.id) !== "needs_you" && !s.pending && !s.archived) toast(`${s.name} needs you${s.notification ? `: ${s.notification}` : ""}`);
    }
    prev.current = now;
  }, [state, toast]);
}

function useKeys(scene: React.MutableRefObject<Scene | null>, model: Model | null, select: (s: Selection, fly?: boolean) => void) {
  const m = useRef(model);
  m.current = model;
  useEffect(() => {
    const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest("input, textarea, select");
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt") { e.preventDefault(); if (scene.current) scene.current.alt = true; return; }
      if (typing(e) || e.metaKey || e.ctrlKey) return;
      if (e.key === "Escape") { if (!scene.current?.cancelDrag()) select(null); }
      else if (e.key === "f" || e.key === "F") scene.current?.fit();
      else if (e.key === "+" || e.key === "=") scene.current?.zoomBy(1.25);
      else if (e.key === "-") scene.current?.zoomBy(0.8);
      else if (/^[0-9]$/.test(e.key)) {
        const p = m.current?.pins[e.key === "0" ? 9 : Number(e.key) - 1];
        if (p) select({ kind: "session", id: p.id }, true);
      }
    };
    const up = (e: KeyboardEvent) => { if (e.key === "Alt" && scene.current) scene.current.alt = false; };
    const blur = () => { if (scene.current) scene.current.alt = false; };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    return () => { removeEventListener("keydown", down); removeEventListener("keyup", up); removeEventListener("blur", blur); };
  }, [scene, select]);
}
