// Bobcat Plus — Wildcard expansion primitives (Bug 4 Layer B + C).
//
// DegreeWorks exposes a `/api/course-link` endpoint (response wrapped in a
// `courseInformation` envelope, hence the historical name) that takes a
// subject + number pattern and returns a list of matching courses with
// inline section data for each offered term. This file contains:
//
//   - `normalizeCourseInformationCourses` — pure parser that turns a raw
//     response into schedule-generator-ready entries. Fixture-backed by
//     `tests/fixtures/wildcard/cs-4@.json`. No network, no chrome.* API.
//
//   - `expandAuditWildcards` — pure async orchestrator that takes the
//     wildcard records `deriveEligible()` surfaces, an injected
//     `fetchCourseLink(subject, numberPattern)` callback, and the current
//     termCode; resolves each wildcard into concrete `needed[]` entries
//     with `except` subtraction applied. Used by `background.js` to fold
//     wildcard expansions into the eligible pool before section search.
//     Tests inject a canned fetcher that replays the cs-4@ fixture.
//
// The actual HTTP fetcher + chrome.storage cache is `fetchCourseLinkFromDW`
// in `background.js`; it's split out so this module stays runtime-agnostic
// and unit-testable in plain Node. See `docs/decisions.md` D13 for the
// parser/fetcher split rationale.
//
// Dual-export: usable both in the extension runtime (attaches to
// `globalThis.BPReq`) and in Node unit tests (`module.exports`).

