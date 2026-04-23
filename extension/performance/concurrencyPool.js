// Bobcat Plus — Concurrency primitives.
//
// Tiny runtime-agnostic helpers that guardrail network-heavy phases so the
// extension never deadlocks on a single stalled socket (see
// docs/bugs/bug4-eligible.md for the 4-minute-hang repro that motivated
// this module).
//
// Exports (attached to global.BPPerf and to module.exports):
//
//   - mapPool(items, limit, mapper)
//       Runs `mapper(item, index)` across `items` with at most `limit`
//       in-flight promises. Results are returned in the original index
//       order. If the mapper throws, the error propagates to the caller
//       (the caller is responsible for wrapping its body in try/catch if
//       it wants per-item failure isolation — this matches how the old
//       `Promise.all(items.map(...))` call-sites behave).
//
//   - fetchWithTimeout(url, options, timeoutMs)
//       Thin `fetch` wrapper that aborts via `AbortController` after
//       `timeoutMs` (default 12_000). Aborted fetches reject with a
//       DOMException whose .name === "AbortError", which existing
//       try/catch sites already handle via the same "return null /
//       warn" fallbacks used for network errors.
//
// Dual-export: usable both in the extension runtime (attaches to
// `globalThis.BPPerf`) and in Node unit tests (`require(...)`).

(function (global) {
  "use strict";

  async function mapPool(items, limit, mapper) {
    if (!Array.isArray(items)) {
      throw new TypeError("mapPool: items must be an array");
    }
    if (typeof mapper !== "function") {
      throw new TypeError("mapPool: mapper must be a function");
    }
    const n = items.length;
    const results = new Array(n);
    if (n === 0) return results;

    const effectiveLimit = Math.max(1, Math.min(n, limit | 0));
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < effectiveLimit; w++) {
      workers.push(
        (async () => {
          while (true) {
            const i = cursor++;
            if (i >= n) return;
            results[i] = await mapper(items[i], i);
          }
        })(),
      );
    }
    await Promise.all(workers);
    return results;
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 12000;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try {
        controller.abort();
      } catch (e) { /* controller already aborted */ }
    }, ms);
    try {
      return await fetch(url, { ...(options || {}), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const api = { mapPool, fetchWithTimeout };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  global.BPPerf = global.BPPerf || {};
  Object.assign(global.BPPerf, api);
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
