# RFC — RequirementGraph (Phase 1 design, TXST only)

Status: **Draft, no code yet.** Reviewer: . Supersedes the flat `needed[]` contract
between `background.js` and `scheduleGenerator.js`.

Scope: **Texas State University** DegreeWorks audits only. No adapter interface,
no second-school abstractions. The day we onboard university #2, we extract. Not before.

Grounded in fixture: `tests/fixtures/audits/audit-english-ba.json` (Greer, BA English
CW + minor in Popular Culture). A CS BS audit will extend but not contradict the types
below; if it does, the design needs to revise, not the other way around.

---

## Why a graph, not a flat list

The current flat `needed[]` contract loses two kinds of structural information that the
solver and LLM both need:

1. **Sibling exclusivity.** Modern Language Requirement is a `Group` with
  `advice.numberGroupsNeeded: 1` over 12 children (Arabic, Chinese, Spanish, …). The
   student must **pick one language and take all four courses in it** — not cherry-pick
   one course from each. The flat list flattens the Group away and emits 40+ independent
   "needed" entries, so the solver (correctly, given what it sees) mixes languages. This
   is Bug 2.
2. **Quantified subsets and wildcards.** Rules like `classesBegin: 4` over a
  `courseArray` of 4 courses are "take all four of these". Rules like `creditsBegin: 15`
   over 40 courses are "take 15 credits worth from this list". Rules like
   `{discipline: "BIO", number: "@"}` are "any course in BIO". None of these reduce
   cleanly to a flat list of required courses.

The audit file already encodes all of this. We are designing the minimal normalized
shape that preserves it.

---

## Observed DegreeWorks rule shapes in the fixture

Counts from `audit-english-ba.json`:


| `ruleType`                | Count   | Role in graph                                                                     |
| ------------------------- | ------- | --------------------------------------------------------------------------------- |
| `Block`                   | 7       | Top-level section (Degree, Core, Major, Minor, …). Acts like AllOf over children. |
| `Blocktype`               | few     | Cross-reference to another block. Resolves to its target.                         |
| `Subset`                  | 3       | AllOf over children. Each child has its own quantifier.                           |
| `Group`                   | N       | ChooseN over children. `advice.numberGroupsNeeded` is N.                          |
| `Course`                  | many    | Leaf quantified requirement: "take N from this courseArray".                      |
| `Complete` / `Incomplete` | several | Status markers; not graph structure.                                              |


Other observed non-rule-typed fields that carry semantics:

- `requirement.classesBegin`, `creditsBegin`, `creditsEnd` — quantifier for a Course leaf.
- `requirement.courseArray[]` — options under a Course leaf. Entries may be concrete
(`{discipline: "ENG", number: "3348"}`), subject wildcards
(`{discipline: "BIO", number: "@"}`), or universal wildcards with attribute filters
(`{discipline: "@", number: "@", withArray: [...]}`).
- `requirement.except.courseArray[]` — exclusions applied to the parent courseArray.
- `classesAppliedToRule.classArray[]` — courses already applied (completed or IP).
Drives "what's left".
- `advice.classes`, `advice.courseArray`, `advice.numberGroupsNeeded` — **recommendations**
from DegreeWorks about what's still needed, in a friendlier form. Useful for UX, not
authoritative for satisfaction.
- `withArray[]` — per-course-option constraints (e.g. `DWTITLE =  INTRO CREATIVE WRITING`,
`ATTRIBUTE = 020`).
- `exceptionArray[]` — advisor-granted exceptions (substitutions/waivers). Must be
honored.
- `hideFromAdvice` — "don't feature in UI", **not** "invalid". Currently mis-filtered.
- `percentComplete` — derived; useful for prioritizing "nearly-done" paths.
- `ifElsePart: "IfPart" | "ElsePart"` — conditional branches. Seen rarely in this audit;
keep an eye out.

---

## Proposed node types

