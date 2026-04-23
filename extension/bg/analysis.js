// Bobcat Plus — eligible-course analysis pipeline (ES module).
//
// Owns `runAnalysis`: student + audit fetch, wildcard expansion via
// `fetchCourseLinkFromDW`, subject-batch Banner search, per-CRN prereq/description
// fan-out through `BPPerf.mapPool`, and `sendUpdate` streaming to the tab.
//
// **bail() contract:** after every `await`, `if (bail()) return` so stale
// runs cannot update the UI after a term switch. Pin count in
// `tests/unit/bailContract.test.js` — see docs/invariants.md #2.
//
// Refactor: `refactor-on-main` commit 7; imported by `../background.js`.

import { cacheSet } from "./cache.js";
import {
  getTerms,
  getCurrentTerm,
  searchCoursesBySubjects,
} from "./bannerApi.js";
import { checkPrereqs, getCourseDescription } from "./prereqs.js";
import { getStudentInfo, getAuditData, fetchCourseLinkFromDW } from "./studentInfo.js";

// --- Main analysis function ---
// isCurrent is an optional predicate — when it returns false the caller has
// started a newer analysis, so this run bails early to stop spamming the queue.
export async function runAnalysis(sendUpdate, termCodeOverride, isCurrent, { forceRefresh = false } = {}) {
  const current = typeof isCurrent === "function" ? isCurrent : () => true;
  const bail = () => !current();

  sendUpdate({ type: "status", message: "Detecting student info..." });
  const student = await getStudentInfo();
  if (bail()) return;
  sendUpdate({ type: "student", data: student });

  sendUpdate({ type: "status", message: "Loading degree audit..." });
  const {
    completed,
    inProgress,
    needed,
    auditDiagnostics,
    graph,
    wildcards,
  } = await getAuditData(student.id, student.school, student.degree);
  if (bail()) return;
  sendUpdate({
    type: "audit",
    data: {
      completed: completed.length,
      inProgress: inProgress.length,
      needed: needed.length,
    },
  });

  // NOTE: the "bail out if needed is empty" check used to live here, but
  // wildcard expansion (Bug 4 Layer B) can turn an empty concrete pool
  // into a populated one. Moved below, after expansion runs.

  sendUpdate({
    type: "status",
    message: "Resolving semester for section search...",
  });
  let term;
  if (termCodeOverride) {
    const terms = await getTerms();
    if (bail()) return;
    const found = terms.find((t) => t.code === termCodeOverride);
    term = found
      ? { code: found.code, description: found.description }
      : { code: termCodeOverride, description: termCodeOverride };
  } else {
    term = await getCurrentTerm();
    if (bail()) return;
  }
  sendUpdate({ type: "term", data: term });

  // --- Step 2.5: wildcard expansion (Bug 4 Layer B + C) ---
  //
  // RequirementGraph surfaces wildcards separately from concrete
  // `needed[]` entries. Resolve each one via DegreeWorks' course-link
  // endpoint and fold the results back into `needed[]` so they flow
  // through the same section-search → eligibility pipeline as concrete
  // courses. Layer C (honoring `except`) is free — the orchestrator
  // passes `exceptionKeysFromWildcard(w)` into the normalizer's
  // `excludeKeys` option.
  //
  // Failure modes degrade gracefully: if the fetcher returns null for a
  // given wildcard, that requirement just contributes nothing (logged in
  // the console). We never throw here — eligibility is best-effort.
  const bpReqExpandReady =
    typeof self !== "undefined" &&
    self.BPReq &&
    typeof self.BPReq.expandAuditWildcards === "function";

  if (bpReqExpandReady && Array.isArray(wildcards) && wildcards.length > 0) {
    sendUpdate({
      type: "status",
      message:
        "Expanding " +
        wildcards.length +
        " wildcard requirement" +
        (wildcards.length === 1 ? "" : "s") +
        "...",
    });
    try {
      const expansion = await self.BPReq.expandAuditWildcards(
        { wildcards, needed, completed, inProgress },
        { fetchCourseLink: fetchCourseLinkFromDW, termCode: term.code },
      );
      if (bail()) return;
      for (const entry of expansion.added) needed.push(entry);

      if (expansion.failures && expansion.failures.length) {
        console.warn(
          "[BobcatPlus] wildcard expansion: " +
            expansion.failures.length +
            " of " +
            wildcards.length +
            " wildcard(s) failed; those requirements will have no expanded candidates",
          expansion.failures.slice(0, 10).map((f) => ({
            label: f.wildcard && f.wildcard.ruleLabel,
            disc: f.wildcard && f.wildcard.discipline,
            prefix: f.wildcard && f.wildcard.numberPrefix,
            error: f.error,
          })),
        );
      }
      if (expansion.skipped && expansion.skipped.length) {
        console.info(
          "[BobcatPlus] wildcard expansion: " +
            expansion.skipped.length +
            " attribute-only wildcard(s) skipped (Layer D — hideFromAdvice siblings already in needed)",
        );
      }

      sendUpdate({
        type: "audit",
        data: {
          completed: completed.length,
          inProgress: inProgress.length,
          needed: needed.length,
        },
      });
    } catch (e) {
      console.warn(
        "[BobcatPlus] wildcard expansion threw; continuing with concrete needed[] only:",
        e,
      );
    }
  }

  if (needed.length === 0) {
    sendUpdate({
      type: "done",
      data: { eligible: [], blocked: [], notOffered: [], needed: [] },
    });
    return;
  }

  const eligible = [];
  const blocked = [];
  const notOffered = [];
  let oldestCacheTs = null; // track when course data was last fetched from Banner

  // Batch section search by subject (see searchCoursesBySubjects above).
  // We group `needed[]` by subject, make one paginated Banner call per
  // subject, and then index the returned sections back onto each course
  // entry by "${subject}|${courseNumber}". This collapses O(needed) round
  // trips to O(distinct subjects), which is the dominant speedup for this
  // phase.
  const uniqueSubjects = Array.from(
    new Set(
      needed
        .map((c) => (c && typeof c.subject === "string" ? c.subject.trim() : ""))
        .filter(Boolean),
    ),
  );
  sendUpdate({
    type: "status",
    message:
      "Searching " +
      uniqueSubjects.length +
      " subject" +
      (uniqueSubjects.length === 1 ? "" : "s") +
      " (" +
      needed.length +
      " course" +
      (needed.length === 1 ? "" : "s") +
      ")...",
  });
  let subjectSections;
  try {
    subjectSections = await searchCoursesBySubjects(
      uniqueSubjects,
      term.code,
      { forceRefresh },
    );
  } catch (e) {
    console.warn(
      "[BobcatPlus] searchCoursesBySubjects threw; marking all needed as notOffered:",
      e,
    );
    subjectSections = new Map();
  }
  if (bail()) return;

  if (subjectSections && subjectSections.__oldestTs) {
    oldestCacheTs = subjectSections.__oldestTs;
  }

  // Index returned sections by "SUBJECT|COURSENUMBER" for O(1) lookup.
  const sectionsIndex = new Map();
  for (const [, sections] of subjectSections) {
    if (!Array.isArray(sections)) continue;
    for (const s of sections) {
      if (!s) continue;
      const key = (s.subject || "") + "|" + (s.courseNumber || "");
      if (!sectionsIndex.has(key)) sectionsIndex.set(key, []);
      sectionsIndex.get(key).push(s);
    }
  }

  for (const course of needed) {
    if (bail()) return;
    const key = (course.subject || "") + "|" + (course.courseNumber || "");
    const matched = sectionsIndex.get(key);
    if (matched && matched.length > 0) {
      course.crn = matched[0].courseReferenceNumber;
      course.sections = matched;
      // Backfill the legacy per-course cache so the `getCourseSections`
      // UI message handler (which still uses single-course searchCourse)
      // sees a warm cache after an analysis run. Fire-and-forget; cache
      // write failures are non-fatal.
      const perCourseKey =
        `course|${term.code}|${course.subject}|${course.courseNumber}`;
      cacheSet(perCourseKey, matched).catch(() => {});
    } else {
      notOffered.push(course);
    }
  }

  if (bail()) return;

  // Check prereqs and fetch descriptions with bounded concurrency.
  //
  // Previously this fanned out a `Promise.all` over ~120+ courses, which
  // queued against Chrome's 6-sockets-per-origin cap and could wedge the
  // entire analysis if any single socket stalled (no per-request timeout).
  // `mapPool` caps in-flight requests at PREREQ_POOL_CONCURRENCY, and
  // `checkPrereqs` / `getCourseDescription` both use fetchWithTimeout
  // internally. Together that makes this phase bounded in both throughput
  // and worst-case latency. See docs/bugs/bug4-eligible.md.
  const coursesWithSections = needed.filter((c) => c.sections);
  const descCache = {};
  const PREREQ_POOL_CONCURRENCY = 6;
  const prereqTotal = coursesWithSections.length;
  let prereqDone = 0;
  // Throttled status tick-down — every 5 completions or every 400ms, whichever
  // comes first. Without this the status line sits on "Checking prerequisites
  // for N courses..." for the whole phase and makes slow runs look hung even
  // when they're making progress.
  let lastTickAt = 0;
  const tickStatus = () => {
    const now = Date.now();
    if (prereqDone === prereqTotal || prereqDone % 5 === 0 || now - lastTickAt > 400) {
      lastTickAt = now;
      sendUpdate({
        type: "status",
        message:
          "Checking prerequisites " + prereqDone + "/" + prereqTotal + "...",
      });
    }
  };
  sendUpdate({
    type: "status",
    message: "Checking prerequisites 0/" + prereqTotal + "...",
  });
  await self.BPPerf.mapPool(
    coursesWithSections,
    PREREQ_POOL_CONCURRENCY,
    async (course) => {
      if (bail()) return;
      try {
        const result = await checkPrereqs(
          course.crn,
          term.code,
          completed,
          inProgress,
        );
        if (bail()) return;
        if (result.met) {
          const cacheKey = course.subject + course.courseNumber;
          if (!descCache[cacheKey]) {
            descCache[cacheKey] = await getCourseDescription(
              course.crn,
              term.code,
            );
          }
          if (bail()) return;
          course.sections.forEach(
            (s) => (s.courseDescription = descCache[cacheKey]),
          );
          eligible.push(course);
          sendUpdate({ type: "eligible", data: course });
        } else {
          course.missingPrereqs = result.missing;
          blocked.push(course);
          sendUpdate({ type: "blocked", data: course });
        }
      } catch (e) {
        if (bail()) return;
        // Prereq check failed (network / timeout / parse error) — show the
        // course but flag it so the UI doesn't silently lie about
        // eligibility. AbortError from fetchWithTimeout lands here too.
        console.warn("[BobcatPlus] prereq check failed for", course.subject, course.courseNumber, e);
        course.prereqCheckFailed = true;
        eligible.push(course);
        sendUpdate({ type: "eligible", data: course });
      } finally {
        prereqDone++;
        tickStatus();
      }
    },
  );

  if (bail()) return;
  sendUpdate({
    type: "done",
    data: {
      eligible,
      blocked,
      notOffered,
      needed,
      cacheTs: oldestCacheTs,
      auditDiagnostics,
      // Phase 1: graph + wildcards flow through but are not yet consumed by
      // the solver. Populated whenever the BPReq modules loaded; null only
      // when the parse failed.
      graph,
      wildcards,
    },
  });
}

