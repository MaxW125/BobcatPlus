# Rule-Shape Discovery — design note (Phase 1.6, pre-RFC)

**Status:** ⬜ *Planning.* Companion to `docs/plans/requirement-graph.md` —
that doc designs the **model**; this doc designs the **discovery process** that
tells us which model shapes are actually out there. Phase 1 parser already
handles five `requirementType`s, four `ruleType`s semantically, and falls back
gracefully on the rest; we need data-driven confidence that "the rest" is
actually small before committing to a Phase 1.5 solver.

Grounded in three fixtures:
`tests/fixtures/audits/audit-english-ba.json`,
`audit-computerscience-bs-minor-music.json`, and
`audit-marketing-major-focusOnSales-fashionMerchandising-minor.json`
(the marketing one surfaced `requirementType: "CONC"`, not yet in
`BLOCK_TYPE`). Three fixtures is not enough. This plan lays out how to get
to ~800 audits across the 2022-2025 catalog years without hammering TXST IT.

---

## 1. The problem, in two questions

The success of Bobcat Plus depends on representing a student's degree
requirements accurately. The current `RequirementGraph` (Phase 1) was
designed against two audits and handles the shapes *those* audits expose.
Every new audit we look at surfaces at least one new classification,
qualifier, or rule quirk — `CONC` blocks, `ifElsePart` conditionals that
get silently dropped, `numberOfGroups` semantics that required a re-read of
the RFC. The long tail is real. We need to enumerate it before we build the
graph-native solver (SCRUM-35 / Phase 1.5) on top of an unverified model.

There are two *distinct* questions driving this work, and mixing them up
will waste time:


| #   | Question                                                                                         | Where the answer lives                      |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Q1  | What **combinations** (degree × major × concentration × minor × catalog year) are valid at TXST? | `mycatalog.txstate.edu` — authoritative.    |
| Q2  | What **structural shapes** does DegreeWorks emit for each combination?                           | The DegreeWorks audit JSON — only DW knows. |


The catalog can't answer Q2. A single audit can't enumerate Q1
efficiently. The sources are complementary — hence the hybrid approach
below.

---

## 2. Approaches considered


|     | Approach                                                                                              | Pros                                                                                                                                                                                                                                                    | Cons                                                                                                                                                                                                                            | Verdict                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A   | Real student audits only (status quo)                                                                 | Real advisor exceptions, real transfer credit, real `ifElsePart` branches that only fire for specific student states.                                                                                                                                   | Slow (~1/week), privacy asks, strong major-bias toward whoever is nearby, never covers 150+ programs.                                                                                                                           | **Keep as a gap-filler (Phase S6), not a primary mechanism.**                              |
| B   | Catalog scrape only                                                                                   | Offline-friendly, no auth, stable HTML, enumerates every valid (major × concentration) combo in one shot, reveals program-level oddities (teacher cert, honors tracks, BAAS wildcards) up front.                                                        | Cannot tell us rule-shape at all. Catalog prose ≠ DW rule types. `qualifierArray`, `ifElsePart`, `exceptionArray`, `connector`, `hideFromAdvice` — none are in the catalog.                                                     | **Necessary, not sufficient.** Use for combo enumeration.                                  |
| C   | DegreeWorks What-If only                                                                              | Produces the actual JSON DW would emit. "Invalid concentration → no CONC block" behavior (confirmed on marketing × AGED) gives us a combo-validity signal.                                                                                              | Auth + rate limit concerns. Without a catalog manifest the search space is huge (~150 majors × ~10 candidate concentrations × ~3 catalog years = thousands of speculative calls). Still can't produce advisor-exception shapes. | **Necessary, not sufficient.** Use for shape extraction *after* catalog scopes the search. |
| D   | **Hybrid:** catalog → combo manifest → what-if per combo → shape extractor → fixtures + model updates | Narrows the DW search to ~200 targeted hits. Produces a versioned, reproducible manifest in-repo. Shape inventory becomes a deterministic script, not human eyeballs on 12k-line JSONs. Composes cleanly with Approach A for the advisor-exception gap. | Upfront tooling cost (~3 focused sessions). Storage: 200–800 audit JSONs × ~12k lines ≈ 50–200 MB of local fixture dump.                                                                                                        | **✅ Chosen.**                                                                              |
| E   | Ask TXST IT for DegreeWorks scribe source                                                             | Would give every rule shape authoritatively.                                                                                                                                                                                                            | Requires an institutional relationship + FERPA/data-sharing conversation. Unrealistic this quarter.                                                                                                                             | **Out of scope.** Target for the eventual Ellucian / TXST contract conversation.           |


