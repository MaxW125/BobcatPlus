#!/usr/bin/env node
// scripts/catalog/scrape-majors.js
//
// Scrapes mycatalog.txstate.edu for all undergraduate programs across four
// catalog years and emits scripts/catalog/degree-combinations.json — the
// combo manifest consumed by scripts/whatif/pull-audits.js (S3).
//
// No external deps.  Rate: 1 req/s.  Est. ~800 pages, ~15 min wall-clock.
//
// Usage:
//   node scripts/catalog/scrape-majors.js
//   node scripts/catalog/scrape-majors.js --year 2025-2026        # one year only
//   node scripts/catalog/scrape-majors.js --dry-run               # count URLs, no fetch
//
// Output: scripts/catalog/degree-combinations.json
//
// NOTE on major/concentration codes:
//   This scraper extracts catalog slugs (e.g. "marketing", "professional-sales").
//   The Banner/DW short codes (MKT, SALE) are NOT in the catalog HTML.
//   After running this script, run scripts/catalog/map-dw-codes.js (requires
//   a live DW session cookie) to populate dwMajorCode / dwConcCode fields.
//   Or match manually against:
//     GET https://dw-prod.ec.txstate.edu/responsiveDashboard/api/validations/special-entities/majors-whatif

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'degree-combinations.json');
const CATALOG_BASE = 'https://mycatalog.txstate.edu';

// Four academic years in scope (back to Fall 2022 for Spring 2026 graduates).
const YEARS = ['2022-2023', '2023-2024', '2024-2025', '2025-2026'];
const CURRENT = '2025-2026';

// Banner term codes for the fall-start term of each academic year.
// Formula: (fallCalendarYear + 1) * 100 + 10.  e.g. Fall 2022 → 202310.
const DW_YEAR = {
  '2022-2023': '202310',
  '2023-2024': '202410',
  '2024-2025': '202510',
  '2025-2026': '202610',
};