```ts
type RequirementGraph = {
  roots: RequirementNode[];     // one per Block (Degree, Core, Major, Minor, …)
  courseIndex: Map<CourseKey, RequirementNode[]>;  // for many-to-many lookups
  exceptions: ExceptionRecord[]; // advisor substitutions, global
  meta: AuditMeta;              // student id, catalog year, snapshot time
};

type RequirementNode =
  | BlockNode
  | AllOfNode
  | ChooseNGroupsNode
  | CourseQuantifiedNode
  | CourseSlotNode
  | BlocktypeRefNode
  | StatusNode;

interface NodeBase {
  id: string;                   // DW nodeId / ruleId, stable
  label: string;
  labelTag?: string;
  percentComplete?: number;
  hideFromUi?: boolean;         // from hideFromAdvice at the rule level
  exceptions?: ExceptionRecord[];
}

interface BlockNode extends NodeBase {
  kind: "block";
  blockType: "DEGREE" | "MAJOR" | "MINOR" | "CORE" | "OTHER";
  children: RequirementNode[];  // semantics: AllOf
}

interface AllOfNode extends NodeBase {  // from ruleType: "Subset"
  kind: "allOf";
  children: RequirementNode[];
}

interface ChooseNGroupsNode extends NodeBase {  // from ruleType: "Group"
  kind: "chooseN";
  n: number;                    // advice.numberGroupsNeeded
  children: RequirementNode[];
}

interface CourseQuantifiedNode extends NodeBase {  // from ruleType: "Course"
  kind: "courseQuant";
  take: { classes?: number; credits?: { min: number; max?: number } };
  options: CourseOption[];      // from requirement.courseArray
  exceptCourses: CourseRef[];   // from requirement.except.courseArray, flattened
  applied: AppliedCourse[];     // classesAppliedToRule
  remaining: { classes?: number; credits?: number };  // derived
}

interface CourseSlotNode extends NodeBase {   // degenerate case: a single specific course
  kind: "courseSlot";
  course: CourseRef;
}

type CourseOption =
  | { kind: "concrete"; course: CourseRef; with?: WithClause[]; hideFromUi?: boolean }
  | { kind: "subjectWildcard"; discipline: string; with?: WithClause[] }   // e.g. BIO @
  | { kind: "attributeWildcard"; with: WithClause[] };                     // e.g. @ @ with ATTRIBUTE=020

interface CourseRef { discipline: string; number: string; }
interface WithClause { code: string; operator: string; valueList: string[]; connector?: string; }

interface BlocktypeRefNode extends NodeBase {
  kind: "blocktypeRef";
  targetBlockId: string;
}

interface StatusNode extends NodeBase {  // Complete / Incomplete markers
  kind: "status";
  state: "complete" | "incomplete";
}

interface ExceptionRecord {
  type: string;                 // "RR", "RA", etc. from DW exception table
  id: string;
  substituteCourse?: CourseRef;
  originalCourse?: CourseRef;
  grantedBy?: string;
  grantedOn?: string;
}

type AppliedCourse = {
  course: CourseRef;
  credits: number;
  grade: string;                // letter grade, "IP", etc.
  term: string;
};

type CourseKey = `${string}|${string}`;  // e.g. "ENG|3329"
```

### DegreeWorks → graph mapping rules


| DW construct                                | Graph node                | Notes                                                                                                                                        |
| ------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `blockArray[i]` (top level)                 | `BlockNode`               | `blockType` from `requirementType` + `requirementValue`.                                                                                     |
| `ruleType: "Blocktype"`                     | `BlocktypeRefNode`        | Resolve to the referenced block during traversal.                                                                                            |
| `ruleType: "Subset"`                        | `AllOfNode`               | `requirement` is often `{}`; each child carries its own quantifier.                                                                          |
| `ruleType: "Group"`                         | `ChooseNGroupsNode`       | `n = advice.numberGroupsNeeded`. Validate that `advice.numberGroupsNeeded` is present; fall back to `requirement.numberOfGroups` if missing. |
| `ruleType: "Course"` with N>0 options       | `CourseQuantifiedNode`    | `take.classes = classesBegin` if present; `take.credits = {min: creditsBegin, max: creditsEnd}` if present.                                  |
| `ruleType: "Course"` with 1 concrete option | could be `CourseSlotNode` | Optimization only; equivalent to CourseQuantifiedNode with take=1.                                                                           |
| `ruleType: "Complete"/"Incomplete"`         | `StatusNode`              | Mostly informational; can be skipped during solving.                                                                                         |


