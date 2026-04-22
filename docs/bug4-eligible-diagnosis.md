# Bug 4 — Eligible Courses Diagnosis

Status: **root cause confirmed**, fix not yet applied.

Fixtures used:
- `tests/fixtures/audits/audit-english-ba.json` (Greer, English-CW BA, Spring 2026 catalog)
- `tests/fixtures/banner/{cs,math,music}-fall2026.json` (subject-wide section dumps)
- Screenshot of live CS BS eligible list for student "george demo" / Aidan (10 courses surfaced)

Not yet available: CS BS audit JSON. Hypotheses below are qualified accordingly.

---

## Symptom

The extension surfaces far fewer eligible courses than a reasonable student actually has
available for the term. The live CS screenshot shows **10 eligible courses** (MATH 3305,
BIO 1130/1131/1330/1331, CS 4371/4380/4398, GEOL 1410, CHEM 1341). Banner's Fall 2026
offerings alone include 180 CS sections, 436 MATH, and 279 Music — and the CS student's
audit will have many requirements that should map to courses in those subjects.

## Root cause 1: wildcards are silently dropped

`extension/background.js:952–953`:

```js
if (course.discipline === "@" || course.number === "@") continue;
if (course.hideFromAdvice === "Yes") continue;
```

DegreeWorks encodes large swaths of the degree plan with `@` wildcards:

- **`{discipline: "X", number: "@"}`** — any course in subject X. Used for science/elective
  requirements and subject-scoped advanced work (e.g. `CS 4@` for "any 4000-level CS").
- **`{discipline: "@", number: "@", withArray: [...]}`** — any course matching a
  Banner attribute filter. Used heavily for core curriculum (Math core = attribute `020`,
  etc.).

Concrete audit evidence — **BA Science Requirement** (`audit-english-ba.json` L3791–L3852):

```json
"requirement": {
  "creditsBegin": "3",
  "creditsEnd":   "4",
  "classesBegin": "1",
  "courseArray": [
    {"discipline": "ANTH", "number": "2301"},
    {"discipline": "BIO",  "number": "@"},
    {"discipline": "CHEM", "number": "@"},
    {"discipline": "CS",   "number": "@"},
    {"discipline": "GEO",  "number": "2301"},
    {"discipline": "GEOL", "number": "@"},
    {"discipline": "MATH", "number": "@"},
    {"discipline": "PHIL", "number": "2330"},
    {"discipline": "PHYS", "number": "@"}
  ],
  "except": { "courseArray": [
    {"discipline": "MATH", "number": "1300"},
    {"discipline": "MATH", "number": "1311"}
  ]}
}
```

Human reading: "take 1 class, 3–4 credits, from **any BIO / CHEM / CS / GEOL / MATH /
PHYS** plus 3 specific courses, **except** MATH 1300 and 1311."

Our parser reading (post-wildcard-drop): "take from `{ANTH 2301, GEO 2301, PHIL 2330}`."
We lose every wildcard-sourced course — on a single term, hundreds of candidates.

Second concrete case — **Mathematics (Core Code 020)** (L1091–L1159), primary option is
`{discipline: "@", number: "@", withArray: [{code: "ATTRIBUTE", value: "020"}]}` followed
by concrete `hideFromAdvice: "Yes"` fallbacks (MATH 1312 / 1315 / 1316). Our parser drops
both: the wildcard for being `@`, and the fallbacks for being `hideFromAdvice: "Yes"`.
Result: the Math core requirement surfaces **zero** actionable options from this rule.

## Root cause 2: `except` clauses are never processed

The parser does not read `requirement.except.courseArray`. When we later do add wildcard
expansion, we must exclude these courses; otherwise we'd propose MATH 1300 for a
requirement that literally says "not MATH 1300".

## Root cause 3: many-to-many course→rule mapping collapses

`extension/background.js:962–971`:

```js
const already = needed.some(
  (n) => n.subject === course.discipline && n.courseNumber === course.number,
);
if (!done && !ip && !already) {
  needed.push({ subject, courseNumber, label: rule.label });
}
```