---

## 3. Terminology we keep tripping over

Pinning these so the rest of the doc is precise:

- **Double major.** Two majors under one *degree type* — e.g. BS in CS **and**
BS in Math, one diploma, one catalog year. What-If supports this via
*Additional areas of study* with a Major selected.
- **Dual degree.** Two separate degree types — e.g. BS in CS **and** BA in
English, two diplomas. What-If supports this via *Additional areas of
study* with both Degree *and* Major selected.
- **Concentration (CONC).** A named specialization within a major, surfaced as
a top-level block with `requirementType: "CONC"`, reached via one or two
`Blocktype` refs from the major. Marketing → Professional Sales is the
worked example.
- **Minor.** A separate block with `requirementType: "MINOR"`, reachable from
degree via its own `Blocktype` ref.
- `**IfPart` / `ElsePart`.** Two sides of an `IfStmt` conditional rule,
evaluated server-side by DW before the audit is emitted. Both branches
ship in the JSON; `percentComplete` tells you which one actually applied.

---

## 4. The plan (S0–S6)

### S0 — deliberately skipped

An earlier draft included a warm-up: absorb Lily's audit by adding
`BLOCK_TYPE.CONC` to `extension/requirements/graph.js` and updating the
parser. Dropped on purpose: the shape-extraction script in S4 operates on
**raw DW JSON**, not on the parsed RequirementGraph, so parser coverage of
`CONC` has zero effect on discovery. Model updates happen in S5 once we
have the full inventory.

### S1 — Catalog scrape (Node, regex, no deps)

Build `scripts/catalog/scrape-majors.js`:

- Fetch `https://mycatalog.txstate.edu/undergraduate/majors/` as the entry
point.
- Regex-extract `<a>` hrefs matching `/undergraduate/.../(bba|bs|ba|bfa|baas|bat|…)/`.
No dependency on `cheerio` — the catalog's HTML is stable and these link
patterns are deterministic. If the regex breaks in Fall 2027, reach for
`cheerio` then.
- Fetch each program page; regex-extract: `program_title` (H1), `degree_code`
from the slug, `major_code` from the slug, `concentration_code` from the
slug (`…-{x}-concentration-{degree}` pattern), `catalog_year` from the
page footer.
- Follow sidebar links to enumerate minors that appear as siblings (their
own page under `/undergraduate/*/minor/`).
- Repeat across the four catalog years TXST publishes at
`mycatalog.txstate.edu/{YYYY-YYYY}/…`, back to **Fall 2022** (covers the
Spring 2026 graduating class plus one extra semester).
- Emit `scripts/catalog/degree-combinations.json`:
  ```jsonc
  {
    "scrapedAt": "YYYY-MM-DD",
    "catalogYears": ["2022-2023", "2023-2024", "2024-2025", "2025-2026"],
    "programs": [
      {
        "title": "B.B.A. Major in Marketing (Professional Sales Concentration)",
        "degree": "BBA",
        "major": "MKT",
        "concentration": "SALE",
        "catalogYear": "2025-2026",
        "slug": "marketing-professional-sales-concentration-bba",
        "url": "https://…",
        "certifications": [],
        "honors": false
      }
      // … ~150–200 entries per catalog year
    ],
    "minors": [ { "title": "Minor in Fashion Merchandising", "code": "FM", … } ]
  }
  ```
- Cross-check: the scraped `concentration` code for Marketing-Sales must
equal `"SALE"`, matching Lily's audit's top-level `concentration: "SALE"`
field. If the manifest code ↔ DW code mapping isn't 1:1, document the
exceptions inline as manual overrides.

**Output:** one JSON manifest + a `scripts/catalog/README.md` with rerun
procedure. **No audit fetching.** Est. ~100 lines of Node. ~800 catalog
pages total across 4 years at ~1 req/sec ≈ 15 minutes wall-clock.

### S2 — Reverse-engineer the DW What-If endpoint (DevTools, no code)

Before building a driver, a human DevTools session to observe the
network traffic on Aidan's own DW account. Capture into
`docs/plans/whatif-endpoint.md`:

