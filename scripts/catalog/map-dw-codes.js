#!/usr/bin/env node
// scripts/catalog/map-dw-codes.js
//
// S1 follow-up.  Reads scripts/catalog/degree-combinations.json (produced by
// scrape-majors.js), calls the DW validation API to resolve Banner major and
// concentration codes, and writes the codes back into the manifest.
//
// Must run before scripts/whatif/pull-audits.js.
//
// Usage:
//   node scripts/catalog/map-dw-codes.js               # update manifest in-place
//   node scripts/catalog/map-dw-codes.js --dry-run     # print matches, no write
//
// Auth: ~/.bobcatplus-dw-cookie — same format as pull-audits.js.
//
// Matching strategy:
//   DW descriptions ("Marketing") are normalized to bare lowercase ("marketing")
//   and compared against catalog majorSlugs ("marketing").  Entries that don't
//   match automatically are printed as UNMATCHED — fill dwMajorCode in the
//   manifest by hand for those (see README).
//
// Rate: 1 req/s — these are validation endpoints, still TXST IT's server.

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

const COOKIE_FILE = path.join(os.homedir(), '.bobcatplus-dw-cookie');
const MANIFEST    = path.join(__dirname, 'degree-combinations.json');
const DW_BASE     = 'https://dw-prod.ec.txstate.edu/responsiveDashboard';
const RATE_MS     = 1000;

// Manual overrides for majors: "${majorSlug}|${degree}" → dwMajorCode.
// Used when neither slug-based nor title-based description matching resolves a program.
// Reasons: DW uses a different short name, catalog slug includes dept context, or DW
// groups catalog sub-tracks under one parent major code.
const MAJOR_OVERRIDES = {
  // Theatre / BFA acting — DW uses short name "Acting" (key: ACT)
  'acting-stage-screen|BFA':            'ACT',
  // Geography family — catalog splits into sub-programs, DW groups under GEO
  'geographic-information-science|BS':  'GEO',
  'geography-environmental-studies-accelerated-online-program|BS': 'GEO',
  'resource-environmental-studies-climate-dynamics-society|BS':    'GEO',
  'resource-environmental-studies-environmental-management|BS':    'GEO',
  'resource-environmental-studies-natural-resources-conservation|BS': 'GEO',
  'resource-environmental-studies-water-resources|BS':             'GEO',
  'resource-environmental-studies|BS':  'GEO',
  'urban-regional-planning|BS':         'GEO',
  'water-resources|BS':                 'GEO',
  'physical|BS':                        'GEO',  // Physical Geography
  // Journalism — DW uses "Mass Communications" (key: MC)
  'journalism|BS':                      'MC',
  'journalism-mass-communication|BS':   'MC',
  // Recreation and Sport Management — DW key: RESM
  'recreation-studies-community-recreation|BS':   'RESM',
  'recreation-studies-outdoor-recreation|BS':     'RESM',
  'recreation-studies-therapeutic-recreation|BS': 'RESM',
};

