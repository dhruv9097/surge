/**
 * Small in-process read-through cache with request coalescing: when an entry
 * expires under heavy load, one caller reloads it and everyone else waits for
 * that result, instead of all of them hitting the database at once.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1_000,
  ) {}

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = load()
        .then((value) => {
          if (this.entries.size >= this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) this.entries.delete(oldest);
          }
          this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
          return value;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }
}
