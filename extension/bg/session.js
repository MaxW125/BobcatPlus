// Bobcat Plus — Banner session mutex (ES module, module-level singleton).
//
// ** Load-bearing invariant — see docs/invariants.md #1. **
//
// Banner's StudentRegistrationSsb stores a single "current term + search
// mode" on the session cookie at the server. Any `term/search?mode=…`
// call or any `searchResults/searchResults` call mutates that state.
// Interleaving two such calls across two different terms — even from
// honestly-concurrent code paths like "user switched terms while an
// eligible-list analysis was still finishing" — corrupts which response
// ties to which request, and the extension starts returning sections
// from the wrong semester with no visible error.
//
// The fix is a strict FIFO mutex over that shared session state:
// `withSessionLock(fn)` returns a promise that resolves with fn()'s
// result *after* every earlier call has run to completion. A reject by
// one task does not poison the queue (the `.then(fn, fn)` swallow is
// deliberate — we want to fall through to the next task, not halt).
//
// This file exports exactly one function. `sessionQueue` is intentionally
// module-private and never re-exported; ES-module semantics guarantee a
// single instance across every importer in the service worker, which is
// what we need. If you find yourself reaching for a second queue, stop
// and reread docs/bugs/bug4-eligible.md.

let sessionQueue = Promise.resolve();

export function withSessionLock(fn) {
  const task = sessionQueue.then(fn, fn);
  sessionQueue = task.then(() => {}, () => {});
  return task;
}