A course is recorded **once**, tagged with the **first** `rule.label` encountered during
DFS. Real audits have courses that legitimately satisfy multiple rules simultaneously
(e.g. ENG 3329 fulfills a major literature elective AND a minor elective). Current
surface: the course shows up with only one label, and downstream ranking/UX never knows
it could solve more than one requirement. Not a blocker for eligibility, but it degrades
every downstream decision.

## Root cause 4: `hideFromAdvice: "Yes"` filter is too aggressive

The filter was presumably added to avoid cluttering the UI with "already-applied" or
advisor-note entries. But DegreeWorks also uses it to mark **valid concrete fallbacks**
under a wildcard rule. In the Math core example above, the only surviving entries under
the `@@ with ATTRIBUTE=020` pattern would have been the `hideFromAdvice: "Yes"` concrete
courses — exactly what the student actually registers for.

Recommendation: keep the `hideFromAdvice` drop only for top-level rule labels, not for
`courseArray` entries.

---

## Impact in numbers (estimated from the one audit we have)

English-CW student — rough projected eligibility delta **after fix**, on a typical Fall term:

| Requirement | Today surfaces | After wildcard/except fix | Delta |
|---|---|---|---|
| BA Science (1 of many) | 3 specific courses | ~50–80 across 6 subjects, minus `except` | +50-80 |
| Core Math (020) | 0 | ~10–15 attribute-020 Math courses | +10-15 |
| Core Language/Phil/Culture | 3 specific | ~25–40 attribute-040 | +25-40 |
| Core Social & Behavioral | ~6 specific | ~30 attribute-080 | +25 |
| All other wildcard-bearing rules | — | — | likely 50+ |

Order-of-magnitude, the eligible list for this student should grow from the current
~10–20 to **~150–250** candidate courses. The CS BS case is almost certainly worse
because CS major electives are typically `CS 3@ / CS 4@` wildcards.

---

## Fix strategy — layered, do the cheap wins first

### Layer A (required, small): stop dropping concrete `hideFromAdvice` courses in `courseArray`

Change the parser to only treat `hideFromAdvice: "Yes"` as a "don't advertise in UI"
flag, not as "exclude from eligibility". Courses are still added to `needed`, just with a
flag that the UI can respect if it wants.

Cost: ~5 LOC. Zero risk. Recovers all concrete fallback courses immediately.

### Layer B (required, medium): subject wildcard expansion

For every `{discipline: X, number: "@"}` entry, expand by calling Banner's subject search
with empty `txt_courseNumber`. The `searchCourse(X, "", term)` call already works —
evidence: the Banner dumps in `tests/fixtures/banner/` were produced that way and return
full subject lists (180 CS courses / 436 MATH / 279 MU).

Two sub-considerations:

1. **Pagination**: current `searchCourse` posts `pageMaxSize: 50`. 180+ sections per
   subject means we must loop until `totalCount` is exhausted. Add a `searchSubject(subject, term)`
   wrapper that paginates.
2. **Caching**: this produces much larger payloads than single-course searches. Cache
   key `subject|${term}|${subject}` with the same 1h TTL as `course|...`. Approx
   200 KB–2 MB per subject per term. Cheaper than per-course on repeated parser runs.

Cost: ~80–120 LOC in `background.js`. Low risk — the endpoint and session-lock pattern
are unchanged. Recovers all subject-wildcard courses.

### Layer C (required for correctness): `except` clause honored

When expanding a rule, subtract any course appearing in `requirement.except.courseArray`
(exact `discipline + number` match) from the expanded candidate set.

Cost: ~10 LOC. No risk. Prevents the parser from proposing courses that the audit
explicitly forbids.

### Layer D (deferred, bigger): attribute-based wildcard resolution (`@ @ with ATTRIBUTE=xxx`)

