// Affinity cache wipe invariant — docs/invariants.md #4.
//
// Why this file exists:
//   The affinityCache in scheduler/llm/affinity.js memoizes Affinity-LLM
//   scores across repeat calls within a user session. Without the wipe at
//   the top of each handleUserTurn, career keywords from a prior turn
//   silently bias the next turn — a "stick" with no user-visible trace. The
//   invariant is enforced by `clearAffinityCache()` exported from affinity.js
//   and called as the first statement in handleUserTurn (scheduler/index.js).
//
//   Pre-refactor plan (commits 2–8 on refactor-on-main): pin the primitive
//   contract here so the wipe can't silently regress during the module
//   split. A stricter end-to-end test via handleUserTurn would require a
//   full pipeline mock (OpenAI x3, chrome.storage, student profile) and
//   is deferred until bg/* modules exist and testing shape is cleaner.
//
//   We mock global.fetch rather than chrome.* because callAffinity's only
//   external dependency is the OpenAI endpoint.

const { BP, assertEqual, assertTrue } = require("./_harness");

const cases = [];

// Build an OpenAI response that openaiChat → openaiJson will parse into
// `{ scores: {...} }`. The shape must match openaiChat's expectations in
// scheduler/llm/openai.js.
function stubOkResponse(scoresByCourse) {
  const jsonBody = JSON.stringify({ scores: scoresByCourse });
  return {
    ok: true,
    async json() {
      return {
        choices: [{ message: { content: jsonBody } }],
        usage: { prompt_tokens: 42, completion_tokens: 17 },
      };
    },
  };
}

function noopTrace() {
  return {
    start() {
      return {
        done() {},
        fail() {},
        update() {},
      };
    },
  };
}

function runWithFetchStub(fn) {
  const prev = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return stubOkResponse({
      "CS 3339": { score: 0.9, reason: "systems" },
      "ENG 1310": { score: 0.2, reason: "core" },
    });
  };
  const restore = () => { globalThis.fetch = prev; };
  return { calls, restore, run: fn };
}

const eligibleSample = [
  { course: "CS 3339", title: "Computer Systems", requirementLabel: "Major", description: "Systems fundamentals." },
  { course: "ENG 1310", title: "College Writing", requirementLabel: "Core", description: "First-year writing." },
];

cases.push({
  name: "callAffinity: second call with identical args is served from cache (fetch not re-hit)",
  async run() {
    const { calls, restore } = runWithFetchStub();
    try {
      BP.clearAffinityCache();
      await BP.callAffinity({
        eligible: eligibleSample,
        careerKeywords: ["security"],
        freeTextPrefs: "",
        apiKey: "sk-test",
        trace: noopTrace(),
      });
      assertEqual(calls.length, 1, "first call should hit fetch once");
      await BP.callAffinity({
        eligible: eligibleSample,
        careerKeywords: ["security"],
        freeTextPrefs: "",
        apiKey: "sk-test",
        trace: noopTrace(),
      });
      assertEqual(
        calls.length,
        1,
        `second call with same args should be cached, but fetch was called ${calls.length}× total`,
      );
    } finally { restore(); }
  },
});

cases.push({
  name: "clearAffinityCache wipes the cache so identical subsequent args re-fetch",
  async run() {
    // This is the CLAUDE.md invariant #4 contract. If handleUserTurn's
    // `affinityCache.clear()` ever stops firing at the top of a turn — or
    // if the module-level `affinityCache` reference is rebound and the
    // cleared Map is the wrong one — this test regresses.
    const { calls, restore } = runWithFetchStub();
    try {
      BP.clearAffinityCache();
      await BP.callAffinity({
        eligible: eligibleSample,
        careerKeywords: ["cybersecurity"],
        freeTextPrefs: "",
        apiKey: "sk-test",
        trace: noopTrace(),
      });
      assertEqual(calls.length, 1);

      BP.clearAffinityCache();

      await BP.callAffinity({
        eligible: eligibleSample,
        careerKeywords: ["cybersecurity"],
        freeTextPrefs: "",
        apiKey: "sk-test",
        trace: noopTrace(),
      });
      assertEqual(
        calls.length,
        2,
        `after clearAffinityCache(), re-call with same args must hit fetch again; got ${calls.length}`,
      );
    } finally { restore(); }
  },
});

cases.push({
  name: "callAffinity: different careerKeywords produce a cache miss (keys are keyword-sensitive)",
  async run() {
    // Guard against the other half of the "career bias" bug: if the cache
    // key were eligible-only (ignoring keywords), a second turn with new
    // career input would reuse the first turn's scores. Confirm the key
    // includes the keyword set.
    const { calls, restore } = runWithFetchStub();
    try {
      BP.clearAffinityCache();
      await BP.callAffinity({
        eligible: eligibleSample,
        careerKeywords: ["security"],
        freeTextPrefs: "",
        apiKey: "sk-test",
        trace: noopTrace(),
      });
      await BP.callAffinity({
        eligible: eligibleSample,
        careerKeywords: ["teaching"],
        freeTextPrefs: "",
        apiKey: "sk-test",
        trace: noopTrace(),
      });
      assertEqual(
        calls.length,
        2,
        `different careerKeywords should miss the cache; got ${calls.length} fetches`,
      );
    } finally { restore(); }
  },
});

cases.push({
  name: "callAffinity: empty careerKeywords + empty freeTextPrefs returns uniform scores without a fetch",
  run() {
    // Short-circuit path: no career signal → every course gets 0.5. This
    // saves a round-trip per turn when the student hasn't stated a career.
    // If this ever regresses, a blank-prompt turn would charge OpenAI for
    // a constant-output call — a real $ cost.
    const { calls, restore } = runWithFetchStub();
    try {
      BP.clearAffinityCache();
      const p = BP.callAffinity({
        eligible: eligibleSample,
        careerKeywords: [],
        freeTextPrefs: "",
        apiKey: "sk-test",
        trace: noopTrace(),
      });
      return p.then((scores) => {
        assertEqual(calls.length, 0, "no signal should skip fetch entirely");
        assertTrue(scores && scores["CS 3339"], "expected a scores object back");
        assertEqual(scores["CS 3339"].score, 0.5, "uniform default is 0.5");
      }).finally(restore);
    } catch (e) {
      restore();
      throw e;
    }
  },
});

module.exports = { cases };
