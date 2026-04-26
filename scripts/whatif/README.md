# scripts/whatif/

What-If audit driver (Phase 1.6 / S3).  POSTs to the DW What-If endpoint for
every combo in the catalog manifest and writes one JSON fixture per audit.

## Prerequisites

1. **Catalog manifest** — run S1 + S2 first:
   ```bash
   node scripts/catalog/scrape-majors.js
   node scripts/catalog/map-dw-codes.js   # requires ~/.bobcatplus-dw-cookie
   ```
2. **Session cookie** — create `~/.bobcatplus-dw-cookie` (gitignored):
   ```json
   { "cookie": "<full Cookie: header value from DevTools>", "studentId": "A0XXXXXXX" }
   ```
   Get the values from DevTools → Network → any `/responsiveDashboard/api/` XHR →
   Headers tab → Request Headers → `Cookie`.  Your `studentId` is shown in
   the DW URL or echoed in any audit response `auditHeader.studentId`.

## Usage

```bash
# Smoke test — 5 combos, no writes
node scripts/whatif/pull-audits.js --dry-run --limit=5

# Single catalog year (~200 audits, ~7 min)
node scripts/whatif/pull-audits.js --year=2025-2026

# Full run — all 4 years (~800 audits, ~27 min)
node scripts/whatif/pull-audits.js

# Double-major / dual-degree representative set (~5 combos)
node scripts/whatif/pull-audits.js --doubled
```

## Output

```
tests/fixtures/audits/whatif/
  audit-2025-2026-BBA-MKT-SALE.json     ← degree+major+conc
  audit-2025-2026-BA-ENG-nocon.json     ← degree+major, no concentration
  doubled/
    audit-BBA-MKT+MGT.json              ← double-major
```

The bulk dump is gitignored.  S5 commits a curated ~20-fixture subset via
`git add -f tests/fixtures/audits/whatif/<name>.json`.

## Log

Every call appends one JSON line to `scripts/whatif/run.log` (gitignored):

```json
{"combo":"2025-2026-BBA-MKT-SALE","outcome":"ok","file":"...","timestamp":"..."}
```

`outcome` is one of: `ok | invalid-combo | http-error | skipped`.

## Rate limit

1 request / 2 seconds, no parallelism.  TXST IT goodwill is load-bearing for
the whole extension — do not increase the rate.

## Cookie expiry

The driver aborts on the first 401/403 and prints refresh instructions.
Re-paste the cookie from DevTools and re-run; idempotency skips already-fresh
files (≤30 days old).