### Handling `hideFromAdvice`

- **At the rule level** (`rule.hideFromAdvice`): set `hideFromUi: true`; still include in
the graph; solver ignores the flag.
- **At the courseArray-entry level** (`courseArray[i].hideFromAdvice`): set
`hideFromUi: true` on the `CourseOption`; solver still considers it valid.

Never drop solely because of `hideFromAdvice`. This is the partial fix for Bug 4.

### Handling `except`

Stored on `CourseQuantifiedNode.exceptCourses`. During candidate expansion (Phase 1.5,
see below), any course matching an entry (by exact `discipline + number`) is removed
from the candidate set for **that node only**.

### Handling `exceptionArray`

`exceptionArray[]` at a rule level means the advisor substituted something. The
substitute course should be treated as already applied to that rule. Preserved on the
`NodeBase.exceptions` list; the adapter applies the substitution when computing
`applied` and `remaining`.

### Handling wildcards (resolution strategy)

Resolution happens *lazily* at solve time, not at parse time. The adapter records the
wildcard option verbatim; the **section-index builder** (see below) expands each
wildcard into its concrete candidate set by querying Banner.

- `subjectWildcard`: call `searchSubject(subject, term)` (paginated, cached per term).
Filter out `except` courses for the node that owns the wildcard.
- `attributeWildcard`: **not resolvable from current Banner endpoint** (evidence: Banner
dumps contain zero attribute strings). Handled via the concrete fallback courses
listed alongside (the `hideFromAdvice: "Yes"` entries Layer A now preserves). Flag the
unresolved wildcard so the UI can indicate "catalog-level attribute match — verify
with advisor".

### Many-to-many indexing

`courseIndex` is built once per graph. For every leaf `CourseQuantifiedNode`, every
option it contains (after wildcard expansion at query time) maps back to the node.
Queries like "which rules does ENG 3329 satisfy?" become O(1).

---

## Contract between `background.js` and `scheduleGenerator.js`

Replace today's flat `needed[]` with:

```ts
rawData = {
  graph: RequirementGraph,
  sectionIndex: Map<CourseKey, BannerSection[]>,  // from Banner, open-only or all
  studentProfile: { ... unchanged ... },
};
```

`scheduleGenerator.js / compressForSolver` consumes both. The existing `eligible[]`
shape becomes a *derived* view over `graph + sectionIndex`, preserved for now as a
compatibility layer so the solver does not need to change in the same PR.

Phase 1.5 (a follow-up, not this phase): teach the solver to reason about the graph
directly so it enforces ChooseN and AllOf constraints natively. Until then, we emit
derived `{course, requirementLabel, sections}` triples but tag each with its owning node
ID and exclusivity group (if any), so the solver at minimum knows "only one of these
sibling courses at a time".

---

## Open design questions

1. **Group semantics edge case.** The "Content Requirements" block
  (`audit-english-ba.json:5329`) is a Group with `numberOfGroups: 3` and
   `numberGroupsNeeded: 1`. Three children, all "in-progress", and the student's
   percentComplete is 82. Is `numberGroupsNeeded` "at least" or "exactly"? Proposed
   reading: "at least 1 group must be fully complete; additional complete groups don't
   hurt". Validate against more real audits (need the CS BS one).
2. `**classCreditOperator: "OR" | "AND"`** on Course leaves. When both `classesBegin`
  and `creditsBegin` are present, does "OR" mean either threshold satisfies? Working
   assumption: yes, OR → min(classes, credits-equivalent) counts. Confirm via the
   CS BS audit where engineering-style credit-hour rules are common.
3. `**ifElsePart: "IfPart" | "ElsePart"*`* — conditional rule branches. Rare in this
  audit. Likely tied to transfer credit / test credit / catalog-year switches. Need a
   second audit to see a real example before designing.
4. **Attribute resolution without catalog attributes.** If the concrete fallback courses
  listed under `@@ with ATTRIBUTE=xxx` prove insufficient in testing, we need a Banner
   endpoint that surfaces section attributes. Investigation task, not blocking Phase 1.
