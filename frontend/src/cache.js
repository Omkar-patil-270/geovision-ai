// frontend/src/cache.js
//
// Small TTL cache backed by localStorage, so population/images/weather/story
// data isn't re-fetched every time the user re-opens a place they already
// looked at (this session or a previous one). Falls back to an in-memory
// Map if localStorage is unavailable (private browsing, quota exceeded).

const memoryStore = new Map();

function hasLocalStorage() {
  try {
    const testKey = "__geovisionai_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

const USE_LS = typeof window !== "undefined" && hasLocalStorage();
const PREFIX = "geovisionai_cache_";

export function cacheGet(key) {
  const fullKey = PREFIX + key;
  try {
    const raw = USE_LS ? window.localStorage.getItem(fullKey) : memoryStore.get(fullKey);
    if (!raw) return null;
    const { expiresAt, value } = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Date.now() > expiresAt) {
      cacheDelete(key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function cacheSet(key, value, ttlMs = 30 * 60 * 1000) {
  const fullKey = PREFIX + key;
  const payload = { expiresAt: Date.now() + ttlMs, value };
  try {
    if (USE_LS) {
      window.localStorage.setItem(fullKey, JSON.stringify(payload));
    } else {
      memoryStore.set(fullKey, payload);
    }
  } catch {
    // Storage full or unavailable — just skip caching silently, this is
    // a pure performance optimization, never load-bearing for correctness.
  }
}

export function cacheDelete(key) {
  const fullKey = PREFIX + key;
  try {
    if (USE_LS) window.localStorage.removeItem(fullKey);
    else memoryStore.delete(fullKey);
  } catch {
    // ignore
  }
}

// Rounds coordinates so nearby clicks on ~the same region hit the same
// cache entry instead of missing on tiny floating-point differences.
export function locationCacheKey(lat, lon, precision = 3) {
  return `${lat.toFixed(precision)},${lon.toFixed(precision)}`;
}

export const TTL = {
  PREDICTIONS: 30 * 60 * 1000,       // 30 min
  IMAGES: 24 * 60 * 60 * 1000,       // 24h — image sets barely change
  STORY_SECTION: 6 * 60 * 60 * 1000, // 6h
  SEARCH: 6 * 60 * 60 * 1000,        // 6h
};
