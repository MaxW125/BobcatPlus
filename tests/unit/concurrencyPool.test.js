// Unit tests for `performance/concurrencyPool.js`.
//
// These are deliberately narrow: we only care that `mapPool`
//   (a) runs every item exactly once,
//   (b) respects the concurrency limit (never exceeds `limit` in flight),
//   (c) preserves index-order in the returned results array, and
//   (d) surfaces mapper errors to the caller.
//
// `fetchWithTimeout` is not tested here — it's a 7-line wrapper around
// AbortController + fetch, and unit-testing it would require mocking the
// global fetch in ways the current harness doesn't bother with. It's
// covered instead by live-verification of the eligible-courses pipeline.

const fs = require("fs");
const path = require("path");
const { assertEqual, assertDeepEqual, assertTrue, fail } = require("./_harness");

const POOL_PATH = path.join(
  __dirname,
  "..",
  "..",
  "extension",
  "performance",
  "concurrencyPool.js",
);
// eslint-disable-next-line no-eval
eval(fs.readFileSync(POOL_PATH, "utf8"));

const BPPerf = global.BPPerf;
if (!BPPerf || typeof BPPerf.mapPool !== "function") {
  throw new Error("concurrencyPool.js did not attach mapPool to BPPerf");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  cases: [
    {
      name: "mapPool: empty array returns empty results",
      run: async () => {
        const out = await BPPerf.mapPool([], 4, async () => fail("mapper should not run"));
        assertTrue(Array.isArray(out), "returned value should be an array");
        assertEqual(out.length, 0, "empty input → empty output");
      },
    },

    {
      name: "mapPool: runs each item exactly once",
      run: async () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8];
        const seen = new Set();
        const out = await BPPerf.mapPool(items, 3, async (n) => {
          if (seen.has(n)) fail("item processed twice: " + n);
          seen.add(n);
          return n * 2;
        });
        assertEqual(seen.size, items.length, "every item seen");
        assertDeepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16], "results in index order");
      },
    },

    {
      name: "mapPool: respects concurrency limit",
      run: async () => {
        const items = Array.from({ length: 20 }, (_, i) => i);
        let inFlight = 0;
        let peak = 0;
        const LIMIT = 4;
        await BPPerf.mapPool(items, LIMIT, async () => {
          inFlight++;
          if (inFlight > peak) peak = inFlight;
          await delay(5);
          inFlight--;
        });
        assertTrue(peak > 0, "at least one worker ran");
        assertTrue(
          peak <= LIMIT,
          "peak in-flight (" + peak + ") exceeded limit (" + LIMIT + ")",
        );
      },
    },

    {
      name: "mapPool: preserves result order even when workers finish out of order",
      run: async () => {
        const items = [0, 1, 2, 3, 4, 5, 6, 7];
        const out = await BPPerf.mapPool(items, 3, async (n) => {
          // Earlier indices sleep longer → finish later.
          await delay((8 - n) * 2);
          return "item-" + n;
        });
        assertDeepEqual(
          out,
          items.map((n) => "item-" + n),
          "results in input order regardless of completion order",
        );
      },
    },

    {
      name: "mapPool: mapper errors propagate to caller",
      run: async () => {
        let caught = null;
        try {
          await BPPerf.mapPool([1, 2, 3], 2, async (n) => {
            if (n === 2) throw new Error("boom-" + n);
            return n;
          });
        } catch (e) {
          caught = e;
        }
        assertTrue(caught !== null, "mapPool should reject when mapper throws");
        assertTrue(
          /boom/.test(caught && caught.message),
          "propagated error message should include the mapper error (got: " +
            (caught && caught.message) +
            ")",
        );
      },
    },

    {
      name: "mapPool: clamps limit of 0 to 1 worker",
      run: async () => {
        // Edge case: callers passing a misconfigured/accidental 0 should
        // still get every item processed, not hang forever.
        const items = [10, 20, 30];
        const out = await BPPerf.mapPool(items, 0, async (n) => n + 1);
        assertDeepEqual(out, [11, 21, 31], "limit=0 should not silently drop items");
      },
    },

    {
      name: "mapPool: limit greater than items caps to items.length",
      run: async () => {
        const items = [1, 2, 3];
        let inFlight = 0;
        let peak = 0;
        await BPPerf.mapPool(items, 100, async () => {
          inFlight++;
          if (inFlight > peak) peak = inFlight;
          await delay(5);
          inFlight--;
        });
        assertTrue(
          peak <= items.length,
          "peak (" + peak + ") should be clamped to items.length (" + items.length + ")",
        );
      },
    },
  ],
};