1. Request shape when selecting *Major: Marketing, Concentration:
  Professional Sales*. Expected: POST to
   `dw-prod.ec.txstate.edu/responsiveDashboard/api/audit` with `what-if`
   flags.
2. Response shape when selecting an **invalid** combo (*Major: Marketing,
  Concentration: Agricultural Education* — confirmed by Aidan to produce
   no CONC block). We need a **programmatic** signal, not just "block
   count is zero" — check for an explicit error field, a warning string,
   or a distinct HTTP status.
3. Response when setting `catalogYear: 202210` (Fall 2022). Does DW still
  honor catalog years ≥3 years old? Sometimes DW retires catalog years
   after 6; we need to know the cutoff.
4. Double-major behavior — add a second Major via *Additional areas of
  study*. Structural hypothesis: one DEGREE block, two MAJOR blocks
   reachable via two `Blocktype` refs.
5. Dual-degree behavior — add a second Degree + Major. Hypothesis: two
  top-level DEGREE blocks in `blockArray[]`, each with its own MAJOR
   chain. Core may or may not be deduped.
6. Auth: does the existing browser session cookie travel via `fetch` in a
  Node script, or does DW require a CSRF token in the body?

**Gate:** do not start S3 until this note lands. If the invalid-combo
signal is "block count is zero," we will accept that but write a defensive
post-check in S3 to detect it. If catalog year cutoffs limit us to
2023-2026 instead of 2022-2026, we re-scope S1/S3 downward.

### S3 — What-If audit driver (Node, reads S1 manifest, writes audits)

Build `scripts/whatif/pull-audits.js`:

- **Input:** `scripts/catalog/degree-combinations.json` from S1.
- **Output:** `tests/fixtures/audits/whatif/audit-{catalogYear}-{degree}-{major}-{concentration|nocon}.json`, one per valid combo. Plus a small set for
double-major (~~5 representative pairs within a degree type) and
dual-degree (~~3 pairs across degree types), captured under
`tests/fixtures/audits/whatif/doubled/`.
- **Hard constraints** (TXST IT goodwill is load-bearing for the whole
extension):
  - ≤1 request / 2 seconds. No parallelism.
  - Reuse the existing TXST session cookie — **no login automation**. Cookie
  jar lives in `~/.bobcatplus-dw-cookie` (gitignored), populated once by
  pasting the browser's `SSESSIONID` / DW session headers into a local
  file.
  - Idempotent: skip any combo whose output file already exists and is ≤30
  days old.
  - Abort on first 401/403 — never retry on auth failure. Print a "refresh
  your cookie" message and exit.
  - Log every call to `scripts/whatif/run.log` with
  `{timestamp, combo, outcome: "ok" | "invalid-combo" | "http-error" | "skipped"}`
  so we can compare dump-size against the manifest.
- **Expected scope:** ~~200 programs × 4 catalog years = **~~800 audits**. At 2
s/req this is ~27 min wall-clock per full run; usually we re-run only the
diffs.
- **Storage policy:** the whole dump is not committed. `.gitignore` covers
`tests/fixtures/audits/whatif/` bulk; S5 commits a curated subset
alongside the existing three fixtures.

### S4 — Shape-extraction & inventory (Node, reads audit dump)

Build `scripts/shape/extract-shapes.js`:

- Walks every `*.json` under `tests/fixtures/audits/` (both committed and
whatif dump).
- For each audit, collects distinct values and counts:
  - `requirementType` at block level (currently seen: DEGREE, MAJOR, MINOR,
  OTHER, CONC — expect to see at least: CERT, SPEC, TRACK, HONORS, possibly
  CORE).
  - `ruleType` at rule level (currently seen: Block, Blocktype, Subset,
  Group, Course, Complete, Incomplete, IfStmt, Noncourse — expect some
  tail).
  - `qualifierArray[*].code` (currently seen: MINGRADE, NOTGPA, NONEXCLUSIVE,
  EXCLUSIVE/DontShare — expect MAXCREDITS, MAXCLASSES, MUSTGRADE,
  MAXPASSFAIL, DEGREELEVEL, CREDITSPER, CLASSESPER, SHARETO, others).
  - `exceptionArray[*].type` (currently seen: FC, NN — expect RA, SI, SB,
  others).
  - Presence of `ifElsePart`, `classCreditOperator`, `connector: "+"`,
  `numberOfGroups` / `numberOfRules` ratios, `hideFromAdvice` at rule vs.
  courseArray entry level.
  - CourseArray option shapes: concrete, subject wildcard (`CS 4@`),
  attribute-only wildcard (`@ @ with ATTRIBUTE=xxx`), level-range wildcard
  patterns we haven't seen yet.
