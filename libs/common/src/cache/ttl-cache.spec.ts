import { TtlCache } from './ttl-cache.js';

describe('TtlCache', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces concurrent misses into a single load', async () => {
    const cache = new TtlCache<number>(1_000);
    const load = vi.fn(() => Promise.resolve(42));
    const results = await Promise.all(Array.from({ length: 50 }, () => cache.get('k', load)));
    expect(results.every((r) => r === 42)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads after the ttl expires', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>(1_000);
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    expect(await cache.get('k', load)).toBe(1);
    vi.advanceTimersByTime(1_001);
    expect(await cache.get('k', load)).toBe(2);
  });

  it('does not cache failures', async () => {
    const cache = new TtlCache<number>(1_000);
    const load = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(7);
    await expect(cache.get('k', load)).rejects.toThrow('db down');
    expect(await cache.get('k', load)).toBe(7);
  });

  it('evicts the oldest entry when full', async () => {
    const cache = new TtlCache<string>(60_000, 2);
    await cache.get('a', () => Promise.resolve('a1'));
    await cache.get('b', () => Promise.resolve('b1'));
    await cache.get('c', () => Promise.resolve('c1'));
    expect(await cache.get('a', () => Promise.resolve('a2'))).toBe('a2');
    expect(await cache.get('c', () => Promise.resolve('c2'))).toBe('c1');
  });
});
