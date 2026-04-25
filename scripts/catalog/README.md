# scripts/catalog/

Catalog scraper (Phase 1.6 / S1). Enumerates every undergraduate program combo
across four TXST catalog years and emits `degree-combinations.json`.

## Usage

```bash
# Full run — ~800 pages, ~15 min at 1 req/s
node scripts/catalog/scrape-majors.js

# Single year
node scripts/catalog/scrape-majors.js --year 2025-2026

# Dry run (count URLs, no fetches beyond the index page)
node scripts/catalog/scrape-majors.js --dry-run
```

## Output

`scripts/catalog/degree-combinations.json` — gitignored in bulk.  S5 commits
a curated subset of ~20 audits as named fixtures; the manifest itself is not
committed.

Each program entry looks like:

```jsonc
{
  "title": "B.B.A. Major in Marketing (Professional Sales Concentration)",
  "degree": "BBA",
  "majorSlug": "marketing",          // catalog slug (not Banner code)
  "concSlug": "marketing-professional-sales",  // null if no concentration
  "dwMajorCode": null,               // populate via map-dw-codes.js
  "dwConcCode":  null,               // populate via map-dw-codes.js
  "catalogYear": "2025-2026",
  "dwCatalogYear": "202610",         // Banner term code for fall start
  "slug": "marketing-professional-sales-concentration-bba",
  "url": "https://mycatalog.txstate.edu/undergraduate/majors/…",
  "honors": false
}
```

## DW code mapping (required before running pull-audits.js)

The catalog HTML does not expose Banner major/concentration codes (MKT, SALE).
After scraping, run:

```bash
node scripts/catalog/map-dw-codes.js   # requires ~/.bobcatplus-dw-cookie
```

This calls:

- `GET /api/validations/special-entities/majors-whatif` → maps `majorSlug` descriptions
to `dwMajorCode`
- `GET /api/validations/special-entities/concentrations?major={code}` (per major) →
populates `dwConcCode`

If that endpoint URL is wrong, see `docs/plans/whatif-endpoint.md` §5 Q6
and fill in manually for the ~20 programs with concentrations.

## Re-run schedule

Re-scrape once per semester (before each fall and spring registration window)
to catch new programs added by TXST.  The `scrapedAt` field in the manifest
records the last run date.