- Emits `docs/plans/rule-shape-inventory.md` as a set of tables:
*"across N audits, ruleType X appeared in M audits / K occurrences; the
current parser handles Y% of its sub-forms; Z% fall through to
`status` fallback."*
- Explicitly flags every shape whose only handling is the `default` branch
in `convertRule` or `inferBlockType` — that's the direct to-do list for
S5.

**Gate for S5:** inventory lands + review pass. Do not extend the parser
until this exists; otherwise we iterate on speculation.

### S5 — Model update, curated fixtures, regression baseline

With the inventory in hand:

1. **Curate fixtures.** Select ~20 audits from the what-if dump that
  collectively exercise every shape in the inventory. Commit those as
   named fixtures: `tests/fixtures/audits/whatif/audit-{degree}-{major}-{conc}-{catalogYear}.json`.
   Bulk dump remains gitignored. Rule of thumb: every ruleType, every
   qualifier code, and every exceptionArray type needs at least one
   committed example. Plus one double-major and one dual-degree fixture.
2. **Extend the data model.** For each new shape: add handler to existing
  node types (`CourseQuantifiedNode`, `ChooseNGroupsNode`, `AllOfNode`,
   `BlocktypeRefNode`, `StatusNode`) or introduce a new node kind. Known
   candidates at time of writing:
  - `BLOCK_TYPE.CONC` (from Lily's audit).
  - Proper `IfStmtNode` / `IfPartNode` / `ElsePartNode` triad; stop
  silently dropping ElsePart children (current behavior in
  `txstFromAudit.js:222-236`).
  - Likely `BLOCK_TYPE.CERT` (teacher certification overlay) — confirm via
  inventory.
3. **Update `docs/plans/requirement-graph.md`** with every new shape. Close
  open design questions that the inventory resolves.
4. **Regenerate baseline.** Run `scripts/generate-phase1-baseline.js`
  against the curated fixtures; commit the new snapshot alongside.
5. **Unit tests.** Add one fixture-driven assertion per shape class in
  `tests/unit/requirements.test.js`.

### S6 — Ongoing real-audit backfill

What-If structurally cannot produce:

- Advisor exceptions (`exceptionArray` with `type: "FC" / "NN" / "RA" / "SI"`) — requires a real advisor action on a real student record.
- `IfStmt` ElsePart branches activated by transfer credit, AP/CLEP, test
credit, or waivers — what-if simulates a fresh student with none of
those.
- Honors College overlays (requires Honors admission state).
- Mid-program catalog-year switches.

These gaps close via real audits from friends. Prioritize:

1. Transfer students (for IfStmt ElsePart coverage).
2. Teacher-certification students (for cert overlay shape).
3. Honors College students.
4. Students with documented advisor waivers.

Each real audit gets diffed against the inventory; if it adds a new
shape, back through S4 → S5 for that shape.

---

## 5. Coverage gaps this plan *doesn't* close

Being honest so we don't claim "done":


| Gap                                                                            | Why what-if misses it                                                  | Mitigation                                                                   |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Advisor exceptions                                                             | Speculative; no real advisor action                                    | S6 real-audit backfill                                                       |
| `ifElsePart` ElsePart activations tied to transfer/test credit                 | What-if = fresh student                                                | S6 (transfer students specifically)                                          |
| Honors overlay block                                                           | Honors admission state isn't a what-if toggle                          | S6 (one Honors audit)                                                        |
| Mid-program catalog-year switches                                              | What-If uses current catalog year at request time                      | Accept; rare edge case                                                       |
| Programs added after our scrape                                                | Obvious                                                                | Re-scrape S1 once per semester                                               |
| **Historical semester-offering data** (which courses run only Fall vs. Spring) | Entirely separate — a Banner term-search problem, not an audit problem | Deferred; filed as future work under the multi-semester planner (Phase 4a+). |


---

## 6. Open design questions for the S2 DevTools session

These are the questions we must answer before writing the S3 driver:

1. Is the "invalid combo" signal (*"I picked AGED concentration for a
  Marketing major and got no CONC block"*) an explicit field, a warning
   message, or just a structural absence? Answer determines S3's
   post-check.
2. What catalog-year range does what-if accept? Expected: current + three
  prior. If it's tighter, S1 narrows.
3. Does the browser session cookie work cleanly from Node `fetch`, or
  does DW require a CSRF token / `Origin` / `Referer` header pairing?
4. Does what-if support dual-degree (two Degree dropdowns) without
  erroring? Aidan's screenshot suggests yes but we need confirmation
   with a real POST.
5. When what-if is invoked with `Use current curriculum` unchecked, does
  it still apply completed-course history to the what-if structure, or
   does it simulate a fresh student? The shape dump is cleaner if it
   simulates fresh (fewer `classesAppliedToRule` entries to filter out).
6. Does DW echo the request parameters back in the response body (for
  deterministic filename matching)?

---

## 7. Not in scope for this RFC

- The Phase 1.5 solver redesign. That lives in
`docs/plans/requirement-graph.md` + SCRUM-35 and consumes this work's
output.
- UX surfacing of many-to-many rule satisfaction (D9).
- Any LLM prompt changes.
- Any changes to the live `background.js` → `scheduleGenerator` path. This
is all offline tooling in `scripts/` + fixture curation + pure
`requirements/`* updates.
- Authoring an Ellucian / TXST-IT access proposal. Real but later.

---

## 8. Jira mapping

One Epic and six child tasks. Epic lives on the current sprint for board
visibility; only the first child (plan doc) is scoped to the current
sprint, others sit in the backlog under the epic and get pulled forward
as prior gates clear.


| Jira task                                            | Phase  | Deliverable                                                                                                                     | Gate                                       |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| T1 — Write plan doc + index                          | —      | This file + README index row.                                                                                                   | ✅ closes with the commit adding this file. |
| T2 — Catalog scraper                                 | **S1** | `scripts/catalog/scrape-majors.js` + `degree-combinations.json`.                                                                | ✅ Script written; run to generate manifest. DW code mapping (dwMajorCode) deferred to map-dw-codes.js (see README). |
| T3 — DevTools reverse-engineer DW What-If            | **S2** | `docs/plans/whatif-endpoint.md`.                                                                                                | ✅ Completed from HAR sessions captured 2026-04-24. Two open items remain: invalid-combo signal test, true dual-degree shape. See §6 S3 checklist. |
| T4 — What-If audit driver                            | **S3** | `scripts/whatif/pull-audits.js` + run log + gitignored dump.                                                                    | ✅ Script written. Requires `~/.bobcatplus-dw-cookie` + manifest from S1. |
| T5 — Shape-extraction script + inventory             | **S4** | `scripts/shape/extract-shapes.js` + `docs/plans/rule-shape-inventory.md`.                                                       | Gated on T4.                               |
| T6 — Data-model update + curated fixtures + baseline | **S5** | Extensions to `extension/requirements/`*, ~20 committed fixtures, regenerated Phase 1 baseline, updated `requirement-graph.md`. | Gated on T5.                               |


Phase S6 ongoing real-audit backfill is tracked on SCRUM-35's existing
"audit-fixture collection" subtask; no new ticket.

---

## 9. Concrete next steps, in order

1. **Commit this plan.** ✅ Done.
2. **Open Jira epic + child tasks** per §8. ✅ Done.
3. **T3 complete** — `docs/plans/whatif-endpoint.md` written from HAR sessions
  captured 2026-04-24. Two items still open (invalid-combo signal, true
  dual-degree). See `whatif-endpoint.md` §6 S3 checklist.
4. **T2 complete** — `scripts/catalog/scrape-majors.js` written.
  Run `node scripts/catalog/scrape-majors.js` to generate the manifest,
  then `node scripts/catalog/map-dw-codes.js` (to be written) to populate
  DW Banner codes.
5. **T4 complete** — `scripts/whatif/pull-audits.js` written.
  Populate `~/.bobcatplus-dw-cookie`, run S1 + `map-dw-codes.js`, then
  `node scripts/whatif/pull-audits.js --dry-run --limit=5` to smoke-test.
6. **Next: T5** — write `scripts/shape/extract-shapes.js`.  Gate: S3 dump
  present (at least one catalog year).  See §4 S4.