5. **What happens when a concrete course is offered in *both* a major Core node and a
  minor elective node?** Under many-to-many, we treat it as satisfying both
   simultaneously (subject to DW `NONEXCLUSIVE` qualifier). Some rules have an
   `EXCLUSIVE` qualifier (`DontShare`) — the BA Science Requirement has one. Need to
   honor these in the solver: a course used under an exclusive node can't double-count
   elsewhere.
   **2026-04-21 — product decision (see `docs/decisions.md` D9).** Many-to-many
   is not just a solver mechanic; we surface it to students. When a course
   satisfies multiple `NONEXCLUSIVE` rules, the schedule UI and the AI rationale
   explicitly call it out (e.g. *"ENG 4358 Shakespeare covers British Lit,
   Early Lit, AND Single Author — one course, three boxes"*). When the student
   asks to swap it, the AI explains the downstream impact on remaining
   credits/requirements. This turns the graph's `courseIndex` from a purely
   internal structure into a first-class UX primitive.
   Implementation implication: the graph-native solver (Phase 1.5) must return
   per-schedule a `satisfactionTable: { courseKey -> ruleId[] }` that the
   rationale prompt can consume. `EXCLUSIVE` rules produce entries of length
   1; `NONEXCLUSIVE` rules can appear in multiple course entries. Phase 3
   ranking can then reward schedules whose `satisfactionTable` has high
   multi-count density as a soft objective ("prefer courses that knock out
   multiple boxes at once").
6. **Credit counting across wildcard expansions.** If the BA Science Requirement can be
  satisfied by BIO 1330 (3 cr) or BIO 1430 (4 cr) with `creditsBegin: 3, creditsEnd: 4`,
   the solver needs to honor both the count and the credit ceiling per rule. Design is
   straightforward but testable edge case.

---

## Not in scope for this RFC

- The CSP solver rewrite to operate on the graph natively. That's Phase 1.5 and will
get its own RFC when we have a working parser + derived compatibility layer.
- UX changes that surface rule-satisfaction ("this course satisfies X AND Y"). Phase 3
or later; enabled by the many-to-many index but not required by it.
- Scoring and ranking changes (Phase 2+).
- Any LLM prompt changes. The intent/affinity/rationale prompts continue to consume
the derived `eligible[]` view; they don't need to know about the graph yet.

---

## Concrete next steps, in order

1. Review this RFC. Push back on types or mappings that feel wrong against your
  mental model of TXST audits.
2. Grab the CS BS audit JSON. Spot-check every new rule shape it introduces against
  this RFC. If anything is absent, add a typed variant.
3. Get explicit sign-off that Phase 1 ships as **parser + contract change only**, with
  the solver continuing to consume a flat `eligible[]` derived from the graph. Solver
   native-graph consumption is Phase 1.5.
4. Only then: build `extension/requirements/graph.js` + `extension/requirements/txstFromAudit.js`,
  plus parser unit tests running against the audit fixtures.

---

## 2026-04-21 Update — CS BS audit + `cs-4@.json` wildcard fixture

User dropped three new fixtures: the correct CS BS audit
(`tests/fixtures/audits/audit-computerscience-bs-minor-music.json`), the English Fall 2026
Banner dump (`tests/fixtures/banner/english-fall2026.json`), and the `4@` wildcard
response from DegreeWorks (`tests/fixtures/wildcard/cs-4@.json`). Findings relevant to
the RFC:

### Group semantics — resolved

Open question 1 ("Is `advice.numberGroupsNeeded` at-least or exactly?") is replaced by
a cleaner contract: **the authoritative source is `requirement.numberOfGroups` on the
Group rule itself**, not `advice.`*. Observed across both audits:


| Block → Group                             | `numberOfGroups` | `numberOfRules` | Meaning                             |
| ----------------------------------------- | ---------------- | --------------- | ----------------------------------- |
| CS major → Mathematics Requirement        | 5                | 5               | AllOf (all 5 children required)     |
| CS major → English Requirement            | 1                | 2               | Choose 1 of 2 (ENG 3303 or equiv.)  |
| CS major → Prerequisites for CS 2315      | 3                | 3               | AllOf                               |
| CS major → BS Natural Science Requirement | 2                | 2               | AllOf                               |
| English BA → Modern Language Requirement  | **1**            | **12**          | **Choose 1 of 12** — this is Bug 2  |
| English CW → English Group Requirements   | 4                | 4               | AllOf (Groups A/B/C/D all required) |


Rule for the parser: `n = parseInt(requirement.numberOfGroups, 10)`. If
`n === numberOfRules`, the node is effectively `AllOfNode`; otherwise it's
`ChooseNGroupsNode`. `advice.numberGroupsNeeded` is only a UI hint and is not read.

This changes two things in the RFC:

- Drop the `advice.numberGroupsNeeded`-as-primary rule from the mapping table (line 178).
- `AllOfNode` is no longer only derived from `Subset` — it's also the degenerate form of
`Group` when `numberOfGroups === numberOfRules`. Collapse at parse time for simplicity.

### `CourseQuantifiedNode.take` — credits vs classes

Evidence from CS:

- `Course` rule with `classesBegin: "1"` and no `creditsBegin` → "take 1 class". Most
of the major core.
- `Course` rule with `creditsBegin: "12"` and no `classesBegin` → "take 12 credits".
The CS Advanced Electives rule (L3 above).
- `Course` rule with `classesBegin: "4"` → "take 4 classes from this list (in the order
the list is in, per `connector: "+"`)". Every language-track rule under Modern
Language.
- `Course` rule with `creditsBegin: "8"` + `classCreditOperator: "OR"` → "take 8
credits OR equivalent". The BS Natural Science lab pair rules (e.g.
`CHEM1341, CHEM1141, CHEM1342, CHEM1142`).