This is the Math core case. Banner's section search response **does not include
attribute metadata** (confirmed: `grep "ATTRIBUTE" tests/fixtures/banner/*.json` → 0 hits
for every dump). So we cannot resolve attribute wildcards from the existing endpoint.

Two pragmatic options:

- **D1 (cheap):** ignore pure-attribute wildcards; rely on the `hideFromAdvice: "Yes"`
  concrete sibling entries that DegreeWorks already lists alongside them (Layer A has
  recovered these). For most core rules, the audit already lists the commonly-taken
  concrete courses. Ship with this behavior; accept that exotic attribute matches are
  missed.
- **D2 (full):** add a second Banner fetch per section (or a bulk
  `classSearchResults`-style call) that returns attributes. Costly in requests. Only
  worth it if D1 proves inadequate in testing.

Recommendation: Layer D = D1 for the first milestone. Revisit D2 post-Phase 2 if we see
symptoms.

### Layer E (deferred, independent): many-to-many course → rule mapping

Preserve the full list of rules a course satisfies. Useful for:
- UX: show "this course satisfies X (major) AND Y (minor)"
- Solver ranking: prefer courses that knock out multiple rules
- Advisor summary: coherent reasoning about requirement overlap

Implementation: swap the `needed.some(... already ...)` dedupe for a
`Map<courseKey, {course, rules: Set<rule>}>`. Every downstream consumer treats a course
as the union of its rule memberships.

Cost: ~30 LOC in parser + adjustments in `scheduleGenerator.js` wherever
`requirementLabel` is read.

---

## Acceptance criteria for "Bug 4 fixed"

Write a pure parser-only test (no Banner, no LLM):

1. Feed `audits/audit-english-ba.json` through the new parser.
2. Assert every wildcard entry yields the correct placeholder (`{subject, wildcard: true,
   except: [...]}` or `{subject, attribute: "020"}`).
3. Feed the 3 Banner subject dumps as a mock `searchSubject` source.
4. Assert the resulting eligible pool contains ≥ 1 BIO, ≥ 1 CHEM, ≥ 1 PHYS course for
   the BA Science Requirement.
5. Assert MATH 1300 and MATH 1311 are **not** in the BA Science pool (`except` honored).
6. Assert every concrete `hideFromAdvice: "Yes"` course from the Math core rule is in the
   Math core pool.

None of this requires an OpenAI key. Wire into `tests/` and block merge on the suite.

---

## Open questions for the user

1. **Does the existing `searchCourse` handle `txt_courseNumber=""` correctly today?** The
   evidence from `tests/fixtures/banner/*.json` suggests yes (the dumps were produced by
   similar subject-wide searches). A one-off spot-check from a logged-in session would
   confirm.
2. **Is there a known Banner endpoint that returns course attributes?** If so, Layer D2
   becomes viable sooner. If not, D1 ships first and attributes wait.
3. **CS audit JSON** — still missing. Needed to verify CS 3@/4@ wildcard case as part of
   acceptance tests.

---

## 2026-04-21 Update — fixtures arrived, strategy simplifies

New fixtures landed:

- `tests/fixtures/audits/audit-computerscience-bs-minor-music.json` — the correct CS BS
  audit (the earlier file was a duplicate of English). Md5-verified distinct.
- `tests/fixtures/wildcard/cs-4@.json` — raw DegreeWorks `courseInformation` response
  when a user clicks the `4@` entry under CS Advanced Electives.
- `tests/fixtures/banner/english-fall2026.json` — subject-wide Banner dump for English
  Fall 2026 (1.6 MB).

Key shift: the `cs-4@.json` fixture reveals a DegreeWorks endpoint that changes the fix
architecture.

### The `courseInformation` endpoint subsumes Layers B and D

`cs-4@.json` top-level shape:

