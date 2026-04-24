// scheduler/trace.js — pipeline observability
// Extracted from scheduleGenerator.js section 4. Pure, no dependencies.
// Every stage records { stage, status, duration, summary, tokens }.
// The extension's Thinking panel subscribes via onTrace callback.

export function createTrace(onTrace) {
  const entries = [];
  const emit = (entry) => {
    entries.push(entry);
    try { onTrace && onTrace(entry, entries); } catch (_) {}
  };
  return {
    entries,
    start(stage, summary = "") {
      const entry = { stage, status: "running", startedAt: Date.now(), summary };
      emit(entry);
      return {
        done: (extra = {}) => {
          entry.status = "done";
          entry.duration = Date.now() - entry.startedAt;
          Object.assign(entry, extra);
          emit({ ...entry });
        },
        fail: (err) => {
          entry.status = "error";
          entry.duration = Date.now() - entry.startedAt;
          entry.error = err?.message || String(err);
          emit({ ...entry });
        },
        update: (extra) => {
          Object.assign(entry, extra);
          emit({ ...entry });
        },
      };
    },
  };
}
