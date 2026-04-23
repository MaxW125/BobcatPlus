// Minimal chrome.* mock for unit tests that need to exercise service-worker
// or page-context code without loading Chrome.
//
// Why this module exists:
//   background.js and tab.js both pass chrome.storage.local to cache helpers,
//   chrome.runtime.sendMessage to cross the bg↔tab boundary, and
//   chrome.runtime.onMessage to route actions. Real tests of that plumbing
//   require stubs that are (a) stateful per-test, (b) inspectable (so the
//   test can assert what was called), and (c) resettable.
//
//   This file is the seed of that harness. Early users will be the affinity-
//   cache test (which reads chrome.storage for degreeAuditOverviewCache) and,
//   once bg/analysis.js is a clean ES module, the bail() contract test.
//
//   Keep the surface narrow. Add methods only when a test actually needs
//   them. A ballooning mock is worse than a missing one — it hides which
//   chrome.* surface our code actually depends on.

function createStorageArea() {
  const store = new Map();
  const listeners = new Set();
  return {
    _store: store,
    _listeners: listeners,
    get(keys, cb) {
      const out = {};
      const fetchKey = (k) => {
        if (store.has(k)) out[k] = store.get(k);
      };
      if (keys == null) {
        for (const [k, v] of store.entries()) out[k] = v;
      } else if (typeof keys === "string") {
        fetchKey(keys);
      } else if (Array.isArray(keys)) {
        keys.forEach(fetchKey);
      } else if (typeof keys === "object") {
        for (const k of Object.keys(keys)) {
          out[k] = store.has(k) ? store.get(k) : keys[k];
        }
      }
      if (typeof cb === "function") cb(out);
      return Promise.resolve(out);
    },
    set(items, cb) {
      const changes = {};
      for (const [k, v] of Object.entries(items || {})) {
        const old = store.has(k) ? store.get(k) : undefined;
        changes[k] = { oldValue: old, newValue: v };
        store.set(k, v);
      }
      for (const fn of listeners) {
        try { fn(changes, "local"); } catch (_) {}
      }
      if (typeof cb === "function") cb();
      return Promise.resolve();
    },
    remove(keys, cb) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((k) => store.delete(k));
      if (typeof cb === "function") cb();
      return Promise.resolve();
    },
    clear(cb) {
      store.clear();
      if (typeof cb === "function") cb();
      return Promise.resolve();
    },
  };
}

function createMessagingHub() {
  const listeners = new Set();
  const sent = [];
  return {
    _sent: sent,
    _listeners: listeners,
    onMessage: {
      addListener(fn) { listeners.add(fn); },
      removeListener(fn) { listeners.delete(fn); },
      hasListener(fn) { return listeners.has(fn); },
      _listeners: listeners,
    },
    sendMessage(message, cb) {
      sent.push(message);
      let responded = false;
      const sendResponse = (value) => {
        responded = true;
        if (typeof cb === "function") cb(value);
      };
      let keepChannelOpen = false;
      for (const fn of listeners) {
        const ret = fn(message, { id: "mock-sender" }, sendResponse);
        if (ret === true) keepChannelOpen = true;
      }
      // Tests that expect a sync response and nobody called sendResponse: resolve undefined.
      if (!keepChannelOpen && !responded && typeof cb === "function") cb(undefined);
      return Promise.resolve();
    },
    // Test helpers
    _fireMessage(message) {
      return this.sendMessage(message);
    },
    _reset() {
      sent.length = 0;
      listeners.clear();
    },
  };
}

// Build a fresh mock per test. Returning a factory (not a singleton) means a
// test can reset without stomping on a parallel test's state — and lets us
// swap `globalThis.chrome` in beforeEach / restore in afterEach.
function createChromeMock() {
  const storageLocal = createStorageArea();
  const storageSession = createStorageArea();
  const runtime = createMessagingHub();
  return {
    storage: {
      local: storageLocal,
      session: storageSession,
      onChanged: {
        addListener(fn) { storageLocal._listeners.add(fn); storageSession._listeners.add(fn); },
        removeListener(fn) { storageLocal._listeners.delete(fn); storageSession._listeners.delete(fn); },
      },
    },
    runtime: {
      id: "mock-extension",
      lastError: null,
      onMessage: runtime.onMessage,
      sendMessage: runtime.sendMessage.bind(runtime),
      getURL: (p) => `chrome-extension://mock/${p.replace(/^\//, "")}`,
      // Test helpers (underscored so they stay out of production lookups)
      _runtime: runtime,
      _sent: runtime._sent,
    },
    tabs: {
      create: () => Promise.resolve({ id: 1 }),
    },
    windows: {
      create: () => Promise.resolve({ id: 1, tabs: [{ id: 1 }] }),
      update: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      onRemoved: { addListener() {}, removeListener() {} },
    },
    webNavigation: {
      onCommitted: { addListener() {}, removeListener() {} },
      onCompleted: { addListener() {}, removeListener() {} },
      onErrorOccurred: { addListener() {}, removeListener() {} },
    },
    cookies: {
      get: (_details, cb) => (cb ? cb(null) : Promise.resolve(null)),
      getAll: (_details, cb) => (cb ? cb([]) : Promise.resolve([])),
    },
  };
}

// install(): assign the mock to globalThis.chrome and return a disposer.
// Usage:
//   const restore = install();
//   try { /* test body */ } finally { restore(); }
function install(existing) {
  const mock = existing || createChromeMock();
  const prev = globalThis.chrome;
  globalThis.chrome = mock;
  return {
    mock,
    restore() {
      if (prev === undefined) delete globalThis.chrome;
      else globalThis.chrome = prev;
    },
  };
}

module.exports = { createChromeMock, install };
