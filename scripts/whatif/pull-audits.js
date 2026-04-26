#!/usr/bin/env node
// scripts/whatif/pull-audits.js
//
// S3 — What-If audit driver.  Reads scripts/catalog/degree-combinations.json
// (produced by S1 + map-dw-codes.js), POSTs to the DW What-If endpoint for
// every valid combo, and writes one JSON fixture per audit.
//
// Usage:
//   node scripts/whatif/pull-audits.js                     # full run (~800 audits)
//   node scripts/whatif/pull-audits.js --year=2025-2026    # one catalog year only
//   node scripts/whatif/pull-audits.js --limit=5           # first N combos (smoke test)
//   node scripts/whatif/pull-audits.js --dry-run           # print what would run, no fetches
//   node scripts/whatif/pull-audits.js --doubled           # run double-major / dual-degree set
//
// Auth:  ~/.bobcatplus-dw-cookie — JSON file populated once from DevTools:
//   { "cookie": "<full Cookie: header value>", "studentId": "A0XXXXXXX" }
//   Plain-text fallback: first line = cookie string, second line = studentId.
//
// Output: tests/fixtures/audits/whatif/audit-{year}-{degree}-{major}-{conc|nocon}.json
//         tests/fixtures/audits/whatif/doubled/audit-{year}-{degree}-{major1}+{major2}.json
// Log:    scripts/whatif/run.log  (one JSON line per call)
//
// Hard constraints (TXST IT goodwill):
//   - 1 request / 2 seconds, no parallelism
//   - Cookie-only auth — no login automation
//   - Idempotent: skip any output file that exists and is ≤30 days old
//   - Abort on first 401/403 with a "refresh your cookie" message

'use strict';

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ─── Paths ───────────────────────────────────────────────────────────────────

const COOKIE_FILE = path.join(os.homedir(), '.bobcatplus-dw-cookie');
const MANIFEST    = path.join(__dirname, '../catalog/degree-combinations.json');
const OUT_DIR     = path.join(__dirname, '../../tests/fixtures/audits/whatif');
const DOUBLED_DIR = path.join(OUT_DIR, 'doubled');
const LOG_FILE    = path.join(__dirname, 'run.log');

// ─── Constants ───────────────────────────────────────────────────────────────

const DW_HOST        = 'dw-prod.ec.txstate.edu';
const DW_AUDIT_PATH  = '/responsiveDashboard/api/audit';
const RATE_DELAY_MS  = 2000;
const FRESHNESS_MS   = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── CLI args ────────────────────────────────────────────────────────────────

const rawArgs  = process.argv.slice(2);
const DRY_RUN  = rawArgs.includes('--dry-run');
const DOUBLED  = rawArgs.includes('--doubled');
const yearArg  = (rawArgs.find(a => a.startsWith('--year=')) || '').split('=')[1];
const limitArg = (rawArgs.find(a => a.startsWith('--limit=')) || '').split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : Infinity;

// ─── Representative doubled combos ───────────────────────────────────────────
// Edit this list to add / remove double-major or dual-degree combos.
// Each entry maps to one what-if POST with multiple MAJOR goals.
//
// double-major: same degree, two MAJORs.
// dual-degree:  two degree types (BS + BA) — true dual-degree shape unverified
//               per whatif-endpoint.md §4 Q6; skipped in --doubled run until
//               a DevTools session confirms the two-DEGREE-block hypothesis.

const DOUBLED_COMBOS = [
  // double-major within BS (5 representative pairs)
  { label: 'BS-CS+MATH',   degree: 'BS',  catalogYear: '202610', majors: ['CS',  'MATH'], concs: [] },
  { label: 'BS-CS+PHYS',   degree: 'BS',  catalogYear: '202610', majors: ['CS',  'PHYS'], concs: [] },
  { label: 'BBA-MKT+MGT',  degree: 'BBA', catalogYear: '202610', majors: ['MKT', 'MGT'],  concs: ['SALE', ''] },
  { label: 'BBA-MKT+FIN',  degree: 'BBA', catalogYear: '202610', majors: ['MKT', 'FIN'],  concs: [] },
  { label: 'BA-ENG+HIST',  degree: 'BA',  catalogYear: '202610', majors: ['ENG', 'HIST'], concs: [] },
  // dual-degree combos (BS + BA) — skipped until dual-degree shape is verified
  // { label: 'BS+BA-CS+ENG', degrees: ['BS','BA'], catalogYear: '202610', majors: ['CS','ENG'] },
];

// ─── Auth ─────────────────────────────────────────────────────────────────────

