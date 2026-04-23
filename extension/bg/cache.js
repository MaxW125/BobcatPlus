// Bobcat Plus — chrome.storage.local cache wrapper (ES module).
//
// Every write into chrome.storage.local from the service worker must go
// through cacheSet; every read must go through cacheGet(key, ttl). The
// wrapper stamps each entry with `{ data, ts }` so TTL enforcement is
// uniform. Code that reads raw `chrome.storage.local.get(key).data`
// bypasses TTL and will silently serve stale records — do not do this.
//
// TTLs encode how fast the underlying TXST data can move:
//   - course (Banner section seats) → 1 h   (seats can shift same-day)
//   - prereq (section prereq page)  → 24 h  (fixed once schedule publishes)
//   - desc   (static course blurb)  → 7 d   (truly static)
//   - terms  (available term list)  → 24 h  (updated a few times a semester)
//   - courseInfo (DW wildcard)      → 1 h   (matches `course` for symmetry)
//
// A missing or expired entry returns null — callers decide how to refetch.
// Throws are swallowed: chrome.storage.local can race with quota eviction
// on Chromium cold-starts, and the correct behavior there is "cache miss"
// not "abort the whole phase". The perf cost of one refetch << a crashed
// service worker.

export const CACHE_TTL = {
  course:     60 * 60 * 1000,
  prereq:     24 * 60 * 60 * 1000,
  desc:       7  * 24 * 60 * 60 * 1000,
  terms:      24 * 60 * 60 * 1000,
  courseInfo: 60 * 60 * 1000,
};

export async function cacheGet(key, ttl) {
  try {
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (entry && Date.now() - entry.ts < ttl) return entry.data;
  } catch (e) {}
  return null;
}

export async function cacheSet(key, data) {
  try {
    await chrome.storage.local.set({ [key]: { data, ts: Date.now() } });
  } catch (e) {}
}

// Returns the write-timestamp (ms since epoch) of a cached entry, or null
// if missing/expired. Used by runAnalysis to surface an "oldest cache
// source" hint on the eligible-list payload so the UI can tell the student
// when data was last refreshed from Banner.
export async function cacheAge(key, ttl) {
  try {
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (entry && Date.now() - entry.ts < ttl) return entry.ts;
  } catch (e) {}
  return null;
}
