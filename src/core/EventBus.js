export class EventBus {
  #map = new Map();
  on(ev, fn) {
    if (!this.#map.has(ev)) this.#map.set(ev, new Set());
    this.#map.get(ev).add(fn);
    return () => this.#map.get(ev)?.delete(fn);
  }
  emit(ev, payload) {
    for (const fn of this.#map.get(ev) ?? []) fn(payload);
  }
  clear() { this.#map.clear(); }
}