```json
{
  "courseInformation": {
    "courses": [
      {
        "subjectCode": "CS",
        "courseNumber": "4100",
        "title": "COMPUTER SCIENCE INTERNSHIP",
        "creditHourLow": "1",
        "creditHourHigh": "",
        "attributes": [{"code": "DTSC", "description": "Dif Tui- Science & Engineering"}],
        "prerequisites": [ ... ],
        "sections": [
          {
            "termCode": "202630",
            "termLiteral": "Spring 2026",
            "courseReferenceNumber": "31833",
            "sequenceNumber": "251",
            "scheduleCode": "ITS",
            "campusCode": "M",
            ...
          }
        ]
      },
      ... 30 more CS 4xxx courses ...
    ],
    "mappings": [],
    "lastWithoutAComma": {}
  }
}
```

Concretely: one call to DegreeWorks with the wildcard pattern returns **31 courses
scoped to the wildcard, each with attributes and Banner-shaped sections inline**. For
comparison, Banner's subject-wide search returns **180 CS sections** (not filtered to
the `4@` range) and **no attributes**.

What this changes:

- **Layer B becomes smaller.** Instead of building a subject-wide pagination loop in
  `background.js`, we hit `courseInformation(discipline, number, term)` per wildcard and
  get exactly the candidate set the audit was asking about. Lower latency, smaller
  payload, scoped filtering, and no client-side regex for "is this `4xxx`".
- **Layer D (attribute wildcards) is viable now.** The attributes we thought Banner
  couldn't give us are right there in the response. The `@ @ with ATTRIBUTE=020`
  pattern for Math core can likely be resolved by calling
  `courseInformation("@", "@", term)` with the attribute filter — still TBD exactly how
  DegreeWorks parametrizes that (the fixture only covers the `subject + number`-wildcard
  case), but the attribute data path exists. Worst case D1 remains the fallback.
- **Sections-in-response removes a second call path.** Today `background.js` calls
  Banner for each wildcard-expanded course; with `courseInformation` that's free. We'll
  still need Banner for user-entered concrete course searches, but the bulk-resolution
  case for audits moves off it.

### Revised fix strategy

| Layer | Scope | Status |
|---|---|---|
| A — stop dropping `hideFromAdvice` concrete courses | parser-only | unchanged from before; ship first |
| B — wildcard expansion via `courseInformation` | parser + one new `background.js` fetcher | **simpler than originally designed** |
| C — honor `except` clauses (including wildcard exceptions like `CS 2@`) | parser-only | expanded scope: `except` can contain wildcards (confirmed in CS fixture) |
| D — attribute wildcards | new fetcher variant | optional; investigate after B ships |
| E — many-to-many course→rule mapping | parser + downstream | unchanged, still deferred |

Layer C grew: the CS Advanced Electives `except` field includes `{discipline: "CS",
number: "2@"}`, i.e. an exception that is itself a wildcard. The subtraction step has to
expand both sides via `courseInformation` before diffing.

### Acceptance criteria — additions

In addition to the existing criteria (parser-level assertions on the English audit):

7. Feed `audit-computerscience-bs-minor-music.json` through the parser.
8. Assert the `CS Advanced Electives` node has:
   - `take.credits.min = 12`.
   - Two wildcard options: `CS 3@` and `CS 4@`.
   - `exceptOptions` containing `CS 2@`, `CS 3354`, `CS 3358`, `CS 3339`, `CS 3360`,
     `CS 3398`, `CS 4371` (wildcard + 6 concrete).
9. Resolve `CS 4@` via a mock of `courseInformation` that replays
   `tests/fixtures/wildcard/cs-4@.json`. Assert the expanded candidate set is 31
   courses before `except` subtraction, drops to 30 after removing `CS 4371`, and is
   further reduced by `CS 2@` expansion (no effect here since 2xxx is outside 4@'s
   range, but the subtraction must run cleanly).
10. Assert every returned course has a non-empty `attributes[]` and `sections[]`
    array on the hydrated candidate, so downstream code can rely on them without
    extra Banner calls.

### Action items unchanged

Layer A is still the first thing to ship (5 LOC). Sign-off on the layered plan as a
whole is still the remaining blocker before wiring parser changes into `background.js`.
The standalone parser module + its unit tests are safe to build now — they do not alter
runtime behavior.