The `{classes?, credits?{min,max}}` shape in `CourseQuantifiedNode.take` is correct.
Add a field `mode: "classes" | "credits" | "both"` so downstream can tell which
threshold applies without type-guarding. Also record `classCreditOperator` verbatim so
Phase 1.5 can honor AND vs OR if both are present.

### `connector: "+"` and ordered sequences

Each Modern Language child has `requirement.connector: "+"` on its Course rule. DW uses
`+` to mean "take in listed order" — ASL 1410 before ASL 1420, etc. This is important
for language prereq chains. Add `ordered: boolean` on `CourseQuantifiedNode` sourced
from `connector === "+"` when there's a meaningful sequence. Phase 1.5 solver uses it to
enforce prereq order inside the node; Phase 1 simply records it.

### Wildcard resolution — DegreeWorks beats Banner

`cs-4@.json` shows the `courseInformation` endpoint returning, for `CS 4@`:

```json
{
  "courseInformation": {
    "courses": [
      {
        "subjectCode": "CS",
        "courseNumber": "4100",
        "title": "COMPUTER SCIENCE INTERNSHIP",
        "creditHourLow": "1",
        "attributes": [{"code": "DTSC", "description": "..."}],
        "prerequisites": [...],
        "sections": [ ... full Banner-shape section records ... ]
      },
      ... 31 courses total for CS 4@ ...
    ]
  }
}
```

This is categorically better than Banner's subject search for wildcard expansion:

1. **Attribute strings are present** (`DTSC`, `3PEX`, `TOPC`, `WRIT`). Banner's
  `searchResults` endpoint does not surface these. That means Layer D
   ("attribute-based wildcards", the `@ @ with ATTRIBUTE=xxx` case) becomes viable
   through this endpoint instead of needing per-section attribute lookups.
2. **Sections are already attached.** No second Banner call per course. We get
  `sections: [{termCode, termLiteral, courseReferenceNumber, campusCode, ...}]`
   inline, with all the fields `scheduleGenerator.js` needs today.
3. **The filter is already scoped** (`CS 4@` returns just 4000-level CS, not all CS).
  No client-side regex filter needed.

Implication for the RFC:

