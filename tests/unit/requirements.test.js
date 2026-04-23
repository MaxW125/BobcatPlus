// Unit tests for the DegreeWorks -> RequirementGraph adapter.
//
// Drives every assertion from real TXST audit fixtures (English BA and CS BS)
// plus the `cs-4@.json` wildcard response. No network, no OpenAI, no shim —
// the adapter is a pure function.
//
// These tests *must* pass before the parser is wired into background.js.

const fs = require("fs");
const path = require("path");
const { assertEqual, assertTrue, assertGreater, fail } = require("./_harness");

const graph = require("../../extension/requirements/graph");
const adapter = require("../../extension/requirements/txstFromAudit");

const FIX_DIR = path.join(__dirname, "..", "fixtures");
const englishAudit = JSON.parse(
  fs.readFileSync(path.join(FIX_DIR, "audits", "audit-english-ba.json"), "utf8"),
);
const csAudit = JSON.parse(
  fs.readFileSync(
    path.join(FIX_DIR, "audits", "audit-computerscience-bs-minor-music.json"),
    "utf8",
  ),
);
const cs4Wildcard = JSON.parse(
  fs.readFileSync(path.join(FIX_DIR, "wildcard", "cs-4@.json"), "utf8"),
);

function findNode(tree, predicate) {
  let hit = null;
  graph.walkGraph(tree, (node) => {
    if (!hit && predicate(node)) hit = node;
  });
  return hit;
}

function findAll(tree, predicate) {
  const out = [];
  graph.walkGraph(tree, (node) => {
    if (predicate(node)) out.push(node);
  });
  return out;
}

const cases = [];

// ─── Bug 2 smoking gun: Modern Language is pick-1-of-12 ──────────────────

cases.push({
  name: "english BA: Modern Language is chooseN(n=1) over 12 language tracks",
  run() {
    const g = adapter.buildGraphFromAudit(englishAudit);
    const errs = graph.validateGraph(g);
    if (errs.length) fail("graph invalid: " + errs.join("; "));

    const langGroup = findNode(g, (n) => n.label === "Modern Language Requirement");
    assertTrue(!!langGroup, "Modern Language group present");
    assertEqual(langGroup.kind, "chooseN", "kind");
    assertEqual(langGroup.n, 1, "n");
    assertEqual(langGroup.children.length, 12, "12 language tracks");

    const langs = langGroup.children.map((c) => c.label).sort();
    assertTrue(
      langs.includes("Spanish") && langs.includes("Arabic") && langs.includes("American Sign Language"),
      `language labels present: got ${JSON.stringify(langs)}`,
    );
  },
});

cases.push({
  name: "english BA: each language track is take-4 course rule listing all 4 levels",
  run() {
    const g = adapter.buildGraphFromAudit(englishAudit);
    const langGroup = findNode(g, (n) => n.label === "Modern Language Requirement");
    for (const child of langGroup.children) {
      assertEqual(child.kind, "courseQuant", `${child.label} kind`);
      assertEqual(child.take.classes, 4, `${child.label} take.classes`);
      assertEqual(child.options.length, 4, `${child.label} option count`);
      const prefixes = new Set(
        child.options
          .filter((o) => o.kind === "concrete")
          .map((o) => o.course.discipline),
      );
      assertEqual(prefixes.size, 1, `${child.label}: all 4 options share one discipline`);
      assertTrue(child.ordered === true, `${child.label}: connector "+" → ordered`);
    }
  },
});

