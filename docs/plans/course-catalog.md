# Course Catalog — design note

**Status:** ⬜ *Open. RFC; not implemented.* Owns the per-course factual
data layer (L2 in `[forward-planner.md](forward-planner.md)` §1):
prereq DAGs, co-requisites, seasonality, credit ranges, attributes.
Pairs with `[forward-planner.md](forward-planner.md)` (the primary
consumer) and `[requirement-graph.md](requirement-graph.md)` (the
structural layer above it).

**Scope boundary.** This doc designs the *catalog*: a per-course,
program-independent dataset that is bundled with the extension and
refreshed opportunistically. It does **not** design degree
requirements (those are the RequirementGraph), per-student progress
(that's the ProgressOverlay inside `applied[]`), or live registration
data (that's Banner section search, which stays live).

**Why this exists as a separate layer.** Today, the extension fetches
prereq HTML from Banner per-CRN at runtime
(`[extension/bg/prereqs.js](../../extension/bg/prereqs.js)`) and parses
it via regex. This is fragile (Banner HTML drifts), slow (one fetch
per CRN), and only gives us per-section answers. The forward planner
needs *per-course* prereqs in a *structured* form, and it needs them
*synchronously in memory*. None of those needs are met by today's
path. The catalog is the new path.

---

## 1. What this stores

A **CourseCatalog** is the in-memory L2 datastore for the running
extension. It is a single object with three indexed sub-stores plus
metadata.

```ts
interface CourseCatalog {
  facts: Map<CourseKey, CourseFact>;           // ~5,000 entries at TXST
  prereqs: Map<CourseKey, PrereqExpr>;         // ~3,000 (only courses with prereqs)
  seasonality: Map<CourseKey, Seasonality>;    // ~5,000
  programs: Map<ProgramKey, ProgramSnapshot>;  // ~80 (top 20 majors × 4 catalog years)
  meta: CatalogMeta;
}

interface CourseFact {
  course: CourseRef;                           // {discipline, number}
  title: string;                               // "Calculus I"
  creditsMin: number;
  creditsMax: number;                          // === min for fixed-credit courses
  attributes: string[];                        // ["DTSC", "WRIT"] from DW courseInformation
  description?: string;                        // long; only stored for ~top 1000 most-needed courses
  retakeable: "no" | "for-credit" | "for-grade-only";
  coRequisites: CourseRef[];                   // courses that must be taken concurrently
  lastVerified: ISODate;
}

type PrereqExpr =
  | { kind: "course"; course: CourseRef; minGrade?: Grade; concurrent?: boolean }
  | { kind: "test"; testName: string; minScore: number }
  | { kind: "and"; children: PrereqExpr[] }
  | { kind: "or"; children: PrereqExpr[] }
  | { kind: "noPrereq" };

type Grade = "A" | "B" | "C" | "D" | "F" | "P";

interface Seasonality {
  course: CourseKey;
  fall: { observed: number; predicted: boolean; confidence: number };
  spring: { observed: number; predicted: boolean; confidence: number };
  summer: { observed: number; predicted: boolean; confidence: number };
  lastSeenTerm: TermCode | null;
  observationWindow: { firstTerm: TermCode; lastTerm: TermCode; termCount: number };
}

interface ProgramSnapshot {
  programKey: ProgramKey;       // "BBA-MKT-SALE-2025"
  catalogYear: string;          // "2025-2026"
  degree: string;               // "BBA"
  major: string;                // "MKT"
  concentration?: string;       // "SALE"
  graphSkeleton: RequirementGraphSkeleton;  // structure only, no per-student applied[]
  fetchedAt: ISODate;
}

interface CatalogMeta {
  version: string;              // "2026-08-15.0" — date + sequence
  bundledAt: ISODate;           // when this catalog was packaged
  refreshedAt: ISODate | null;  // when last opportunistically refreshed
  manifest: ManifestRef | null; // pointer to the remote manifest used
  source: "bundled" | "refreshed" | "hybrid";
  totals: { courses: number; prereqs: number; programs: number };
}

interface ManifestRef {
  url: string;
  version: string;
  sha256: string;
  fetchedAt: ISODate;
}

interface RequirementGraphSkeleton {
  // Same shape as RequirementGraph but with `applied[]` and `remaining[]`
  // empty/zero. The planner overlays the student's audit on top of this
  // for what-if features (minor-add, catalog switch).
  roots: RequirementNode[];
  exceptions: never[];          // always empty for skeleton
  meta: { catalog: string; programKey: ProgramKey; snapshotAt: ISODate };
  courseIndex: Map<CourseKey, RequirementNode[]>;
}

type CourseKey = string;        // "MATH|2417"
type ProgramKey = string;       // "BBA-MKT-SALE-2025"
type CourseRef = { discipline: string; number: string };
type TermCode = string;         // "202610"
type ISODate = string;
```

The catalog is **read-only** from the perspective of the planner and
all UI consumers. Updates happen exclusively through the refresh path
(§5). This is a hard invariant: any mutation invalidates planner
caches, so mutation must be a discrete, traceable event.

---

## 2. Data sources


| Field                                                             | Source                                        | Endpoint                                     | Cadence                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `CourseFact.title, credits, attributes, retakeable, coRequisites` | DegreeWorks `courseInformation`               | `GET /api/course-link?discipline=X&number=N` | At catalog build                                                                 |
| `CourseFact.description`                                          | Banner                                        | `getCourseDescription` (existing)            | Per-course on demand (~top 1k cached)                                            |
| `PrereqExpr`                                                      | DegreeWorks `courseInformation.prerequisites` | Same as above                                | At catalog build                                                                 |
| `Seasonality`                                                     | Aggregate of `subjectSearch                   | v2                                           | `* cache entries                                                                 |
| `ProgramSnapshot.graphSkeleton`                                   | DegreeWorks What-If endpoint                  | `POST /api/audit` with empty `classes: []`   | At catalog build (top 20 majors × 4 catalog years); on demand for niche programs |


**Two sources we deliberately don't consume:**

1. **Banner per-section prereq HTML.** This is what
  `[bg/prereqs.js](../../extension/bg/prereqs.js)` parses today. We are
   *replacing* this for catalog-level prereq facts. The runtime
   per-CRN check at registration time stays — it remains the
   load-bearing safety net (Banner is the source of truth at
   registration). See §6 for the migration plan.
2. **TXST course catalog (the PDF/HTML at the registrar website).**
  Could supplement the seasonality story but requires HTML scraping
   we don't have. Possible future addition; not blocking.

---

## 3. Bundled distribution

The catalog ships with the extension as a static JSON payload. This
gives cold-start performance (instant eligible list, instant planner
generation) and offline tolerance (the extension still works if
DegreeWorks is down for catalog updates).

### Files in the bundle

```
extension/data/catalog/
  facts.json          ~3 MB — all CourseFact entries (no descriptions)
  prereqs.json        ~1 MB — all PrereqExpr entries
  seasonality.json    ~200 KB — derived from 4-term backfill at build
  programs/           ~2 MB total — top 20 majors × 4 catalog years
    BBA-MKT-SALE-2025.json
    BS-CS-2025.json
    ...
  meta.json           ~1 KB — catalog version, build date, manifest URL
```

**Total bundle target:** ≤ 8 MB. CI gates the build on this number.

**Compression.** All JSON files are min-stringified (no whitespace) and
keyed for compactness (single-letter keys in the deserializer):

```json
{"k":"MATH|2417","t":"Calculus I","cn":4,"cx":4,"a":["WRIT"],"r":"no"}
```

A small `extension/data/catalog/decode.js` module expands the compact
form to the full type when the catalog is loaded. Saves ~40% bundle
size.

### What gets bundled vs fetched on demand


| Data                                                    | Bundled    | On-demand fetch        | Why                                   |
| ------------------------------------------------------- | ---------- | ---------------------- | ------------------------------------- |
| Top ~5,000 TXST courses (facts + prereqs)               | ✅          | —                      | Used by every planner run             |
| Seasonality                                             | ✅          | —                      | Used by every planner run             |
| Top 20 majors × 4 catalog years (~80 program snapshots) | ✅          | —                      | Most students are in one of these     |
| Niche majors / minors                                   | —          | ✅ (cached per-student) | Long tail; user demand triggers fetch |
| Course descriptions                                     | Top ~1,000 | ✅ (cached per-user)    | Long; rarely viewed                   |
| Per-student degree audit                                | —          | ✅ (current behavior)   | Per-student, per-session              |
| Open seat counts                                        | —          | ✅ (current behavior)   | Real-time only                        |


The "top 20 majors" list is hand-curated from registrar enrollment
data. Out-of-list students still work — their first session triggers a
What-If fetch for their program, cached locally for 30 days.

### Bundle build pipeline

A new build script: `scripts/catalog/build-bundle.js`. Runs offline,
not in the extension. Steps:

1. Read scraped audits + courseInformation fixtures from
  `tests/fixtures/audits/whatif/` and a parallel new
   `tests/fixtures/courseInformation/` directory (see §6).
2. Extract CourseFact + PrereqExpr from courseInformation responses.
3. Compute Seasonality from the cached subject-search dumps.
4. Build ProgramSnapshot from each What-If audit; strip per-student
  fields.
5. Write min-stringified JSON to `extension/data/catalog/`.
6. Update `meta.json` with new version + size totals.
7. Validate bundle is under size budget; fail if over.

The script uses the same DW cookie + rate-limiting pattern as
`[scripts/whatif/pull-audits.js](../../scripts/whatif/pull-audits.js)`.
Run on a developer machine (not CI) since it requires a DW session
cookie.

---

## 4. Seasonality — empirical derivation

`Seasonality` is *derived*, not authoritative. We have no source for
"this course is offered in fall only." We have observation: was this
course in last fall's term offerings?

### Algorithm

```ts
// Given:
//   observations: TermCode[] where the course had at least one section
//   knownTerms: TermCode[] of all terms we have data for
function computeSeasonality(observations: TermCode[], knownTerms: TermCode[]): Seasonality {
  const fallTerms = knownTerms.filter(isFallTerm);
  const springTerms = knownTerms.filter(isSpringTerm);
  const summerTerms = knownTerms.filter(isSummerTerm);

  const fallObserved = observations.filter(isFallTerm).length;
  const springObserved = observations.filter(isSpringTerm).length;
  const summerObserved = observations.filter(isSummerTerm).length;

  // confidence = (observed / known) raised to a slight smoothing factor
  return {
    fall: {
      observed: fallObserved,
      predicted: fallObserved >= Math.ceil(fallTerms.length / 2),
      confidence: Math.min(1, fallObserved / Math.max(1, fallTerms.length)),
    },
    spring: { /* same */ },
    summer: { /* same */ },
    lastSeenTerm: max(observations),
    observationWindow: {
      firstTerm: min(knownTerms),
      lastTerm: max(knownTerms),
      termCount: knownTerms.length,
    },
  };
}
```

### Confidence thresholds

For UI rendering and planner decisions:


| Confidence                          | Meaning                                            | Planner behavior                                  |
| ----------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| ≥ 0.75                              | "high" — observed in ≥ 75% of relevant prior terms | Use freely                                        |
| 0.5 – 0.75                          | "medium" — observed in 50-75%                      | Use with `medium` confidence in PlannedCourse     |
| 0.25 – 0.5                          | "low" — observed sometimes                         | Use with `low` confidence; surface yellow warning |
| < 0.25                              | "very low" — rarely or never observed in window    | Avoid in plans; surface red warning if pinned     |
| 0 with `lastSeenTerm` > 4 terms ago | "discontinued?"                                    | Surface "Last offered — verify with department"   |


### Cold-start problem

Bundle ships with seasonality from the build's data window (last 4
terms at build time). Students with fresh installs get this baseline.
Students who run the extension across multiple terms accrete more
observation data via their cached `subjectSearch|v2|*` entries. The
catalog refresh path (§5) merges accreted observations back into the
canonical seasonality periodically.

### Disclaimers in UX

Per user direction, every seasonality-derived statement carries a
disclaimer. Example tooltips:

> **Fall offering — high confidence.** Based on observations from Fall
> 2022, 2023, 2024, 2025. We are not affiliated with TXST and cannot
> guarantee future offerings. Verify with your advisor or the
> registrar's official course catalog.

> **Spring offering — low confidence.** Observed only in Spring 2023.
> May be a special-topics or one-time offering. Verify with department.

---

## 5. Versioning + refresh

The catalog is a *cache*. Bundled data is the cache's initial state;
refreshes update it without requiring a new extension version.

### Version string

`meta.version` format: `YYYY-MM-DD.N` where `N` is the build sequence
on that date. Lexicographically comparable.

### Manifest contract

A small JSON file hosted on a stable URL (TBD — likely
`raw.githubusercontent.com/BobcatPlus/BobcatPlus/main/manifest.json`
or a dedicated CDN endpoint, see §11 open question). Contents:

```json
{
  "version": "2026-09-01.0",
  "bundleSha256": "sha256:abc123…",
  "courseCount": 5142,
  "programCount": 82,
  "minimumExtensionVersion": "1.4.0",
  "deltaUrl": "https://.../catalog-deltas/2026-09-01.0.json",
  "publishedAt": "2026-09-01T18:00:00Z"
}
```

`minimumExtensionVersion` is the kill-switch: if the user's installed
extension is older than this, the extension surfaces a "please update"
banner and disables the planner (the data shape may be incompatible).
Chrome auto-update typically lands within 24 hours of a Web Store
publish, so this should be rare.

### Refresh flow

On extension service-worker boot:

1. Load bundled catalog (`facts.json` + `prereqs.json` + etc.) into
  memory. Set `meta.source = "bundled"`.
2. In the background (no blocking), fetch the manifest URL.
3. If `manifest.version > catalog.meta.version`:
  - If `manifest.minimumExtensionVersion > extensionVersion`: surface
   the kill-switch banner. Do not refresh.
  - Else: fetch `manifest.deltaUrl` (a small JSON describing changed
  courses, programs, prereqs). Apply to the in-memory catalog.
  Persist to `chrome.storage.local` as `catalog-overlay-vN`. Set
  `meta.source = "refreshed"`.
4. On subsequent boots, load bundled catalog *and* the persisted
  overlay; the overlay wins on conflict.
5. If the overlay is older than `manifest.version`, fetch the
  incremental delta and apply.

A user with a 6-month-old extension version still gets refreshed
catalog data — the bundle becomes the floor, the overlay is the
ceiling.

### Delta format

```json
{
  "version": "2026-09-01.0",
  "fromVersion": "2026-08-15.0",
  "courses": {
    "MATH|2417": { "creditsMin": 4, "creditsMax": 4, "attributes": ["WRIT", "QUANT"] },
    "ENG|3329":  null,                  // null = removed (rare; usually means course discontinued)
  },
  "prereqs": {
    "MATH|2417": { "kind": "or", "children": [/* … */] }
  },
  "programs": {
    "BS-CS-2025": { /* full ProgramSnapshot */ }
  },
  "seasonality": {
    "MATH|2417": { /* full Seasonality */ }
  }
}
```

Deltas are deltas because the full bundle is large and we don't want
~5MB downloads on every catalog change. A delta is typically ~50-100
KB.

### Failure modes

- Manifest fetch fails (network / CDN down): use bundled data; retry
on next boot.
- Delta fetch fails: same.
- Delta apply fails (schema drift): log loudly, fall back to bundled,
surface a "please update extension" hint.
- Bundled data corrupted (should be impossible — shipped JSON):
service worker throws on load (mirrors the hard-fail pattern in
D20).

---

## 6. Prereq DAG migration

Today's prereq path:

```
runAnalysis → mapPool → checkPrereqs(crn, term, completed, inProgress)
  → fetchSectionPrerequisites(Banner HTML)
  → regex-parse ("Course or Test: <Subj> <Num> Minimum Grade of <Grade>")
  → return { met: bool, missing: string[] }
```

Lives in `[extension/bg/prereqs.js](../../extension/bg/prereqs.js)` and is
called per-CRN during eligible-list construction.

Two problems:

1. **Per-section, not per-course.** Two sections of MATH 2417 can have
  identical prereqs but require two separate fetches.
2. **HTML regex is fragile.** Banner's HTML has changed twice in two
  years (per `docs/postmortems/`). Each break required a parser
   update.
3. **Not usable by the planner.** The planner needs prereqs at plan
  time, not registration time, and per-course, not per-CRN.

### New path

```
extension load → catalog.prereqs is in memory (from bundle)
planner: for course X, lookup catalog.prereqs.get("MATH|2417")
       → returns PrereqExpr (structured)
       → planner walks the expression tree
```

For courses NOT in the catalog (rare; long-tail electives), the
planner falls back to fetching `courseInformation` for that course on
demand. The result is added to the in-memory catalog and persisted to
`catalog-overlay`.

### Coexistence during migration

`bg/prereqs.js` is **not deleted in this phase**. It remains the
runtime per-CRN check at the moment of registration ("can the student
actually register for this section right now?"). It is the trust
floor. The catalog is the planning floor.

**Eligibility check at the moment of "build my schedule" is the
intersection:**

- Catalog says prereqs are met (planning trust)
- AND Banner per-CRN says prereqs are met (registration trust)

If catalog says yes but Banner says no, surface a clear "Banner
disagrees — your catalog data may be stale, refreshing now..."
message. This is a tripwire for catalog drift and gives us empirical
data on how often it happens.

### Schema discovery

Before we can write the catalog builder, we need to confirm the
shape of `courseInformation.prerequisites` across course types. The
rule-shape-discovery branch saw it once (CS 4@). We need ~15
fixtures across CS, MATH, ENG, BIO, MUS, BUS to lock the schema.

This is the **fixture sweep** from the prior planning conversation.
Concrete deliverable:

- `tests/fixtures/courseInformation/` directory with 15 JSON files
named `{discipline}-{number}.json`.
- `docs/plans/prereq-schema.md` (a small companion doc) — one page,
enumerating observed shapes:
  - "single course prereq": `{type: "course", subject: "MATH", num: "1316"}`
  - "AND group": `{type: "and", children: [...]}`
  - "OR group": `{type: "or", children: [...]}`
  - "test score": `{type: "test", testName: "ALEKS", minScore: 60}`
  - any others.
- A typed parser in `extension/requirements/prereqParser.js` that
consumes the raw shape and returns `PrereqExpr`.

The fixture sweep is a **prerequisite to all catalog work**. Until
the schema is confirmed, the type system above is provisional.

---

## 7. Co-requisites

Today, co-reqs are partially modeled via the `pairedCourse` field on
the eligible course in the solver
(`[scheduler/solver/solver.js:178-194](../../extension/scheduler/solver/solver.js)`).
This is a hack: we pair lab + lecture by hand-curated heuristic.

Catalog will model co-reqs explicitly:

```ts
// CourseFact
coRequisites: CourseRef[];  // courses that must be taken concurrently
```

Sourced from `courseInformation` (we believe; needs schema
confirmation in fixture sweep). Common case: CHEM 1341 (lecture)
co-reqs CHEM 1141 (lab).

### Planner behavior

When the planner places a course with co-reqs, it places all
co-requisite courses in the same `TermSlate`. If credits would
exceed the slate cap, the entire bundle moves to a later term.

### Solver integration

The single-term solver already has `pairedCourse` logic. Migration:
the catalog becomes the source of truth for co-reqs; the solver
reads from the catalog instead of the hand-curated list. Solver
code is unchanged in shape.

---

## 8. Advisor-exception affordance

DegreeWorks' `exceptionArray` records advisor-granted substitutions
that are *already in the audit*. The catalog respects these (they
flow through unchanged from the audit).

This doc adds a new affordance: **student-recorded informal
overrides**. A student who has a verbal arrangement with their
advisor (not yet entered in DW) can mark a leaf as satisfied
manually:

```ts
interface AdvisorOverride {
  ruleId: string;                    // RequirementGraph leaf id
  satisfiedBy: CourseRef | "waiver"; // either a substitute course or a waiver
  notedAt: ISODate;
  studentNote: string;               // free text — "Dr. Smith said this counts"
}
```

Stored in `chrome.storage.local` as `advisor-overrides-{studentId}`.
Surfaced in the planner with a clear `"override"` badge:

> ENG 3329 marked complete via advisor override on 2026-09-15.
> Note: "Dr. Smith said the transfer course satisfies this." This is a
> planning aid only; verify with your advisor.

### Strong disclaimer

The override UI carries a non-dismissible warning at the moment of
creation:

> Bobcat Plus cannot verify advisor agreements. This override is for
> your planning only. Always confirm with your advisor before
> registering or graduating. We are not affiliated with TXST.

### Flow into Plan

The planner treats override-marked leaves as satisfied (same as
`applied[]` from the audit) but tracks them separately in the Plan
output for surfacing.

---

## 9. What this does NOT include

- **Open seat counts.** Banner stays live. The catalog has no notion
of seat availability.
- **Per-student degree audit.** That's `applied[]` inside
RequirementGraph. The catalog has no per-student data.
- **Section-level meeting times.** Per-CRN data lives in Banner cache.
Catalog is per-course only.
- **Faculty / quality data.** RateMyProf integration is separate.
- **Cost / financial-aid information.** Out of scope.
- **Non-TXST universities.** D3 holds — TXST-only until university #2
is committed.
- **In-progress course tracking.** The audit captures `IP` grades;
catalog is timeless.

---

## 10. Postmortem-in-advance

*Six months from now we rolled this back. What happened?*

1. **Failure mode:** Bundled catalog grows past 8 MB, extension
  review gets flagged for size, Web Store update is delayed.
   **Mitigation:** Hard size budget enforced at build (`scripts/catalog/build-bundle.js`
   fails CI if over). If we exceed it, we trim by: dropping
   descriptions for courses with low-frequency requirement appearance;
   reducing program snapshots to top 15 majors instead of 20.
2. **Failure mode:** Catalog prereqs drift from Banner reality. The
  planner says "you can take MATH 2417" but at registration Banner
   blocks. Trust hit.
   **Mitigation:** Tripwire built into eligibility check (§6). When
   catalog and Banner disagree, log it loudly + surface to user as
   "data may be stale." Aggregate counts on a dashboard (see
   `compass.md` or future telemetry). If drift rate >1% of checks,
   trigger a manual catalog rebuild.
3. **Failure mode:** Manifest URL goes down (CDN outage, GitHub
  issues). Refresh fails for everyone.
   **Mitigation:** Use bundled data as fallback. Refresh failures are
   non-blocking. Surface a small "catalog data is from "
   indicator in settings UI so users can see staleness.
4. **Failure mode:** Schema drift in `courseInformation`. DW changes
  the JSON shape of `prerequisites`. Catalog builder breaks; future
   refreshes have wrong data.
   **Mitigation:** Catalog builder validates schema against a
   reference fixture before writing. Fail loudly; humans investigate.
   Versioned parser in `extension/requirements/prereqParser.js`
   handles known shapes; new shapes are recorded as tickets.
5. **Failure mode:** Overlay storage in `chrome.storage.local`
  accumulates over time, hits the 5MB quota, eviction starts
   silently.
   **Mitigation:** Use `unlimitedStorage` permission in manifest. The
   extension already requests broad permissions; one more is fine.
   Periodically (on each boot) prune overlay entries older than the
   bundled version (since they're now incorporated).
6. **Failure mode:** A student in a niche major (catalog has no
  ProgramSnapshot for them) hits a 30+ second cold load while we
   fetch their What-If audit.
   **Mitigation:** Show a "loading your degree program (one-time)…"
   spinner. Cache aggressively. Allow the planner to render a
   "still loading — partial plan below" state so the user sees
   *something*.

---

## 11. Open design questions

1. **Where does the manifest live?** Three options: GitHub raw URL
  (free, slow-ish, public), CDN like Cloudflare Pages (fast, free
   for low traffic, requires setup), or DW itself (fragile — DW is
   not designed as a manifest host). Recommend GitHub raw for v1;
   measure traffic and migrate if needed.
2. **What's the right top-N majors list?** Need TXST registrar
  enrollment data. Educated guess: BS-CS, BBA-MGMT, BBA-MKT, BS-BIO,
   BA-ENG, BS-PSY, BS-EXSCI, BBA-ACCT, BS-CRIM, BA-COMM. Stub list
   becomes a pre-implementation deliverable.
3. **Do we ship descriptions for all 5,000 courses?** Pros: rich UI,
  no per-course fetches. Cons: bundle size. Recommend shipping for
   top ~1,000 (most-needed across major requirement graphs); fetch on
   demand for the rest.
4. **Catalog year cutoff.** Bundle 4 catalog years (2022-26) covers
  current students. As new years publish, do we drop the oldest
   from the bundle? Recommend keeping 5-year sliding window.
5. **What's the refresh cadence the manifest reflects?** If we
  manually rebuild the catalog every month, the manifest version
   lags real Banner state by up to 30 days. If we automate, we can
   ship weekly. Automation requires a long-lived DW cookie which we
   don't have. Recommend monthly manual for v1.
6. **Does seasonality observation accumulate across users?** A power
  user runs the extension across 4 terms, accumulates rich
   seasonality data. Currently this is local-only. Could it feed
   back to the centralized catalog? Privacy implications; defer to
   a later RFC.
7. **Rebuild trigger when DW shape changes.** Today: someone notices,
  files a ticket, manually updates parser + rebuilds. Could be
   automated with a CI smoke test that fetches a known fixture and
   asserts shape. Worth doing soon after L2 ships.

---

## 12. Concrete implementation steps (in order)

1. **Schema fixture sweep (PREREQUISITE — do first).** Pull
  `courseInformation` JSON for 15 courses across MATH, CS, ENG,
   BIO, MUS, BUS, EE. Save to `tests/fixtures/courseInformation/`.
   Write `docs/plans/prereq-schema.md` documenting observed shapes.
2. **Type definitions.** Create `extension/data/catalog/types.js`
  with the type definitions from §1. Pure file.
3. **Parser.** Create `extension/requirements/prereqParser.js`. Pure
  function: raw `courseInformation.prerequisites` → `PrereqExpr`.
   Unit tests against the 15 fixture files.
4. **Bundle build script.**
  `scripts/catalog/build-bundle.js`. Reads from
   `tests/fixtures/audits/whatif/` + `tests/fixtures/courseInformation/`,
   writes to `extension/data/catalog/`. Includes size budget check.
5. **Manifest hosting.** Set up the manifest URL (GitHub raw for v1).
  Publish initial manifest pointing at v1 bundle.
6. **Catalog loader.** `extension/data/catalog/loader.js`. Loads
  bundled JSON files into in-memory `CourseCatalog`. Service-worker
   side effect on boot (mirrors `bg/prereqs.js` import pattern).
7. **Catalog refresher.** `extension/data/catalog/refresh.js`. Background
  manifest fetch, delta apply, persist overlay to
   `chrome.storage.local`. Non-blocking on boot.
8. **Seasonality builder.**
  `extension/data/catalog/seasonality.js`. Pure function: array of
   subject-search snapshots → `Map<CourseKey, Seasonality>`. Used by
   build script and runtime accumulation.
9. **Co-req modeling.** Update solver
  (`[scheduler/solver/solver.js:178+](../../extension/scheduler/solver/solver.js)`)
   to consume `catalog.facts.get(course).coRequisites` instead of
   the hand-curated `pairedCourse`. Pair-detection becomes a
   catalog query.
10. **Advisor-override storage + UI.** New file
  `extension/tab/overrides.js`. UI surface in the requirements view.
    Disclaimer-heavy.
11. **Planner integration.** Forward planner depends on this — it's
  its primary input. See `[forward-planner.md](forward-planner.md)`
    §16 step 2.
12. **Eligibility tripwire.** When `bg/analysis.js` constructs
  eligibility list and the planner-suggested course gets Banner-
    rejected at registration, log a `catalog-drift` event. Surface
    to the user; aggregate to telemetry.

Steps 1-3 unblock everything else and should land first. Steps 4-7
form the catalog infrastructure. Steps 8-10 are L2 features. Steps
11-12 are integration with downstream consumers.

---

## 13. Cross-references

- Primary consumer: `[forward-planner.md](forward-planner.md)`.
- Underlying graph: `[requirement-graph.md](requirement-graph.md)`.
- MVP that ships before this:
`[grad-tracker.md](grad-tracker.md)`.
- Existing per-CRN check we're replacing for planning (but keeping
for runtime): `[extension/bg/prereqs.js](../../extension/bg/prereqs.js)`.
- Service-worker hard-import pattern this follows:
`[../decisions.md](../decisions.md)` D20.
- Bundled JSON cache strategy precedent: none in repo today.
- Existing What-If endpoint design:
`[whatif-endpoint.md](whatif-endpoint.md)`.