- Rename the "section-index builder" from "Banner-based" to "DegreeWorks-preferred,
Banner-fallback". Concretely:
  ```
  resolveWildcard(option, term):
    1. If option is {discipline: X, number: "@"}:
         call DW courseInformation(X, "@", term) → map to CourseOption[]
    2. If option is {discipline: "@", number: "@", withArray: [ATTRIBUTE=nnn]}:
         call DW courseInformation("@", "@", term, {attribute: nnn}) → map to CourseOption[]
         fallback to concrete sibling entries (hideFromAdvice=Yes) if DW rejects
    3. If option is {discipline: X, number: "3358"} (concrete):
         no wildcard resolution needed; lookup sections via existing Banner cache
  ```
- This collapses Layer D1/D2 from the Bug 4 diagnosis into a single path, and likely
collapses Layer B into it too. Bug 4 gets simpler, not more complex.

### `exceptCourses` — confirmed with wildcards

CS Advanced Electives uses `except.courseArray` to exclude the CS core upper-division
courses that are already counted elsewhere (CS 3354/3358/3339/3360/3398/4371) plus a
whole `CS 2@` subject-level wildcard. The exception itself can contain wildcards. The
RFC needs to generalize `exceptCourses` from `CourseRef[]` to `CourseOption[]` so it
supports the `CS 2@` case:

```ts
interface CourseQuantifiedNode extends NodeBase {
  kind: "courseQuant";
  take: { classes?: number; credits?: { min: number; max?: number } };
  mode: "classes" | "credits" | "both";
  ordered?: boolean;
  options: CourseOption[];
  exceptOptions: CourseOption[];   // <-- was exceptCourses: CourseRef[]
  applied: AppliedCourse[];
  remaining: { classes?: number; credits?: number };
}
```

Wildcard-vs-wildcard exception match is resolved at candidate-expansion time:
`{discipline: "CS", number: "2@"}` in `exceptOptions` removes every `CS 2xxx`-numbered
course from the expanded candidate set.

### `qualifierArray` — acknowledge, don't model yet

Every Group and most Course rules carry `qualifierArray` entries like `MINGRADE 2.0`,
`NOTGPA`, `NONEXCLUSIVE`, `EXCLUSIVE` (aka `DontShare`). Phase 1 records the raw array
on the node (`NodeBase.qualifiers?: Qualifier[]`) without modeling semantics. The
exclusive/nonexclusive distinction is Phase 1.5's job when the solver learns
many-to-many accounting. `MINGRADE` / `NOTGPA` are Phase 2+ (scorer) concerns.

### Updated "Concrete next steps"

Prior sign-off gating still applies, but with fewer blockers now that the fixtures have
resolved the open semantic questions:

1. (Done) Pull correct CS BS audit; verify Group semantics via `numberOfGroups`. ✅
2. Explicit sign-off from reviewer that the parser ships as an **additive module**
  (`extension/requirements/`) that produces the graph + a derived `eligible[]`
   compatibility view, with *no runtime wiring change* in this commit. Solver continues
   to consume `eligible[]` unchanged.
3. Build `extension/requirements/graph.js` (types + invariants) and
  `extension/requirements/txstFromAudit.js` (DW → graph transform).
4. Fixture-driven unit tests in `tests/unit/requirements.test.js` asserting:
  - English BA → Modern Language Group has `n=1, children=12`.
  - CS BS → Mathematics Group collapses to `AllOfNode` (since `numberOfGroups=5=numberOfRules=5`).
  - CS Advanced Electives → `CourseQuantifiedNode` with `take.credits.min=12`,
  `options=[CS3@, CS4@]` wildcards, `exceptOptions=[CS2@, CS3354, CS3358, ...]`.
  - `hideFromAdvice` courses are preserved on `CourseOption.hideFromUi=true` but still
  included as valid options.
5. Wire-in (separate commit, gated on all tests green):
  - `background.js` returns `{graph, sectionIndex, studentProfile}` instead of only
   `{needed, completed, inProgress}`.
  - A `deriveEligible(graph, sectionIndex)` function produces the legacy flat shape.
  - `scheduleGenerator.js` receives both; `compressForSolver` prefers
  `rawData.eligible` if present, else derives it. This keeps the solver change to
  Phase 1.5.