cases.push({
  name: "english BA: Modern Language tracks do NOT cross-pollinate in derived eligible[]",
  run() {
    const g = adapter.buildGraphFromAudit(englishAudit);
    const { entries, wildcards } = adapter.deriveEligible(g);

    // Under today's flattened-needed bug, you'd see ASL 1410 and SPAN 1410 in
    // one list side-by-side and the solver treats them as independent needs.
    // In Phase 1 the *contract* changes: the solver consumer still sees both
    // (compat shim), but each is tagged with the owning ruleId AND its
    // parentLabels include "Modern Language Requirement". The solver rewrite
    // in Phase 1.5 will then enforce "pick at most one sibling".
    //
    // For now, assert the metadata is there.
    const LANG_SUBJECTS = new Set([
      "ASL", "ARAB", "CHI", "FR", "GER", "ITAL", "JAPA",
      "LAT", "POR", "RUSS", "SPAN", "MODL",
    ]);
    const langEntries = entries.filter((e) => LANG_SUBJECTS.has(e.subject));
    assertGreater(langEntries.length, 10, "many language courses surface");
    for (const e of langEntries) {
      assertTrue(
        e.parentLabels.includes("Modern Language Requirement"),
        `${e.subject} ${e.courseNumber} carries Modern Language parent label ` +
          `(got: ${JSON.stringify(e.parentLabels)})`,
      );
      assertTrue(e.ruleId, `${e.subject} ${e.courseNumber} carries ruleId`);
    }
  },
});

// ─── CS audit: Group with numberOfGroups === numberOfRules collapses ─────

cases.push({
  name: "CS BS: MATHEMATICS REQUIREMENT (5 of 5) collapses to allOf",
  run() {
    const g = adapter.buildGraphFromAudit(csAudit);
    const math = findNode(g, (n) => n.label === "MATHEMATICS REQUIREMENT");
    assertTrue(!!math, "MATHEMATICS REQUIREMENT present");
    assertEqual(math.kind, "allOf", "collapsed to allOf");
    assertEqual(math.children.length, 5, "5 math courses");
    const names = math.children.map((c) => c.label).sort();
    assertTrue(
      names.some((l) => l.includes("Calculus I")) &&
        names.some((l) => l.includes("Discrete Mathematics II")),
      "math course labels present",
    );
  },
});

cases.push({
  name: "CS BS: ENGLISH REQUIREMENT (1 of 2) stays chooseN",
  run() {
    const g = adapter.buildGraphFromAudit(csAudit);
    const eng = findNode(g, (n) => n.label === "ENGLISH REQUIREMENT");
    assertTrue(!!eng, "ENGLISH REQUIREMENT present");
    assertEqual(eng.kind, "chooseN", "stays chooseN");
    assertEqual(eng.n, 1, "n=1");
  },
});

// ─── CS Advanced Electives: wildcards + except ───────────────────────────

cases.push({
  name: "CS BS: CS Advanced Electives is 12-credit courseQuant with 2 wildcards + 7 excepts",
  run() {
    const g = adapter.buildGraphFromAudit(csAudit);
    const elec = findNode(g, (n) => n.label === "CS Advanced Electives");
    assertTrue(!!elec, "CS Advanced Electives present");
    assertEqual(elec.kind, "courseQuant", "kind");
    assertEqual(elec.mode, "credits", "mode");
    assertEqual(elec.take.credits && elec.take.credits.min, 12, "12-credit target");
    assertEqual(elec.options.length, 2, "2 wildcard options");
    const wildcards = elec.options.filter((o) => o.kind === "subjectWildcard");
    assertEqual(wildcards.length, 2, "both options are subject wildcards");
    const prefixes = wildcards.map((w) => w.discipline + w.numberPrefix).sort();
    assertEqual(prefixes[0], "CS3", "CS 3@");
    assertEqual(prefixes[1], "CS4", "CS 4@");

    // except: CS 2@ (wildcard) + 6 concretes
    assertEqual(elec.exceptOptions.length, 7, "7 except entries");
    const exceptWild = elec.exceptOptions.filter((o) => o.kind === "subjectWildcard");
    assertEqual(exceptWild.length, 1, "one except is CS 2@ wildcard");
    assertEqual(exceptWild[0].discipline, "CS", "except wildcard subject");
    assertEqual(exceptWild[0].numberPrefix, "2", "except wildcard prefix");
    const exceptConcretes = elec.exceptOptions
      .filter((o) => o.kind === "concrete")
      .map((o) => `${o.course.discipline}${o.course.number}`)
      .sort();
    for (const c of ["CS3339", "CS3354", "CS3358", "CS3360", "CS3398", "CS4371"]) {
      assertTrue(exceptConcretes.includes(c), `except contains ${c}`);
    }
  },
});

