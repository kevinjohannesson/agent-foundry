import { useSyncExternalStore } from "react";

/** A value that changes often (the hovered thing, the drag hint), read only by the component that shows it. */
export class Bus<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get = () => this.value;
  set(v: T) { this.value = v; for (const l of this.listeners) l(); }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
}

export const useBus = <T,>(bus: Bus<T>) => useSyncExternalStore(bus.subscribe, bus.get);
