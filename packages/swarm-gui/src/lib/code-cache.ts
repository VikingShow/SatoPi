/**
 * LRU-bounded code highlight cache.
 *
 * Shared across all ShikiCodeBlock instances.  Uses Map insertion order as
 * a cheap LRU approximation — on eviction the oldest entry (first key in
 * iteration order) is removed.
 */

const MAX_ENTRIES = 200;
const cache = new Map<string, string>();

export function cacheKey(code: string, lang: string): string {
  return `${lang}:${code.slice(0, 200)}`;
}

export function getCachedHtml(key: string): string | null {
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Bump to end (mark recently used)
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit ?? null;
}

export function setCachedHtml(key: string, html: string): void {
  if (cache.has(key)) {
    cache.delete(key); // re-insert to update LRU position
  } else if (cache.size >= MAX_ENTRIES) {
    // Evict oldest (first key in insertion order)
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, html);
}
