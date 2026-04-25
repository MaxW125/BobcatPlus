# DW What-If endpoint — reverse-engineering notes (T3 / SCRUM-51 / S2)

**Status:** ✅ *Complete.* HAR files captured 2026-04-24 in
`tests/fixtures/audits/what-if/` (three sessions). Answers all §6 design
questions except Q1 (invalid-combo signal) and the true dual-degree shape.

Gate for S3: the open items below are non-blocking — the driver can handle
structural-absence as the invalid-combo signal and skip dual-degree combos
until verified.

---

## 1. Endpoint map

All calls go to `https://dw-prod.ec.txstate.edu/responsiveDashboard/`.


| Method | Path                                              | Purpose                                                                                                                        |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `api/validations/special-entities/audit-formats`  | Available audit format keys (e.g. `WEB32`). Fetched once by the UI on mount; not needed by the driver.                         |
| `GET`  | `api/validations/special-entities/catalogYears`   | All term codes with `isVisibleInWhatif` flag.                                                                                  |
| `GET`  | `api/validations/special-entities/majors-whatif`  | All major codes (`key`, `description`) visible in What-If.                                                                     |
| `GET`  | `api/validations/special-entities/minors-whatif`  | All minor codes.                                                                                                               |
| `GET`  | `api/validations/special-entities/concentrations` | Concentration codes for a major (query param TBD; see §5 Q6).                                                                  |
| `POST` | `api/goals`                                       | UI-only validation step to cascade dropdowns. **Not required by the driver** — the audit POST carries all parameters directly. |
| `POST` | `api/audit`                                       | **The shape-dump call.** Returns the full blockArray JSON.                                                                     |


---

## 2. Audit POST — full spec

### 2.1 URL

```
POST https://dw-prod.ec.txstate.edu/responsiveDashboard/api/audit
```

### 2.2 Required headers

```
Content-Type: application/json
Origin:       https://dw-prod.ec.txstate.edu
Referer:      https://dw-prod.ec.txstate.edu/responsiveDashboard/worksheets/whatif
Cookie:       <session cookie — see §3>
```

**No CSRF token.** No `X-Requested-With`. Same-origin CORS only — `Origin`
header must match the DW hostname. Confirmed: `sec-fetch-site: same-origin`
in the captured requests.

### 2.3 Request body shape

```jsonc
{
  "studentId":               "A05172670",    // real student NetID-derived; echoed in response
  "isIncludeInprogress":     true,
  "isIncludePreregistered":  true,
  "isKeepCurriculum":        false,          // false = what-if mode (see §4 Q5)
  "school":                  "UG",
  "degree":                  "BBA",
  "catalogYear":             "202310",       // Banner term code (see §2.4)
  "goals": [
    { "code": "MAJOR", "value": "MKT",  "catalogYear": "" },
    { "code": "CONC",  "value": "SALE", "catalogYear": "" }
    // Add more MAJOR or MINOR entries for double-major / minor combos (see §4 Q4)
  ],
  "classes": []   // inject no fake courses; real transcript still applied server-side
}
```

### 2.4 Catalog year encoding (Banner term codes)

Format: `(fallCalendarYear + 1) × 100 + 10` for the fall term of an academic year.


| Academic year | Fall start | Banner code |
| ------------- | ---------- | ----------- |
| 2022-2023     | Fall 2022  | `202310`    |
| 2023-2024     | Fall 2023  | `202410`    |
| 2024-2025     | Fall 2024  | `202510`    |
| 2025-2026     | Fall 2025  | `202610`    |


Spring = `YYY30`, Summer = `YYY50` (e.g. Spring 2023 = `202330`).

The `isVisibleInWhatif: true` range extends from **Fall 2016** all the way to
**Fall 2026** (as of 2026-04-24). No catalog year cutoff at 3–4 years back —
the full S1 scope (2022-2026) is safely in range.

---

## 3. Auth

The audit POST requires the browser session cookie. The HAR export stripped
cookies for privacy, but the call succeeded from the authenticated session.

**Driver cookie contract (S3):**

- Cookie jar file: `~/.bobcatplus-dw-cookie` (gitignored).
- Populate by copying the `Cookie:` header from a live DW DevTools request.
- Required name: likely `JSESSIONID` or a DW-specific token; capture the
full header value verbatim.
- The driver sends `Cookie: <contents of file>` on every audit POST.
- Abort on first 401/403 — never retry on auth failure.

No login automation. No SAML/SSO flow. Cookie-only.

---

## 4. Design questions from §6 — answers

### Q1 — Invalid-combo signal ✅ ANSWERED

**Captured in `tests/fixtures/audits/what-if/invalid-combo.har`
(Marketing BBA × AGED concentration, 2026-04-24).**

Result: **HTTP 200, no `errors`/`warnings` key, no CONC block.** The
top-level keys are the standard set:
`refresh, auditHeader, blockArray, classInformation, fallThrough, overTheLimit, insufficient, inProgress, fitList, splitCredits, degreeInformation, exceptionList, notes, flags`.

The signal is **pure structural absence**: when an invalid concentration is
supplied in `goals[]`, DW returns a valid audit with no CONC block.

