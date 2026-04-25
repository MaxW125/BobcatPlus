#!/usr/bin/env node
// scripts/shape/extract-shapes.js
//
// S4: walks every *.json under tests/fixtures/audits/ (recursive), collects
// distinct rule/block shape values and occurrence counts, and emits
// docs/plans/rule-shape-inventory.md.
//
// Usage:
//   node scripts/shape/extract-shapes.js            # write inventory markdown
//   node scripts/shape/extract-shapes.js --json     # dump raw counts to stdout
//
// Gate: run after at least one catalog year of what-if audits lands in
// tests/fixtures/audits/whatif/.  See docs/plans/rule-shape-discovery.md §4 S4.

'use strict';

const fs   = require('fs');
const path = require('path');

const FIXTURES_ROOT = path.join(__dirname, '../../tests/fixtures/audits');
const OUT_MD        = path.join(__dirname, '../../docs/plans/rule-shape-inventory.md');

// ─── Parser coverage tables ──────────────────────────────────────────────────
// Derived from extension/requirements/txstFromAudit.js (inferBlockType +
// convertRule switch).  Update here when the parser is extended (S5).

const HANDLED_REQ_TYPES = new Set(['DEGREE', 'MAJOR', 'MINOR', 'CORE', 'OTHER']);
// CONC/CERT/SPEC/TRACK/HONORS all fall through to BLOCK_TYPE.OTHER in inferBlockType.

const HANDLED_RULE_TYPES = new Set([
  'Block', 'Blocktype', 'Subset', 'Group',
  'Course', 'Complete', 'Incomplete', 'Noncourse', 'IfStmt',
]);

// ─── Collection helpers ──────────────────────────────────────────────────────

// Counter: value → { audits: Set<filename>, count: number }
function makeCounter() { return new Map(); }

function tally(counter, key, filename) {
  if (!counter.has(key)) counter.set(key, { audits: new Set(), count: 0 });
  const e = counter.get(key);
  e.audits.add(filename);
  e.count++;
}

// ─── Audit walker ────────────────────────────────────────────────────────────

function walkRules(rules, filename, state) {
  for (const rule of (rules || [])) {
    const rt = rule.ruleType;
    if (rt) tally(state.ruleTypes, rt, filename);

    const req = rule.requirement || {};

    if (rule.ifElsePart) tally(state.flags, 'ifElsePart', filename);

    if (req.classCreditOperator) tally(state.operators, req.classCreditOperator, filename);
    if (req.connector)           tally(state.connectors, req.connector, filename);
    if (req.numberOfGroups !== undefined) tally(state.flags, 'numberOfGroups', filename);
    if (req.numberOfRules  !== undefined) tally(state.flags, 'numberOfRules',  filename);

    for (const q of (req.qualifierArray || [])) {
      const qkey = q.name || q.code;
      if (qkey) tally(state.qualifiers, qkey, filename);
    }

    for (const exc of (req.exceptionArray || [])) {
      if (exc.type) tally(state.exceptions, exc.type, filename);
    }

    for (const c of (req.courseArray || [])) {
      const disc = (c.discipline || '').trim();
      const num  = (c.number     || '').trim();
      if (disc === '@') {
        // attribute-only or pure wildcard
        tally(state.coursePatterns, 'attrWildcard', filename);
      } else if (num.includes('@')) {
        // subject + number-prefix wildcard, e.g. "CS 4@"
        tally(state.coursePatterns, 'subjectWildcard', filename);
      } else if (/^[A-Z]{2,4}$/.test(num) || num === 'ELNA' || num === 'ELME') {
        // attribute-coded placeholder, e.g. "ENG ELNA"
        tally(state.coursePatterns, 'attributePlaceholder', filename);
      } else {
        tally(state.coursePatterns, 'concrete', filename);
      }

      if (c.withArray?.length) tally(state.flags, 'withArray', filename);
      if (c.hideFromAdvice)    tally(state.flags, 'hideFromAdvice:course', filename);
    }

    if (rule.hideFromAdvice) tally(state.flags, 'hideFromAdvice:rule', filename);

    // Recurse into nested rules
    walkRules(rule.ruleArray,        filename, state);
    walkRules(rule.ifPart?.ruleArray,  filename, state);
    walkRules(rule.elsePart?.ruleArray, filename, state);
  }
}

function processAudit(filepath, state) {
  const filename = path.relative(FIXTURES_ROOT, filepath);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    process.stderr.write(`WARN: could not parse ${filepath}: ${e.message}\n`);
    return;
  }

  state.auditCount++;

  for (const block of (data.blockArray || [])) {
    const rt = String(block.requirementType || '').toUpperCase();
    if (rt) tally(state.reqTypes, rt, filename);
    walkRules(block.ruleArray, filename, state);
  }

  // Top-level exceptionList
  const excArr = Array.isArray(data.exceptionList)
    ? data.exceptionList
    : (data.exceptionList?.exceptionArray || []);
  for (const exc of excArr) {
    if (exc.type) tally(state.exceptions, exc.type, filename);
  }
}

// ─── File discovery ──────────────────────────────────────────────────────────

function findJsonFiles(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())                  findJsonFiles(full, out);
    else if (entry.name.endsWith('.json'))     out.push(full);
  }
}

// ─── Markdown rendering ──────────────────────────────────────────────────────

function row(...cells) {
  return '| ' + cells.join(' | ') + ' |';
}

function table(headers, rows) {
  const sep = headers.map(() => '---');
  return [
    row(...headers),
    row(...sep),
    ...rows.map(r => row(...r)),
  ].join('\n');
}

function handledMark(handled) { return handled ? '✅' : '⚠️ unhandled'; }