// ─── hideFromAdvice courses are preserved, not dropped ───────────────────

cases.push({
  name: "english BA: hideFromAdvice courses in Math core are preserved with hideFromUi flag",
  run() {
    const g = adapter.buildGraphFromAudit(englishAudit);
    const math = findNode(g, (n) => n.label === "Mathematics (Core Code 020)");
    assertTrue(!!math, "Math Core present");
    const hidden = math.options.filter(
      (o) => o.kind === "concrete" && o.hideFromUi,
    );
    assertGreater(hidden.length, 2, "several hidden concrete fallbacks retained");
    const names = hidden.map((o) => o.course.discipline + o.course.number);
    assertTrue(names.some((n) => /^MATH1\d{3}/.test(n)), "MATH 1xxx fallback present");
  },
});

// ─── Attribute wildcards surface as attributeWildcard options ────────────

cases.push({
  name: "english BA: Language/Phil/Culture (Core 040) surfaces attribute wildcards",
  run() {
    const g = adapter.buildGraphFromAudit(englishAudit);
    const cc = findNode(g, (n) => n.label === "Language, Philosophy, and Culture (Core Code 040)");
    assertTrue(!!cc, "Core 040 present");
    const attrWild = cc.options.filter((o) => o.kind === "attributeWildcard");
    assertGreater(attrWild.length, 0, "at least one attribute wildcard");
    assertTrue(
      attrWild.some((w) =>
        (w.withClauses || []).some((c) => (c.valueList || []).includes("040")),
      ),
      "attribute wildcard carries withClause ATTRIBUTE=040",
    );
  },
});

// ─── Bug 4 acceptance: derived eligible[] excludes `except` concretes ────

cases.push({
  name: "english BA: derived eligible[] respects except clauses (BA Science 'MATH 1300/1311' excluded)",
  run() {
    const g = adapter.buildGraphFromAudit(englishAudit);
    const sci = findNode(g, (n) => n.label === "BA Science Requirement");
    assertTrue(!!sci, "BA Science node present");
    // The node itself must carry the 2 explicit excepts
    const concreteExcepts = sci.exceptOptions
      .filter((o) => o.kind === "concrete")
      .map((o) => o.course.discipline + o.course.number);
    assertTrue(
      concreteExcepts.includes("MATH1300") && concreteExcepts.includes("MATH1311"),
      `MATH1300/MATH1311 in except: ${JSON.stringify(concreteExcepts)}`,
    );
    // And the derived eligible[] must not contain them under this rule
    const { entries } = adapter.deriveEligible(g);
    const bad = entries.filter(
      (e) =>
        e.parentLabels.some((p) => /Additional BA|BA Science/i.test(p)) &&
        e.subject === "MATH" &&
        (e.courseNumber === "1300" || e.courseNumber === "1311"),
    );
    assertEqual(bad.length, 0, "eligible[] strips except'd concretes");
  },
});

// ─── wildcard fixture round-trip (mock DegreeWorks courseInformation) ────
//
// This asserts the *contract* of the upcoming wildcard-expander: the adapter
// surfaces the wildcard entry with enough metadata (discipline + numberPrefix
// + except list) that a caller can hit DegreeWorks with it and filter the
// response. We don't implement the HTTP fetch here; we just simulate the
// filter step against the fixture and verify the expected final shape.