const DEGREE_TOKENS = ['bba','bs','ba','bfa','baas','bat','bm','bsw','baa','bed','bsed','bsn','barch','bae','blas'];
const DEGREE_BOUNDARY = `(?:^|[/-])(${DEGREE_TOKENS.join('|')})(?:[/-]|$)`;
const DEGREE_RE = new RegExp(DEGREE_BOUNDARY, 'i');

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function get(rawUrl, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(rawUrl, {
      headers: { 'User-Agent': 'BobcatPlus/1.0 (catalog-scraper; research)' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects === 0) return reject(new Error(`Too many redirects: ${rawUrl}`));
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.origin}${res.headers.location}`;
        res.resume();
        return get(loc, maxRedirects - 1).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, url: rawUrl, body }));
    });
    req.on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTML extraction ─────────────────────────────────────────────────────────

function extractH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
}

function extractLinks(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const seen = new Set();
  const re = /href="([^"#]+)"/g;
  let m;
  const results = [];
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    if (href.startsWith('/'))  href = origin + href;
    if (!href.startsWith('http')) continue;
    try { new URL(href); } catch { continue; }
    const clean = href.split('?')[0].replace(/\/$/, '');
    if (!seen.has(clean)) { seen.add(clean); results.push(clean); }
  }
  return results;
}

// ─── Program parsing ─────────────────────────────────────────────────────────

function parseProgram(finalUrl, html, catalogYear) {
  const title = extractH1(html);
  if (!title) return null;

  const pathname = new URL(finalUrl).pathname.replace(/\/$/, '');
  const slug = pathname.split('/').pop();

  const degMatch = DEGREE_RE.exec(slug);
  if (!degMatch) return null;
  const degree = degMatch[1].toUpperCase();

  // Concentration: slug pattern "…-concentration-{degree}"
  const concRe = new RegExp(`^(.+)-concentration-${degree}$`, 'i');
  const concMatch = concRe.exec(slug);

  // "honors" track: slug contains "-honors" or title contains "Honors"
  const honors = /honors/i.test(slug) || /honors/i.test(title);

  // Strip the degree suffix from the base major slug
  const baseSuffix = new RegExp(`-${degree}$`, 'i');

  let majorSlug, concSlug;
  if (concMatch) {
    // e.g. "marketing-professional-sales-concentration-bba"
    const withoutConc = concMatch[1]; // "marketing-professional-sales"
    // The major slug is the leading segment before the concentration name.
    // Heuristic: the major slug appears in the non-concentration sibling page URL.
    // Best we can do here without the sibling: store the full pre-conc slug.
    concSlug = withoutConc;  // e.g. "marketing-professional-sales" (see _codeNote)
    majorSlug = withoutConc.replace(/-[^-].*$/, ''); // first token: "marketing"
  } else {
    majorSlug = slug.replace(baseSuffix, '');
    concSlug = null;
  }

  return {
    title,
    degree,
    majorSlug,   // catalog slug; map to Banner code via map-dw-codes.js
    concSlug,    // null if no concentration
    dwMajorCode: null,  // populated by map-dw-codes.js
    dwConcCode:  null,  // populated by map-dw-codes.js
    catalogYear,
    dwCatalogYear: DW_YEAR[catalogYear],
    slug,
    url: finalUrl,
    honors,
  };
}

// ─── Per-year scrape ─────────────────────────────────────────────────────────

async function scrapeYear(catalogYear, dryRun) {
  const prefix = catalogYear === CURRENT ? '' : `/previouscatalogs/${catalogYear}`;
  const indexUrl = `${CATALOG_BASE}${prefix}/undergraduate/majors/`;

  process.stderr.write(`\n[${catalogYear}] ${indexUrl}\n`);
  const { status, body } = await get(indexUrl);
  if (status !== 200) {
    process.stderr.write(`  HTTP ${status} — skipping year\n`);
    return { programs: [], minors: [] };
  }

  const allLinks = extractLinks(body, indexUrl);

  const programLinks = allLinks.filter(l => {
    if (!l.includes('/undergraduate/')) return false;
    if (l.includes('/minor')) return false;
    return DEGREE_RE.test(l);
  });

  const minorLinks = allLinks.filter(l =>
    l.includes('/undergraduate/') && /\/minor\b/i.test(l)
  );

  if (dryRun) {
    process.stderr.write(`  programs: ${programLinks.length}, minors: ${minorLinks.length} (dry run)\n`);
    return { programs: [], minors: [] };
  }

  const programs = [];
  for (const link of programLinks) {
    await sleep(1000);
    let result;
    try { result = await get(link); }
    catch (e) { process.stderr.write(`  ERROR ${link}: ${e.message}\n`); continue; }
    if (result.status !== 200) continue;
    const prog = parseProgram(result.url, result.body, catalogYear);
    if (prog) {
      programs.push(prog);
      process.stderr.write(`  ${prog.degree}  ${prog.title}\n`);
    }
  }

  const minors = [];
  for (const link of minorLinks) {
    await sleep(1000);
    let result;
    try { result = await get(link); }
    catch (e) { process.stderr.write(`  ERROR ${link}: ${e.message}\n`); continue; }
    if (result.status !== 200) continue;
    const title = extractH1(result.body);
    if (!title) continue;
    const slug = new URL(result.url).pathname.replace(/\/$/, '').split('/').filter(Boolean).slice(-2)[0];
    minors.push({
      title,
      slug,
      dwMinorCode: null, // populated by map-dw-codes.js
      catalogYear,
      dwCatalogYear: DW_YEAR[catalogYear],
      url: result.url,
    });
    process.stderr.write(`  minor  ${title}\n`);
  }

  return { programs, minors };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const yearArg = args.includes('--year') ? args[args.indexOf('--year') + 1] : null;
  const years = yearArg ? [yearArg] : YEARS;

  if (yearArg && !YEARS.includes(yearArg)) {
    console.error(`Unknown catalog year "${yearArg}". Valid: ${YEARS.join(', ')}`);
    process.exit(1);
  }

  const allPrograms = [];
  const allMinors = [];

  for (const year of years) {
    const { programs, minors } = await scrapeYear(year, dryRun);
    allPrograms.push(...programs);
    allMinors.push(...minors);
  }

  if (dryRun) {
    process.stderr.write('\nDry run complete — no files written.\n');
    return;
  }

  const manifest = {
    scrapedAt: new Date().toISOString().slice(0, 10),
    catalogYears: years,
    dwCatalogYearCodes: DW_YEAR,
    _codeNote: [
      'dwMajorCode, dwConcCode, dwMinorCode are null until map-dw-codes.js is run.',
      'Run: node scripts/catalog/map-dw-codes.js (requires ~/.bobcatplus-dw-cookie).',
      'Manual fallback: match majorSlug/concSlug against',
      'GET /responsiveDashboard/api/validations/special-entities/majors-whatif descriptions.',
    ].join(' '),
    programs: allPrograms,
    minors: allMinors,
  };

  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2));
  process.stderr.write(`\nWrote ${allPrograms.length} programs + ${allMinors.length} minors → ${OUT}\n`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
