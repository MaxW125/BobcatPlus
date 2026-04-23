const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const { install } = require("../mocks/chrome");

function countSubstring(haystack, needle) {
  let i = 0;
  let count = 0;
  while (true) {
    const next = haystack.indexOf(needle, i);
    if (next === -1) return count;
    count++;
    i = next + needle.length;
  }
}

async function importBgAnalysis() {
  const abs = path.resolve(__dirname, "../../extension/bg/analysis.js");
  const url = pathToFileURL(abs).href;
  return await import(url);
}

const cases = [
  {
    name: "bail() contract: runAnalysis keeps every guard verbatim after extraction",
    async run() {
      const { restore } = install();
      try {
        const mod = await importBgAnalysis();
        assert.strictEqual(typeof mod.runAnalysis, "function");

        const src = mod.runAnalysis.toString();

        assert.ok(
          src.includes('const current = typeof isCurrent === "function" ? isCurrent : () => true;'),
          "expected current() defaulting line to remain stable",
        );
        assert.ok(
          src.includes("const bail = () => !current();"),
          "expected bail() definition to remain stable",
        );

        const guard = "if (bail()) return;";
        const guardCount = countSubstring(src, guard);
        assert.strictEqual(
          guardCount,
          13,
          `expected ${guardCount} bail guards to equal 13`,
        );
      } finally {
        restore();
      }
    },
  },
];

module.exports = { cases };