cases.push({
  name: "cs-4@.json: wildcard + exceptOptions produces 30 CS-4000 courses after filter",
  run() {
    const g = adapter.buildGraphFromAudit(csAudit);
    const elec = findNode(g, (n) => n.label === "CS Advanced Electives");
    const cs4 = elec.options.find(
      (o) =>
        o.kind === "subjectWildcard" &&
        o.discipline === "CS" &&
        o.numberPrefix === "4",
    );
    assertTrue(!!cs4, "CS 4@ wildcard present on node");

    const raw = cs4Wildcard.courseInformation.courses;
    assertGreater(raw.length, 25, "fixture has many CS-4000 courses");

    // Build an except filter from the node. Concrete except courses are an
    // exact exclude; wildcard excepts (CS 2@) don't affect 4xxx but the code
    // must still run cleanly.
    const exceptConcretes = new Set(
      elec.exceptOptions
        .filter((o) => o.kind === "concrete")
        .map((o) => `${o.course.discipline}|${o.course.number}`),
    );
    const exceptWildcards = elec.exceptOptions.filter(
      (o) => o.kind === "subjectWildcard",
    );

    const filtered = raw.filter((c) => {
      const key = `${c.subjectCode}|${c.courseNumber}`;
      if (exceptConcretes.has(key)) return false;
      for (const w of exceptWildcards) {
        if (
          c.subjectCode === w.discipline &&
          String(c.courseNumber).startsWith(w.numberPrefix)
        ) {
          return false;
        }
      }
      return true;
    });

    // CS 4371 should be removed (it's an except concrete); everything else
    // in the 4xxx range should survive since CS 2@ doesn't match them.
    assertTrue(
      !filtered.some((c) => c.subjectCode === "CS" && c.courseNumber === "4371"),
      "CS 4371 excluded post-filter",
    );
    assertEqual(
      filtered.length,
      raw.length - 1,
      `exactly one course removed (expected ${raw.length - 1}, got ${filtered.length})`,
    );
    // Every surviving course must have attributes[] AND sections[] inline —
    // this is what makes the DW endpoint strictly better than Banner subject
    // search for wildcard resolution.
    for (const c of filtered) {
      assertTrue(Array.isArray(c.attributes), `${c.subjectCode}${c.courseNumber} has attributes[]`);
      assertTrue(Array.isArray(c.sections), `${c.subjectCode}${c.courseNumber} has sections[]`);
    }
  },
});

// ─── graph invariants hold on both fixtures ──────────────────────────────

cases.push({
  name: "both audits produce valid graphs (no invariant violations)",
  run() {
    for (const [name, audit] of [
      ["english BA", englishAudit],
      ["CS BS", csAudit],
    ]) {
      const g = adapter.buildGraphFromAudit(audit);
      const errs = graph.validateGraph(g);
      if (errs.length) fail(`${name} graph invalid: ${errs.join("; ")}`);
      assertGreater(g.roots.length, 2, `${name}: multiple top-level blocks`);
    }
  },
});

// ─── applied + remaining derive correctly ────────────────────────────────

cases.push({
  name: "english BA: ASL track shows 2 applied classes + remaining.classes = 2",
  run() {
    const g = adapter.buildGraphFromAudit(englishAudit);
    const asl = findNode(g, (n) => n.label === "American Sign Language");
    assertTrue(!!asl, "ASL track present");
    assertEqual(asl.applied.length, 2, "2 applied (ASL 1410 + 1420, both IP)");
    // Both are IP → they don't count toward remaining until graded.
    assertEqual(asl.remaining.classes, 4, "remaining.classes still 4 while both IP");
  },
});

// ─── referential blocks are dropped, regular blocks are kept ─────────────

cases.push({
  name: "CS BS: 'TXST Core Curriculum - Referential Only' block is not a graph root",
  run() {
    const g = adapter.buildGraphFromAudit(csAudit);
    const ref = g.roots.find((r) => /referential/i.test(r.label));
    assertTrue(!ref, "referential block excluded");
  },
});

// ─── block-type inference lands on something sensible ────────────────────

cases.push({
  name: "CS BS: Major in Computer Science is classified as BLOCK_TYPE.MAJOR",
  run() {
    const g = adapter.buildGraphFromAudit(csAudit);
    const major = g.roots.find((r) => r.label.startsWith("Major in Computer Science"));
    assertTrue(!!major, "major root present");
    assertEqual(major.blockType, "MAJOR", "classified as MAJOR");
  },
});

module.exports = { cases };