function renderCounter(counter, handledSet, totalAudits) {
  const sorted = [...counter.entries()].sort((a, b) => b[1].count - a[1].count);
  const rows = sorted.map(([key, { audits, count }]) => {
    const pct = Math.round((audits.size / totalAudits) * 100);
    const handled = handledSet ? handledMark(handledSet.has(key)) : '';
    const cols = [
      `\`${key}\``,
      String(audits.size),
      `${pct}%`,
      String(count),
    ];
    if (handledSet) cols.push(handled);
    return cols;
  });
  const headers = ['Value', 'Audits', '% audits', 'Occurrences'];
  if (handledSet) headers.push('Parser');
  return table(headers, rows);
}

function renderSimpleCounter(counter, totalAudits) {
  const sorted = [...counter.entries()].sort((a, b) => b[1].count - a[1].count);
  const rows = sorted.map(([key, { audits, count }]) => {
    const pct = Math.round((audits.size / totalAudits) * 100);
    return [`\`${key}\``, String(audits.size), `${pct}%`, String(count)];
  });
  return table(['Value', 'Audits', '% audits', 'Occurrences'], rows);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const JSON_MODE = process.argv.includes('--json');

  const files = [];
  findJsonFiles(FIXTURES_ROOT, files);

  if (files.length === 0) {
    process.stderr.write(`No audit fixtures found under ${FIXTURES_ROOT}\n`);
    process.exit(1);
  }

  const state = {
    auditCount:    0,
    reqTypes:      makeCounter(),
    ruleTypes:     makeCounter(),
    qualifiers:    makeCounter(),
    exceptions:    makeCounter(),
    coursePatterns: makeCounter(),
    operators:     makeCounter(),
    connectors:    makeCounter(),
    flags:         makeCounter(),
  };

  for (const f of files) processAudit(f, state);

  const N = state.auditCount;
  process.stderr.write(`Processed ${N} audits from ${files.length} files.\n`);

  if (JSON_MODE) {
    const out = {};
    for (const [k, v] of Object.entries(state)) {
      if (k === 'auditCount') { out[k] = v; continue; }
      out[k] = Object.fromEntries(
        [...v.entries()].map(([key, { audits, count }]) => [key, { audits: audits.size, count }])
      );
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const lines = [];
  const ts = new Date().toISOString().slice(0, 10);

  lines.push(`# Rule-Shape Inventory`);
  lines.push('');
  lines.push(`Generated ${ts} from **${N} audits** (${files.length} fixture files).`);
  lines.push(`Fixture root: \`tests/fixtures/audits/\``);
  lines.push('');
  lines.push('Parser column: ✅ = handled by current `txstFromAudit.js`; ⚠️ = falls through to default/OTHER.');
  lines.push('');

  lines.push('## Block `requirementType`');
  lines.push('');
  lines.push(renderCounter(state.reqTypes, HANDLED_REQ_TYPES, N));
  lines.push('');

  lines.push('## Rule `ruleType`');
  lines.push('');
  lines.push(renderCounter(state.ruleTypes, HANDLED_RULE_TYPES, N));
  lines.push('');

  lines.push('## `qualifierArray[].code`');
  lines.push('');
  if (state.qualifiers.size === 0) {
    lines.push('_None found in current fixtures._');
  } else {
    lines.push(renderSimpleCounter(state.qualifiers, N));
  }
  lines.push('');

  lines.push('## `exceptionArray[].type`');
  lines.push('');
  if (state.exceptions.size === 0) {
    lines.push('_None found in current fixtures._');
  } else {
    lines.push(renderSimpleCounter(state.exceptions, N));
  }
  lines.push('');

  lines.push('## Course array patterns');
  lines.push('');
  lines.push(renderSimpleCounter(state.coursePatterns, N));
  lines.push('');

  lines.push('## `classCreditOperator` values');
  lines.push('');
  if (state.operators.size === 0) {
    lines.push('_None found._');
  } else {
    lines.push(renderSimpleCounter(state.operators, N));
  }
  lines.push('');

  lines.push('## `connector` values');
  lines.push('');
  if (state.connectors.size === 0) {
    lines.push('_None found._');
  } else {
    lines.push(renderSimpleCounter(state.connectors, N));
  }
  lines.push('');

  lines.push('## Structural flags');
  lines.push('');
  lines.push('Presence counts — how many audits contain at least one instance.');
  lines.push('');
  lines.push(renderSimpleCounter(state.flags, N));
  lines.push('');

  lines.push('## Unhandled shapes (S5 to-do list)');
  lines.push('');
  lines.push('Shapes seen in fixtures that fall through to the `default` branch or `BLOCK_TYPE.OTHER`:');
  lines.push('');
  const unhandledReq  = [...state.reqTypes.keys()].filter(k => !HANDLED_REQ_TYPES.has(k));
  const unhandledRule = [...state.ruleTypes.keys()].filter(k => !HANDLED_RULE_TYPES.has(k));
  if (unhandledReq.length === 0 && unhandledRule.length === 0) {
    lines.push('_All shapes in current fixtures are handled. Run against full what-if dump for a complete picture._');
  } else {
    if (unhandledReq.length) {
      lines.push('**requirementType** (falls to `BLOCK_TYPE.OTHER`): ' +
        unhandledReq.map(k => `\`${k}\``).join(', '));
    }
    if (unhandledRule.length) {
      lines.push('**ruleType** (falls to status default): ' +
        unhandledRule.map(k => `\`${k}\``).join(', '));
    }
  }
  lines.push('');

  const md = lines.join('\n');
  fs.writeFileSync(OUT_MD, md, 'utf8');
  process.stderr.write(`Wrote ${OUT_MD}\n`);
}

main();