(function (global) {
  "use strict";

  // Normalize a DegreeWorks `courseInformation` JSON response into an array
  // of concrete course entries + their available sections filtered to a
  // specific term.
  //
  // @param raw       Parsed JSON object of the shape
  //                  `{ courseInformation: { courses: [...] } }`
  //                  OR the bare `{ courses: [...] }` shape.
  // @param options   Optional: { termCode, excludeKeys, attributeFilter,
  //                  ruleLabel, ruleId, parentLabels }.
  //                  termCode: e.g. "202630". If set, each entry's
  //                    `sections[]` is filtered to sections whose section.
  //                    termCode matches.
  //                  excludeKeys: Set of `"SUBJ|NUMBER"` strings that should
  //                    be dropped (honors wildcard exceptions).
  //                  attributeFilter: string attribute code; only courses
  //                    whose `attributes[].code === filter` are kept.
  //                  ruleLabel / ruleId / parentLabels: provenance, passed
  //                    through to each output entry so downstream rationale
  //                    prompts can cite the requirement that surfaced the
  //                    course.
  // @returns Array<{
  //   subject, courseNumber, title, creditHourLow, attributes,
  //   prerequisites, sections, label, parentLabels, ruleId
  // }>
  function normalizeCourseInformationCourses(raw, options = {}) {
    const courses = _extractCourses(raw);
    const {
      termCode = null,
      excludeKeys = null,
      attributeFilter = null,
      ruleLabel = "",
      ruleId = null,
      parentLabels = [],
    } = options;
    const exclude =
      excludeKeys instanceof Set
        ? excludeKeys
        : Array.isArray(excludeKeys)
          ? new Set(excludeKeys)
          : null;

    const out = [];
    for (const c of courses) {
      const subject = c.subjectCode || c.discipline || "";
      const courseNumber = c.courseNumber || c.number || "";
      if (!subject || !courseNumber) continue;
      if (exclude && exclude.has(subject + "|" + courseNumber)) continue;
      if (attributeFilter) {
        const attrs = Array.isArray(c.attributes) ? c.attributes : [];
        const match = attrs.some(
          (a) => a && (a.code === attributeFilter || a.attribute === attributeFilter),
        );
        if (!match) continue;
      }

      const sectionsRaw = Array.isArray(c.sections) ? c.sections : [];
      const sections = termCode
        ? sectionsRaw.filter((s) => String(s.termCode) === String(termCode))
        : sectionsRaw.slice();

      out.push({
        subject,
        courseNumber,
        title: c.title || "",
        creditHourLow: _toNum(c.creditHourLow),
        creditHourHigh: _toNum(c.creditHourHigh),
        attributes: Array.isArray(c.attributes)
          ? c.attributes.map((a) => ({ code: a.code, description: a.description }))
          : [],
        prerequisites: Array.isArray(c.prerequisites) ? c.prerequisites.slice() : [],
        sections,
        label: ruleLabel,
        parentLabels: parentLabels.slice(),
        ruleId,
      });
    }
    return out;
  }

  // Given a wildcard record from `deriveEligible().wildcards[]`, build a
  // cache key safe to use as a map key. Stable across runs so a cache lookup
  // can elide a live fetch on the hot path.
  function wildcardCacheKey(wildcard, termCode) {
    const disc = wildcard.discipline || "@";
    const numPrefix = wildcard.numberPrefix || "@";
    const withs = Array.isArray(wildcard.withClauses) ? wildcard.withClauses : [];
    const withsSer = withs
      .map((w) => `${w.field || ""}:${w.code || ""}`)
      .sort()
      .join(";");
    return ["cinf", termCode || "?", disc, numPrefix, withsSer].join("|");
  }

  // Build the set of `"SUBJ|NUMBER"` keys that should be excluded from the
  // expansion results, based on the wildcard's `exceptOptions`.
  function exceptionKeysFromWildcard(wildcard) {
    const excepts = Array.isArray(wildcard.exceptOptions)
      ? wildcard.exceptOptions
      : [];
    const out = new Set();
    for (const opt of excepts) {
      if (!opt || opt.kind !== "concrete") continue;
      if (opt.course && opt.course.discipline && opt.course.number) {
        out.add(opt.course.discipline + "|" + opt.course.number);
      }
    }
    return out;
  }

  // ─── orchestration: audit wildcards → concrete needed[] entries ─────────
  //
  // Bug 4 Layer B (wildcard expansion) + Layer C (honor `except`).
  //
  // Inputs:
  //   input.wildcards     Array from `deriveEligible(graph).wildcards`.
  //                       Each entry has { discipline, numberPrefix,
  //                       ruleLabel, ruleId, parentLabels, exceptOptions,
  //                       kind }.
  //   input.needed        Existing concrete needed[] entries
  //                       ({subject, courseNumber, label, ...}); used
  //                       for dedupe so expansion doesn't double-add a
  //                       course that another (concrete) rule already
  //                       contributed.
  //   input.completed     Student's completed courses ({subject,
  //                       courseNumber, grade}); expansion entries that
  //                       match are skipped.
  //   input.inProgress    Student's in-progress courses; skipped too.
  //
  //   options.fetchCourseLink  Required async `(subject, numberPattern) →
  //                            raw JSON | null`. The HTTP + cache wrapper
  //                            lives in background.js; tests pass a
  //                            fixture-replaying stub.
  //   options.termCode         Optional Banner term code (e.g. "202630").
  //                            When set, each entry's inline sections[]
  //                            is filtered to that term. Entries whose
  //                            sections become empty after filtering are
  //                            dropped — eligible-for-this-term is the
  //                            contract; courses not offered this term
  //                            don't belong on the student's list.
  //
  // Returns { needed, added, failures, skipped }:
  //   needed      input.needed concatenated with new expansion entries
  //               (same shape as concrete needed[]: {subject,
  //               courseNumber, label, parentLabels, ruleId}).
  //   added       Just the new entries (for diagnostics / logging).
  //   failures    Wildcards that threw or returned null from the fetcher;
  //               each is { wildcard, error } so callers can log them
  //               without masking which requirement surfaced no options.
  //   skipped     Wildcards intentionally not fetched (today: attribute-
  //               only `@@ with ATTRIBUTE=xxx`, which is Layer D1/D2).
  //
  // Layer B scope: subject wildcards (`CS @`, `CS 4@`) and subject-plus-
  // number-prefix wildcards. Attribute-only wildcards (`@ @` with a
  // `with` clause) are skipped for now — the bug4 diagnosis doc defers
  // them to Layer D; the hideFromAdvice concrete siblings that
  // RequirementGraph already surfaces typically cover that case in
  // practice. See docs/bugs/bug4-eligible.md.
  async function expandAuditWildcards(input, options) {
    const safeInput = input || {};
    const wildcards = Array.isArray(safeInput.wildcards)
      ? safeInput.wildcards
      : [];
    const needed = Array.isArray(safeInput.needed) ? safeInput.needed : [];
    const completed = Array.isArray(safeInput.completed)
      ? safeInput.completed
      : [];
    const inProgress = Array.isArray(safeInput.inProgress)
      ? safeInput.inProgress
      : [];

    const opts = options || {};
    const fetchCourseLink = opts.fetchCourseLink;
    const termCode = opts.termCode || null;

    if (typeof fetchCourseLink !== "function") {
      throw new Error(
        "expandAuditWildcards: options.fetchCourseLink is required (async (subject, numberPattern) → raw JSON)",
      );
    }

    const dedupe = new Set();
    for (const c of completed) {
      if (c && c.subject && c.courseNumber) {
        dedupe.add(c.subject + "|" + c.courseNumber);
      }
    }
    for (const c of inProgress) {
      if (c && c.subject && c.courseNumber) {
        dedupe.add(c.subject + "|" + c.courseNumber);
      }
    }
    for (const c of needed) {
      if (c && c.subject && c.courseNumber) {
        dedupe.add(c.subject + "|" + c.courseNumber);
      }
    }

    const added = [];
    const failures = [];
    const skipped = [];

    for (const w of wildcards) {
      if (!w || typeof w !== "object") continue;
      const disc = w.discipline || "";

      // Layer B boundary: must have a concrete subject. `@` on the
      // subject side means attribute-only wildcards (Math core
      // `@@ with ATTRIBUTE=020` etc.) — those go through Layer D.
      if (!disc || disc === "@") {
        skipped.push({ wildcard: w, reason: "attribute-only wildcard (Layer D)" });
        continue;
      }

      const numberPattern = (w.numberPrefix || "") + "@";

      let raw = null;
      try {
        raw = await fetchCourseLink(disc, numberPattern);
      } catch (e) {
        failures.push({
          wildcard: w,
          error: (e && (e.message || String(e))) || "fetcher threw",
        });
        continue;
      }
      if (!raw) {
        failures.push({ wildcard: w, error: "fetcher returned null" });
        continue;
      }

      const excludeKeys = exceptionKeysFromWildcard(w);
      const entries = normalizeCourseInformationCourses(raw, {
        termCode,
        excludeKeys,
        ruleLabel: w.ruleLabel || "",
        ruleId: w.ruleId || null,
        parentLabels: Array.isArray(w.parentLabels) ? w.parentLabels : [],
      });

      for (const e of entries) {
        const key = e.subject + "|" + e.courseNumber;
        if (dedupe.has(key)) continue;
        // Drop courses that have zero sections for the target term. When
        // `termCode` is null (no term scoping) we keep everything — the
        // caller is asking for the full wildcard expansion regardless of
        // term. When termCode is set and sections is empty, the course
        // literally isn't offered this term; surfacing it would just
        // clutter the eligible pool.
        if (termCode && (!e.sections || e.sections.length === 0)) continue;
        dedupe.add(key);
        added.push({
          subject: e.subject,
          courseNumber: e.courseNumber,
          label: e.label || "",
          parentLabels: Array.isArray(e.parentLabels)
            ? e.parentLabels.slice()
            : [],
          ruleId: e.ruleId || null,
        });
      }
    }

    return {
      needed: needed.concat(added),
      added,
      failures,
      skipped,
    };
  }

  // ─── internals ───────────────────────────────────────────────────────────

  function _extractCourses(raw) {
    if (!raw || typeof raw !== "object") return [];
    if (Array.isArray(raw.courses)) return raw.courses;
    if (raw.courseInformation && Array.isArray(raw.courseInformation.courses)) {
      return raw.courseInformation.courses;
    }
    return [];
  }

  function _toNum(v) {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  // ─── exports ─────────────────────────────────────────────────────────────

  const api = {
    normalizeCourseInformationCourses,
    wildcardCacheKey,
    exceptionKeysFromWildcard,
    expandAuditWildcards,
  };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  global.BPReq = global.BPReq || {};
  Object.assign(global.BPReq, api);
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
