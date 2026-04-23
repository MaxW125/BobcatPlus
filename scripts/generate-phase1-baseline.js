#!/usr/bin/env node
// Phase 1 baseline snapshot generator (D10 gate).
//
// Usage:
//   node scripts/generate-phase1-baseline.js > docs/baselines/phase1-$(date +%F).json
//
// Emits a deterministic JSON snapshot of every offline-measurable metric
// that Phase 1 touches: parser output counts, wildcard counts, graph
// validity, and wildcard-normalizer counts against the cs-4@ fixture.
// The resulting baseline is the regression floor every later phase must
// not beat. A Phase 2 baseline will extend this with runtime metrics
// (honoredRate etc.) that need an LLM.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// eslint-disable-next-line no-eval
eval(fs.readFileSync(path.join(ROOT, "extension", "requirements", "graph.js"), "utf8"));
// eslint-disable-next-line no-eval
eval(fs.readFileSync(path.join(ROOT, "extension", "requirements", "txstFromAudit.js"), "utf8"));
// eslint-disable-next-line no-eval
eval(fs.readFileSync(path.join(ROOT, "extension", "requirements", "wildcardExpansion.js"), "utf8"));

const BPReq = global.BPReq || (typeof self !== "undefined" && self.BPReq);

function summarizeAudit(fixturePath) {
  const audit = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const graph = BPReq.buildGraphFromAudit(audit);
  const derived = BPReq.deriveEligible(graph);
  const validityErrors = BPReq.validateGraph(graph);
  const entries = derived.entries.filter((e) => !e.hideFromUi);
  const hidden = derived.entries.filter((e) => !!e.hideFromUi);
  const uniqueWildcards = new Set(
    (derived.wildcards || []).map(
      (w) =>
        (w.discipline || "@") +
        ":" +
        (w.numberPrefix || "@") +
        ":" +
        (w.withClauses || [])
          .map((c) => (c.field || "") + "=" + (c.code || ""))
          .sort()
          .join(","),
    ),
  );
  return {
    file: path.basename(fixturePath),
    graphRoots: graph.roots.length,
    graphValidity: {
      valid: validityErrors.length === 0,
      issues: validityErrors.length,
    },
    derivedEntries: entries.length,
    derivedHideFromUi: hidden.length,
    derivedWildcards: derived.wildcards.length,
    uniqueWildcards: uniqueWildcards.size,
  };
}

function summarizeWildcardFixture(fixturePath) {
  const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const all = BPReq.normalizeCourseInformationCourses(raw);
  const fall2026 = BPReq.normalizeCourseInformationCourses(raw, {
    termCode: "202630",
  });
  const sectionsAll = all.reduce((n, c) => n + c.sections.length, 0);
  const sectionsFall = fall2026.reduce((n, c) => n + c.sections.length, 0);
  return {
    file: path.basename(fixturePath),
    coursesTotal: all.length,
    coursesOfferedFall2026: fall2026.filter((c) => c.sections.length > 0).length,
    sectionsTotal: sectionsAll,
    sectionsFall2026: sectionsFall,
  };
}

const out = {
  snapshotDate: new Date().toISOString().slice(0, 10),
  phase: "1",
  notes:
    "Offline-measurable Phase 1 baseline. Phase 2 will add runtime metrics " +
    "(honoredRate, archetypeDistance, penaltyEffectiveness) that require " +
    "an LLM and the full intent-fixture prompts.",
  audits: [
    summarizeAudit(
      path.join(ROOT, "tests", "fixtures", "audits", "audit-english-ba.json"),
    ),
    summarizeAudit(
      path.join(
        ROOT,
        "tests",
        "fixtures",
        "audits",
        "audit-computerscience-bs-minor-music.json",
      ),
    ),
  ],
  wildcards: [
    summarizeWildcardFixture(
      path.join(ROOT, "tests", "fixtures", "wildcard", "cs-4@.json"),
    ),
  ],
  tests: {
    note:
      "Per `node tests/unit/run.js` at snapshot time. Update this section " +
      "when adding or removing tests; any future phase that regresses these " +
      "counts must justify it in the PR description.",
  },
};

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