**S3 driver detection rule:**

```js
const requestedConc = goals.some(g => g.code === 'CONC');
const gotConc = blockArray.some(b => b.requirementType === 'CONC');
if (requestedConc && !gotConc) outcome = 'invalid-combo';
```

### Q2 — Catalog year range ✅ ANSWERED

`isVisibleInWhatif: true` extends from Fall 2016 to Fall 2026. S1 scope
(2022-2026) is fully supported. No adjustment needed.

### Q3 — Auth: cookie vs CSRF ✅ ANSWERED

Session cookie only. No CSRF token in body or headers. `Origin` + `Referer`
headers must be present and set to the DW hostname. Node.js `fetch` / `https`
module can reproduce this exactly.

### Q4 — Double-major shape ✅ ANSWERED

Add multiple `{"code": "MAJOR", "value": "...", "catalogYear": ""}` entries
to `goals[]`. The response has **one DEGREE block** and **one MAJOR block per
entry**, plus any CONC blocks for concentrations of those majors.

Captured example (`double-major.har`): BBA Marketing (SALE conc) + BBA Management:

```
blockArray:
  DEGREE  BBA
  OTHER   FOR_LANG
  OTHER   CORE_BA / CORE_BLANK / BUS_CORE
  MAJOR   MKT
  CONC    SALE
  MAJOR   MGT           ← second major appended at end
```

### Q5 — `isKeepCurriculum` / fresh-student behavior ✅ ANSWERED

`isKeepCurriculum: false` + `classes: []` = **what-if mode**, but the
server **still applies Aidan's real transcript credits** (`classesApplied: 48`, `creditsApplied: 140` visible in the response). The `classes: []` field
means "don't inject extra hypothetical courses," not "wipe the transcript."

**Implication for S3:** the shape dump will include Aidan's real applied
courses in every audit. The shape extractor (S4) must filter these out or
treat them as noise — they are student-specific, not structural. A truly
fresh-student audit would require a different student account or an API flag
we haven't found yet.

### Q6 — Dual-degree shape ⚠️ PARTIALLY ANSWERED

The `dual-degree.har` session captured **a double-major** (BS Computer
Science + BS English + Music minor), not a true dual degree (BS + BA as
separate diplomas). The request body used a single `"degree": "BS"` with two
MAJOR goals — the result is the expected two-MAJOR-under-one-DEGREE structure.

**True dual-degree shape (BS + BA in separate diplomas) was NOT tested.** The
hypothesis (two top-level DEGREE blocks) is unverified. S3 should generate
5 representative double-major combos and 3 dual-degree combos per the plan;
the dual-degree ones need a separate DevTools session with two different
Degree dropdowns selected simultaneously in the UI.

---

## 5. Additional findings not in §6

### 5.1 DW majors/minors API as a manifest source

`GET /api/validations/special-entities/majors-whatif` returns all 180+ major
codes with descriptions, e.g.:

```json
{ "key": "MKT", "description": "Marketing", "isVisibleInWhatif": true }
```

Similarly for minors. A `concentrations` endpoint likely exists with a `major`
query parameter (observed referenced in the goals response; exact URL
unconfirmed). These endpoints plus the catalog scraper (S1) form the complete
combo manifest for S3.

### 5.2 Pre-flight calls are UI-only

The `GET /api/validations/special-entities/audit-formats` and `POST /api/goals`
calls are UI cascade logic. The `POST /api/audit` carries all parameters
directly. The driver does not need to make pre-flight calls.

### 5.3 Response echoes structural metadata

`auditHeader.whatIf: "Y"` confirms what-if mode. `auditHeader.auditId` is
session-specific (e.g. `"WA45hgSP"`) — do not use it in output filenames.
The deterministic filename key is `{catalogYear}-{degree}-{major}-{conc|nocon}`.

### 5.4 Blocks observed in captured sessions

Across the three HAR sessions and existing fixtures:


| `requirementType` | Example value                        | Source                  |
| ----------------- | ------------------------------------ | ----------------------- |
| `DEGREE`          | `BBA`, `BS`                          | All sessions            |
| `MAJOR`           | `MKT`, `CS`, `ENG`, `MGT`            | All sessions            |
| `CONC`            | `SALE`                               | marketing-sales session |
| `MINOR`           | `MU`                                 | dual-degree session     |
| `OTHER`           | `FOR_LANG`, `CORE_BLANK`, `BUS_CORE` | BBA sessions            |


---

## 6. S3 driver checklist (pre-implementation gate)

Before writing `scripts/whatif/pull-audits.js`:

- Endpoint URL and method confirmed
- Request body shape documented
- Auth mechanism: cookie-only, no CSRF
- Catalog year codes verified
- Double-major: multiple MAJOR goals
- Invalid-combo signal: structural absence of CONC block — see Q1
- Dual-degree: separate session with two Degree dropdowns
- Concentration endpoint URL: confirm `GET .../concentrations?major=MKT`
shape (needed for the S1 manifest enrichment step)
- `isKeepCurriculum: false` = what-if mode confirmed
- Rate limit: 1 req / 2 s, no parallelism (per plan)