function loadAuth() {
  if (!fs.existsSync(COOKIE_FILE)) {
    die(
      `Cookie file not found: ${COOKIE_FILE}\n` +
      `Create it from DevTools (copy the Cookie: request header from a live DW call):\n` +
      `  { "cookie": "<full Cookie: header value>", "studentId": "A0XXXXXXX" }\n`
    );
  }
  const raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  try {
    const obj = JSON.parse(raw);
    if (!obj.cookie || !obj.studentId) throw new Error('missing fields');
    return { cookie: obj.cookie.trim(), studentId: obj.studentId.trim() };
  } catch (_) {
    // Plain-text fallback: line 1 = cookie, line 2 = studentId
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      die(
        `${COOKIE_FILE} must be JSON {cookie, studentId} or two lines (cookie, then studentId).\n`
      );
    }
    return { cookie: lines[0], studentId: lines[1] };
  }
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function postAudit(auth, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: DW_HOST,
      path:     DW_AUDIT_PATH,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Origin':         `https://${DW_HOST}`,
        'Referer':        `https://${DW_HOST}/responsiveDashboard/worksheets/whatif`,
        'Cookie':         auth.cookie,
        'User-Agent':     'BobcatPlus/1.0 (rule-shape-discovery; research)',
      },
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return (Date.now() - stat.mtimeMs) < FRESHNESS_MS;
  } catch (_) {
    return false;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendLog(entry) {
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
  fs.appendFileSync(LOG_FILE, line, 'utf8');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function die(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

function fmt(n, total) {
  return `[${String(n).padStart(String(total).length, ' ')}/${total}]`;
}

// ─── Single-combo runner ─────────────────────────────────────────────────────

async function runCombo({ auth, requestBody, outPath, label, index, total, requestedConc }) {
  if (isRecent(outPath)) {
    console.log(`${fmt(index, total)} SKIP  ${label}  (fresh)`);
    appendLog({ combo: label, outcome: 'skipped', file: outPath });
    return 'skipped';
  }

  if (DRY_RUN) {
    console.log(`${fmt(index, total)} DRY   ${label}  → ${path.relative(process.cwd(), outPath)}`);
    return 'dry';
  }

  let res;
  try {
    res = await postAudit(auth, requestBody);
  } catch (err) {
    console.error(`${fmt(index, total)} ERROR ${label}  (network: ${err.message})`);
    appendLog({ combo: label, outcome: 'http-error', error: err.message });
    return 'error';
  }

  if (res.status === 401 || res.status === 403) {
    appendLog({ combo: label, outcome: 'http-error', httpStatus: res.status });
    die(
      `HTTP ${res.status} on combo "${label}".\n` +
      `Your DW session cookie has expired.  Refresh it:\n` +
      `  1. Open https://${DW_HOST}/responsiveDashboard/worksheets/whatif in Chrome\n` +
      `  2. DevTools → Network → any XHR → copy the Cookie: header value\n` +
      `  3. Update ${COOKIE_FILE}\n`
    );
  }

  if (res.status !== 200) {
    console.error(`${fmt(index, total)} ERROR ${label}  (HTTP ${res.status})`);
    appendLog({ combo: label, outcome: 'http-error', httpStatus: res.status });
    return 'error';
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (err) {
    console.error(`${fmt(index, total)} ERROR ${label}  (bad JSON: ${err.message})`);
    appendLog({ combo: label, outcome: 'http-error', error: 'bad JSON' });
    return 'error';
  }

  // Invalid-combo detection (whatif-endpoint.md §4 Q1):
  // DW returns HTTP 200 with no CONC block when an invalid concentration is supplied.
  const blockArray = (parsed.blockArray || []);
  const gotConc    = blockArray.some(b => b.requirementType === 'CONC');
  if (requestedConc && !gotConc) {
    console.log(`${fmt(index, total)} INVAL ${label}  (no CONC block returned — invalid combo)`);
    appendLog({ combo: label, outcome: 'invalid-combo' });
    return 'invalid-combo';
  }

  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, res.body, 'utf8');
  console.log(`${fmt(index, total)} OK    ${label}  → ${path.relative(process.cwd(), outPath)}`);
  appendLog({ combo: label, outcome: 'ok', file: outPath });
  return 'ok';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const auth = loadAuth();
  ensureDir(OUT_DIR);

  if (DOUBLED) {
    await runDoubled(auth);
    return;
  }

  // ── Load manifest ──
  if (!fs.existsSync(MANIFEST)) {
    die(
      `Manifest not found: ${MANIFEST}\n` +
      `Run scripts/catalog/scrape-majors.js then scripts/catalog/map-dw-codes.js first.\n`
    );
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  let programs = manifest.programs || [];

  // Filter to entries where DW codes are populated
  const skippedNoCodes = programs.filter(p => !p.dwMajorCode);
  programs = programs.filter(p => p.dwMajorCode);

  if (skippedNoCodes.length > 0) {
    console.warn(
      `WARN: ${skippedNoCodes.length} program(s) have no dwMajorCode — ` +
      `run map-dw-codes.js to populate them.  These will be skipped.\n`
    );
  }

  // Filter by --year
  if (yearArg) {
    programs = programs.filter(p => p.catalogYear === yearArg);
    if (programs.length === 0) die(`No programs found for --year=${yearArg}`);
  }

  // Apply --limit
  if (programs.length > LIMIT) programs = programs.slice(0, LIMIT);

  const total   = programs.length;
  const counts  = { ok: 0, skipped: 0, 'invalid-combo': 0, error: 0, dry: 0 };

  console.log(`\nBobcat Plus — DW What-If audit driver`);
  console.log(`Manifest:    ${MANIFEST}`);
  console.log(`Output dir:  ${OUT_DIR}`);
  console.log(`Log:         ${LOG_FILE}`);
  console.log(`Combos:      ${total}${DRY_RUN ? '  (DRY RUN)' : ''}`);
  if (yearArg) console.log(`Year filter: ${yearArg}`);
  if (isFinite(LIMIT)) console.log(`Limit:       ${LIMIT}`);
  console.log('');

  for (let i = 0; i < programs.length; i++) {
    const p = programs[i];

    const goals = [
      { code: 'MAJOR', value: p.dwMajorCode, catalogYear: '' },
    ];
    if (p.dwConcCode) {
      goals.push({ code: 'CONC', value: p.dwConcCode, catalogYear: '' });
    }

    const requestBody = {
      studentId:              auth.studentId,
      isIncludeInprogress:    true,
      isIncludePreregistered: true,
      isKeepCurriculum:       false,
      school:                 'UG',
      degree:                 p.degree,
      catalogYear:            p.dwCatalogYear,
      goals,
      classes: [],
    };

    const concPart = p.dwConcCode ? p.dwConcCode : 'nocon';
    const label    = `${p.catalogYear}-${p.degree}-${p.dwMajorCode}-${concPart}`;
    const outPath  = path.join(OUT_DIR, `audit-${label}.json`);

    const outcome = await runCombo({
      auth,
      requestBody,
      outPath,
      label,
      index:         i + 1,
      total,
      requestedConc: !!p.dwConcCode,
    });

    counts[outcome] = (counts[outcome] || 0) + 1;

    if (outcome !== 'skipped' && outcome !== 'dry' && i + 1 < programs.length) {
      await sleep(RATE_DELAY_MS);
    }
  }

  printSummary(counts, total);
}

// ─── Doubled-combos run ───────────────────────────────────────────────────────

async function runDoubled(auth) {
  ensureDir(DOUBLED_DIR);

  const combos = DOUBLED_COMBOS;
  const total  = combos.length;
  const counts = { ok: 0, skipped: 0, 'invalid-combo': 0, error: 0, dry: 0 };

  console.log(`\nBobcat Plus — DW What-If audit driver (doubled combos)`);
  console.log(`Output dir:  ${DOUBLED_DIR}`);
  console.log(`Combos:      ${total}${DRY_RUN ? '  (DRY RUN)' : ''}\n`);

  for (let i = 0; i < combos.length; i++) {
    const c = combos[i];

    const goals = c.majors.map((m, idx) => {
      const entries = [{ code: 'MAJOR', value: m, catalogYear: '' }];
      const conc = (c.concs || [])[idx];
      if (conc) entries.push({ code: 'CONC', value: conc, catalogYear: '' });
      return entries;
    }).flat();

    const requestBody = {
      studentId:              auth.studentId,
      isIncludeInprogress:    true,
      isIncludePreregistered: true,
      isKeepCurriculum:       false,
      school:                 'UG',
      degree:                 c.degree,
      catalogYear:            c.catalogYear,
      goals,
      classes: [],
    };

    const outPath = path.join(DOUBLED_DIR, `audit-${c.label}.json`);

    const outcome = await runCombo({
      auth,
      requestBody,
      outPath,
      label:         c.label,
      index:         i + 1,
      total,
      requestedConc: (c.concs || []).some(Boolean),
    });

    counts[outcome] = (counts[outcome] || 0) + 1;

    if (outcome !== 'skipped' && outcome !== 'dry' && i + 1 < combos.length) {
      await sleep(RATE_DELAY_MS);
    }
  }

  printSummary(counts, total);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function printSummary(counts, total) {
  console.log('\n── Summary ─────────────────────────────────');
  console.log(`  Total:         ${total}`);
  console.log(`  ok:            ${counts.ok      || 0}`);
  console.log(`  skipped:       ${counts.skipped || 0}`);
  console.log(`  invalid-combo: ${counts['invalid-combo'] || 0}`);
  console.log(`  error:         ${counts.error   || 0}`);
  if (counts.dry) console.log(`  dry:           ${counts.dry}`);
  console.log(`────────────────────────────────────────────`);
  if (!counts.dry) console.log(`Log:  ${LOG_FILE}`);
  console.log('');
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err.stack || err.message}\n`);
  process.exit(1);
});
