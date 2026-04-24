// RAG-seam invariant: every LLM entry point must accept ragChunks[].
// Runs against the current monolith (BP.*) so a violation surfaces before
// any extraction happens. See docs/plans/scheduler-refactor.md invariant table.
//
// The check is intentionally trivial — toString().includes("ragChunks") — so
// it catches both "parameter missing" and "parameter renamed" regressions.

const { BP, assertTrue } = require("./_harness");

const LLM_FUNS = [
  { name: "callIntent",     fn: BP.callIntent },
  { name: "callAffinity",   fn: BP.callAffinity },
  { name: "callRationales", fn: BP.callRationales },
  { name: "callAdvisor",    fn: BP.callAdvisor },
];

module.exports = {
  cases: LLM_FUNS.map(({ name, fn }) => ({
    name: `${name}: signature includes ragChunks`,
    run() {
      assertTrue(
        typeof fn === "function",
        `BP.${name} must be a function (got ${typeof fn})`,
      );
      assertTrue(
        fn.toString().includes("ragChunks"),
        `BP.${name} must accept a ragChunks parameter (RAG seam invariant)`,
      );
    },
  })),
};