// Manual overrides: "${dwMajorCode}|${concSlug}" → dwConcCode.
// DW concentration descriptions are short keys that don't match catalog slug fragments,
// so the description-based matcher cannot resolve these automatically.
const CONC_OVERRIDES = {
  // Sports Media concentration shared across all mass-comm majors (DW code: SPOR)
  'AD|advertising-mass-communication-sports-media':            'SPOR',
  'DMI|digital-mass-communication-sports-media':               'SPOR',
  'EM|electronic-media-mass-communication-sports-media':       'SPOR',
  'MC|journalism-mass-communication-sports-media':             'SPOR',
  'PR|public-relations-mass-communication-sports-media':       'SPOR',
  // Manufacturing Engineering concentrations
  'MFGE|manufacturing-engineering-smart':                      'SMAN',
  // Management concentrations
  'MGT|management-human-resource':                             'HRM',
  // Marketing concentrations
  'MKT|marketing-professional-sales':                          'SALE',
  'MKT|marketing-services':                                    'SERV',
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

function loadAuth() {
  if (!fs.existsSync(COOKIE_FILE)) {
    die(`Cookie file not found: ${COOKIE_FILE}\nSee scripts/whatif/README.md for setup.`);
  }
  const raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  try {
    const obj = JSON.parse(raw);
    if (!obj.cookie) throw new Error();
    return obj.cookie.trim();
  } catch (_) {
    return raw.split('\n')[0].trim();
  }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

function dwGet(cookie, subpath) {
  return new Promise((resolve, reject) => {
    const url  = `${DW_BASE}${subpath}`;
    const opts = {
      hostname: 'dw-prod.ec.txstate.edu',
      path:     `/responsiveDashboard${subpath}`,
      method:   'GET',
      headers:  {
        'Accept':     'application/json',
        'Origin':     'https://dw-prod.ec.txstate.edu',
        'Referer':    'https://dw-prod.ec.txstate.edu/responsiveDashboard/worksheets/whatif',
        'Cookie':     cookie,
        'User-Agent': 'BobcatPlus/1.0 (map-dw-codes; research)',
      },
    };
    const req = https.request(opts, res => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        die(`HTTP ${res.statusCode} — session cookie expired.\nRefresh ${COOKIE_FILE} from DevTools.`);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (e) {
          reject(new Error(`Bad JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function die(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

// ─── Normalization ───────────────────────────────────────────────────────────
// Strip everything except letters and digits, lowercase.
// "Computer Science" → "computerscience"
// "computer-science" → "computerscience"

function norm(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Extract the bare major name from a catalog title, e.g.:
// "Bachelor of Science (B.S.) Major in Advertising" → "Advertising"
// "B.S. Major in Marketing (Professional Sales Concentration)" → "Marketing"
// Decodes HTML entities so &amp; → & before normalizing.
function titleMajorName(title) {
  const decoded = (title || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
  const m = /Major in ([^(]+)/i.exec(decoded);
  return m ? m[1].trim() : null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');

  if (!fs.existsSync(MANIFEST)) {
    die(`Manifest not found: ${MANIFEST}\nRun scrape-majors.js first.`);
  }

  const cookie   = loadAuth();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const programs = manifest.programs || [];

  // ── 1. Fetch all DW major codes ──────────────────────────────────────────
  process.stderr.write('Fetching DW major list…\n');
  const { data: majorsRaw } = await dwGet(cookie, '/api/validations/special-entities/majors-whatif');
  await sleep(RATE_MS);

  // majorsRaw is an array of { key, description, isVisibleInWhatif }
  const dwMajors = Array.isArray(majorsRaw)
    ? majorsRaw
    : (majorsRaw._embedded?.majors || majorsRaw.data || majorsRaw.majors || []);
  if (!dwMajors.length) die(`Unexpected majors response shape: ${JSON.stringify(majorsRaw).slice(0, 200)}`);

  // Build lookup: normalized description → { key, description }[]
  // Keep all matches (some descriptions may normalize identically — flag those).
  const byNorm = new Map();
  for (const m of dwMajors) {
    const k = norm(m.description || '');
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(m);
  }

  // Also build a direct key lookup (for manual overrides already in manifest).
  const byKey = new Map(dwMajors.map(m => [m.key, m]));

  process.stderr.write(`  ${dwMajors.length} DW major codes loaded.\n`);

  // ── 2. Match each unique majorSlug ────────────────────────────────────────
  const majorSlugToDwCode = new Map();   // majorSlug → dwMajorCode (or null)
  const unmatched = [];

  const uniqueSlugsByDegree = new Map(); // "slug|degree" dedup
  for (const p of programs) {
    const key = `${p.majorSlug}|${p.degree}`;
    if (!uniqueSlugsByDegree.has(key)) uniqueSlugsByDegree.set(key, p);
  }

  for (const [key, p] of uniqueSlugsByDegree) {
    // If already filled (manual override) — keep it.
    if (p.dwMajorCode) {
      majorSlugToDwCode.set(p.majorSlug, p.dwMajorCode);
      continue;
    }

    // Normalize the catalog slug: "computer-science" → "computerscience"
    const n = norm(p.majorSlug);
    const candidates = byNorm.get(n) || [];

    if (candidates.length === 1) {
      majorSlugToDwCode.set(p.majorSlug, candidates[0].key);
    } else if (candidates.length > 1) {
      // Ambiguous — pick the visible-in-whatif one if there's only one.
      const visible = candidates.filter(c => c.isVisibleInWhatif);
      if (visible.length === 1) {
        majorSlugToDwCode.set(p.majorSlug, visible[0].key);
      } else {
        unmatched.push({ slug: p.majorSlug, degree: p.degree, reason: 'ambiguous', candidates: candidates.map(c => c.key) });
        majorSlugToDwCode.set(p.majorSlug, null);
      }
    } else {
      // Second pass: match via the clean major name extracted from the program title.
      // Catalog slugs often include department context (e.g. "advertising-mass-communication")
      // that DW omits; the title's "Major in X" phrase is more reliable.
      const titleName  = titleMajorName(p.title);
      const titleNorm  = titleName ? norm(titleName) : '';
      const titleCands = titleNorm ? (byNorm.get(titleNorm) || []) : [];

      if (titleCands.length === 1) {
        majorSlugToDwCode.set(p.majorSlug, titleCands[0].key);
      } else if (titleCands.length > 1) {
        const visible = titleCands.filter(c => c.isVisibleInWhatif);
        if (visible.length === 1) {
          majorSlugToDwCode.set(p.majorSlug, visible[0].key);
        } else {
          unmatched.push({ slug: p.majorSlug, degree: p.degree, reason: 'ambiguous', candidates: titleCands.map(c => c.key) });
          majorSlugToDwCode.set(p.majorSlug, null);
        }
      } else {
        // Third pass: manual override table.
        const overrideKey = `${p.majorSlug}|${p.degree}`;
        const overrideCode = MAJOR_OVERRIDES[overrideKey];
        if (overrideCode) {
          majorSlugToDwCode.set(p.majorSlug, overrideCode);
        } else {
          unmatched.push({ slug: p.majorSlug, degree: p.degree, reason: 'no-match' });
          majorSlugToDwCode.set(p.majorSlug, null);
        }
      }
    }
  }

  // ── 3. Fetch concentrations for majors that need them ─────────────────────
  // Unique DW major codes that have at least one entry with a non-null concSlug.
  const majorsNeedingConcs = new Set(
    programs
      .filter(p => p.concSlug && majorSlugToDwCode.get(p.majorSlug))
      .map(p => majorSlugToDwCode.get(p.majorSlug))
  );

  // concSlug → dwConcCode, keyed by "dwMajorCode|concSlug"
  // Pre-seed with manual overrides so they don't appear in the unmatched report.
  const concMap = new Map(Object.entries(CONC_OVERRIDES));

  let concIdx = 0;
  for (const dwCode of majorsNeedingConcs) {
    concIdx++;
    process.stderr.write(`Fetching concentrations for ${dwCode} (${concIdx}/${majorsNeedingConcs.size})…\n`);

    let concs = [];
    try {
      const { status, data } = await dwGet(
        cookie,
        `/api/validations/special-entities/concentrations?major=${encodeURIComponent(dwCode)}`
      );
      if (status === 200) {
        concs = Array.isArray(data)
          ? data
          : (data._embedded?.concentrations || data.data || data.concentrations || []);
      } else {
        process.stderr.write(`  HTTP ${status} — skipping concentrations for ${dwCode}\n`);
      }
    } catch (err) {
      process.stderr.write(`  WARN: concentrations fetch failed for ${dwCode}: ${err.message}\n`);
    }

    // Build norm lookup for this major's concentrations.
    const concByNorm = new Map();
    for (const c of concs) {
      const k = norm(c.description || c.value || '');
      concByNorm.set(k, c.key || c.value || c.code);
    }

    // Also index by key directly.
    const concByKey = new Map(concs.map(c => [(c.key || c.value || c.code), c]));

    // Match each unique concSlug for this major.
    const slugsForMajor = [...new Set(
      programs
        .filter(p => majorSlugToDwCode.get(p.majorSlug) === dwCode && p.concSlug)
        .map(p => p.concSlug)
    )];

    for (const concSlug of slugsForMajor) {
      const mapKey = `${dwCode}|${concSlug}`;
      // The concSlug is the full pre-conc portion: "marketing-professional-sales"
      // DW description: "Professional Sales"
      // Strip the leading major name from the slug and normalize.
      const majorSlugForCode = programs.find(x => majorSlugToDwCode.get(x.majorSlug) === dwCode)?.majorSlug || '';
      const withoutMajor = concSlug.replace(new RegExp(`^${majorSlugForCode}-?`, 'i'), '');
      const n = norm(withoutMajor) || norm(concSlug);

      if (concByNorm.has(n)) {
        concMap.set(mapKey, concByNorm.get(n));
      } else {
        // Try matching the full concSlug normalized.
        const full = norm(concSlug);
        if (concByNorm.has(full)) {
          concMap.set(mapKey, concByNorm.get(full));
        } else if (!concMap.has(mapKey)) {
          unmatched.push({ slug: concSlug, major: dwCode, reason: 'conc-no-match',
            available: [...concByNorm.entries()].map(([k,v]) => `${v}(${k})`) });
          concMap.set(mapKey, null);
        }
      }
    }

    await sleep(RATE_MS);
  }

  // ── 4. Write codes back into manifest ────────────────────────────────────
  let filled = 0, skipped = 0;

  for (const p of programs) {
    const dwMajorCode = majorSlugToDwCode.get(p.majorSlug) || null;
    p.dwMajorCode = dwMajorCode;

    if (p.concSlug && dwMajorCode) {
      const mapKey = `${dwMajorCode}|${p.concSlug}`;
      p.dwConcCode = concMap.get(mapKey) || null;
    } else {
      p.dwConcCode = null;
    }

    if (p.dwMajorCode) filled++; else skipped++;
  }

  // ── 5. Report ─────────────────────────────────────────────────────────────
  console.log(`\n── Results ─────────────────────────────────────`);
  console.log(`  Programs:     ${programs.length}`);
  console.log(`  Major codes filled:   ${filled}`);
  console.log(`  Major codes missing:  ${skipped}`);

  if (unmatched.length) {
    console.log(`\n── Unmatched (fill dwMajorCode / dwConcCode by hand) ──`);
    for (const u of unmatched) {
      if (u.reason === 'no-match')
        console.log(`  MAJOR  slug="${u.slug}" degree=${u.degree}  → no DW match`);
      else if (u.reason === 'ambiguous')
        console.log(`  MAJOR  slug="${u.slug}" degree=${u.degree}  → ambiguous: ${u.candidates.join(', ')}`);
      else
        console.log(`  CONC   slug="${u.slug}" major=${u.major}  → no DW match (available: ${(u.available || []).join(', ') || 'none'})`);
    }
  }

  if (DRY_RUN) {
    console.log('\nDry run — manifest not written.');
    return;
  }

  manifest.dwCodesUpdatedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\nManifest written: ${MANIFEST}`);
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err.stack || err.message}\n`);
  process.exit(1);
});
