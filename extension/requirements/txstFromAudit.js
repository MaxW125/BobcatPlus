// Bobcat Plus — Texas State DegreeWorks → RequirementGraph adapter (Phase 1).
//
// This is the *only* place that knows the shape of a TXST DegreeWorks audit.
// It consumes the raw JSON returned by
// `dw-prod.ec.txstate.edu/responsiveDashboard/api/audit` and returns a
// `RequirementGraph` as defined in `docs/plans/requirement-graph.md`.
//
// Scope boundary — things that DO NOT belong in this file:
//   • any fetch/network call (that lives in `background.js`)
//   • any scoring, ranking, or LLM prompts
//   • any scheduling logic
//   • any university other than TXST (when #2 ships, refactor here)
//
// It pairs with `./graph.js` for node primitives and is loaded in both the
// service worker (via `importScripts`) and Node unit tests (via `require`).

(function (global) {
  "use strict";

  // Pull in graph primitives. In Node tests, fall back to require.
  let g = global && global.BPReq;
  if ((!g || !g.KIND) && typeof require === "function") {
    try { g = require("./graph"); } catch (_) { /* no-op */ }
  }
  if (!g || !g.KIND) {
    throw new Error("txstFromAudit.js requires graph.js to be loaded first");
  }

  const {
    KIND, OPTION_KIND, BLOCK_TYPE,
    block, allOf, chooseN, courseQuant, blocktypeRef, status,
    concreteOption, subjectWildcardOption, attributeWildcardOption,
    createGraph,
  } = g;

  // ─── block-type inference ────────────────────────────────────────────────
  //
  // DegreeWorks stores block classification in `requirementType` +
  // `requirementValue` but TXST's values are idiosyncratic; we synthesize
  // from the header label + value when possible and fall back to OTHER.

  function inferBlockType(dwBlock) {
    const rt = String(dwBlock.requirementType || "").toUpperCase();
    const rv = String(dwBlock.requirementValue || "").toUpperCase();
    const title = String(dwBlock.title || "").toLowerCase();
    if (rt === "DEGREE" || title.startsWith("degree in ")) return BLOCK_TYPE.DEGREE;
    if (rt === "MAJOR" || title.startsWith("major in "))   return BLOCK_TYPE.MAJOR;
    if (rt === "MINOR" || title.startsWith("minor in "))   return BLOCK_TYPE.MINOR;
    if (/core/i.test(title) || /CORE/.test(rv))            return BLOCK_TYPE.CORE;
    return BLOCK_TYPE.OTHER;
  }

  // A referential-only block exists purely for display (TXST Core Curriculum
  // shows up twice: once as the real block the student has to satisfy, and
  // once as a read-only mirror). We skip the latter.
  function isReferentialOnly(dwBlock) {
    const title = String(dwBlock.title || "").toLowerCase();
    return /referential only/.test(title);
  }

  // ─── course-option mapping ───────────────────────────────────────────────

  function mapCourseOption(raw) {
    const disc = String(raw.discipline || "");
    const num  = String(raw.number || "");
    const hide = raw.hideFromAdvice === "Yes";
    const withClauses = Array.isArray(raw.withArray) ? raw.withArray.slice() : [];
    // Attribute-only wildcard: @ @ with ATTRIBUTE=...
    if (disc === "@" && num === "@") {
      return attributeWildcardOption({ withClauses });
    }
    // Subject wildcard with optional level prefix: "CS 4@" or "BIO @" etc.
    if (num.endsWith("@")) {
      const prefix = num.slice(0, -1);
      return subjectWildcardOption({ discipline: disc, numberPrefix: prefix, withClauses });
    }
    return concreteOption({
      discipline: disc, number: num, withClauses, hideFromUi: hide,
    });
  }

  function mapExceptOptions(exceptField) {
    // Historically DW returns `except` as a single object (with courseArray
    // inside) or, more rarely, as an array. Normalize both.
    if (!exceptField) return [];
    const rawList = Array.isArray(exceptField)
      ? exceptField.flatMap((e) => (e && e.courseArray) || [])
      : (exceptField.courseArray || []);
    return rawList.map(mapCourseOption);
  }

  // ─── rule conversion ─────────────────────────────────────────────────────

  function convertRule(rule, blockIndex) {
    switch (rule.ruleType) {
      case "Block":      return convertBlockRef(rule);
      case "Blocktype":  return convertBlocktypeRef(rule);
      case "Subset":     return convertSubset(rule, blockIndex);
      case "Group":      return convertGroup(rule, blockIndex);
      case "Course":     return convertCourse(rule);
      case "Complete":
      case "Incomplete":
      case "Noncourse":  return convertStatus(rule);
      case "IfStmt":     return convertIfStmt(rule, blockIndex);
      default:
        // Unknown rule types become a status node; Phase 1.5 can widen this
        // when we hit real-world examples.
        return status({
          id: rule.nodeId || rule.ruleId || "",
          label: rule.label || `Unknown rule type ${rule.ruleType}`,
          state: "incomplete",
          extras: { _raw: { ruleType: rule.ruleType } },
        });
    }
  }

  function convertBlockRef(rule) {
    const req = rule.requirement || {};
    return blocktypeRef({
      id:          rule.nodeId || rule.ruleId || "",
      label:       rule.label || "",
      targetKind:  "block",
      targetValue: req.value || req.type || null,
    });
  }

  function convertBlocktypeRef(rule) {
    const req = rule.requirement || {};
    return blocktypeRef({
      id:          rule.nodeId || rule.ruleId || "",
      label:       rule.label || "",
      targetKind:  "blocktype",
      targetValue: req.type || null,
    });
  }

  function convertSubset(rule, blockIndex) {
    return allOf({
      id:       rule.nodeId || rule.ruleId || "",
      label:    rule.label || "",
      children: (rule.ruleArray || []).map((r) => convertRule(r, blockIndex)),
      extras:   { percentComplete: _pct(rule) },
    });
  }

  function convertGroup(rule, blockIndex) {
    const req = rule.requirement || {};
    const total = parseInt(req.numberOfRules, 10) || (rule.ruleArray || []).length;
    // `numberOfGroups` is the authoritative N. DegreeWorks sometimes omits
    // it (treat as AllOf in that case, matching its own UI behavior).
    const rawN = parseInt(req.numberOfGroups, 10);
    const n = Number.isFinite(rawN) && rawN >= 1 ? rawN : total;
    const children = (rule.ruleArray || []).map((r) => convertRule(r, blockIndex));
    if (n >= total) {
      // Collapse to AllOf so downstream consumers don't have to special-case
      // "ChooseN where N === total children".
      return allOf({
        id:       rule.nodeId || rule.ruleId || "",
        label:    rule.label || "",
        children,
        extras:   { percentComplete: _pct(rule), _collapsedFromGroup: true },
      });
    }
    return chooseN({
      id:       rule.nodeId || rule.ruleId || "",
      label:    rule.label || "",
      n,
      children,
      extras:   { percentComplete: _pct(rule) },
    });
  }

  function convertCourse(rule) {
    const req = rule.requirement || {};
    const classes = _posInt(req.classesBegin);
    const credMin = _posInt(req.creditsBegin);
    const credMax = _posInt(req.creditsEnd);
    const take = {};
    if (classes) take.classes = classes;
    if (credMin != null) {
      take.credits = credMax != null && credMax !== credMin
        ? { min: credMin, max: credMax }
        : { min: credMin };
    }
    const mode = take.classes && take.credits ? "both"
               : take.credits ? "credits"
               : "classes";
    const options = (req.courseArray || []).map(mapCourseOption);
    const exceptOptions = mapExceptOptions(req.except);
    const applied = _collectApplied(rule);
    const remaining = _deriveRemaining(take, applied, rule);
    return courseQuant({
      id:       rule.nodeId || rule.ruleId || "",
      label:    rule.label || "",
      take,
      mode,
      ordered:  req.connector === "+",
      options,
      exceptOptions,
      applied,
      remaining,
      extras: {
        percentComplete:   _pct(rule),
        classCreditOp:     req.classCreditOperator || null,
        decide:            req.decide || null,
        qualifiers:        req.qualifierArray || [],
        hideFromUi:        rule.hideFromAdvice === "Yes",
      },
    });
  }

  function convertStatus(rule) {
    const pct = _pct(rule);
    return status({
      id:    rule.nodeId || rule.ruleId || "",
      label: rule.label || "",
      state: pct != null && pct >= 100 ? "complete" : "incomplete",
      extras: { percentComplete: pct },
    });
  }

  function convertIfStmt(rule, blockIndex) {
    // DW conditional. We can't truly evaluate "if transferred this, then
    // that". Pragmatic Phase-1 stance: inline IfPart children, swallow
    // ElsePart children. If this turns out to matter we'll enrich.
    const ifChildren = (rule.ruleArray || []).filter(
      (c) => c.ifElsePart !== "ElsePart",
    );
    if (ifChildren.length === 1) return convertRule(ifChildren[0], blockIndex);
    return allOf({
      id:       rule.nodeId || rule.ruleId || "",
      label:    rule.label || "",
      children: ifChildren.map((r) => convertRule(r, blockIndex)),
      extras:   { _fromIfStmt: true },
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  function _posInt(x) {
    if (x === undefined || x === null || x === "") return undefined;
    const n = Number(x);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  function _pct(rule) {
    const p = rule.percentComplete;
    if (p === undefined || p === null || p === "") return undefined;
    const n = Number(p);
    return Number.isFinite(n) ? n : undefined;
  }

  function _collectApplied(rule) {
    const arr = (rule.classesAppliedToRule && rule.classesAppliedToRule.classArray) || [];
    return arr.map((c) => ({
      course:  { discipline: String(c.discipline || ""), number: String(c.number || "") },
      credits: Number(c.credits) || 0,
      grade:   String(c.letterGrade || ""),
      term:    String(c.term || ""),
    }));
  }

  function _deriveRemaining(take, applied, rule) {
    const rem = {};
    if (take.classes != null) {
      rem.classes = Math.max(0, take.classes - applied.filter((a) => a.grade !== "IP").length);
    }
    if (take.credits && typeof take.credits.min === "number") {
      const earned = applied
        .filter((a) => a.grade !== "IP")
        .reduce((s, a) => s + (Number.isFinite(a.credits) ? a.credits : 0), 0);
      rem.credits = Math.max(0, take.credits.min - earned);
    }
    // If the rule itself claims 100% done, trust that — DegreeWorks has
    // exception rules (substitutions, waivers) we don't reimplement.
    const p = _pct(rule);
    if (p != null && p >= 100) {
      if ("classes" in rem) rem.classes = 0;
      if ("credits" in rem) rem.credits = 0;
    }
    return rem;
  }

  // ─── top-level: audit → graph ────────────────────────────────────────────

  function convertBlock(dwBlock, blockIndex) {
    const children = (dwBlock.ruleArray || []).map((r) => convertRule(r, blockIndex));
    return block({
      id:        dwBlock.requirementId || "",
      label:     dwBlock.title || "",
      blockType: inferBlockType(dwBlock),
      children,
      extras: {
        percentComplete:  Number(dwBlock.percentComplete) || 0,
        catalogYear:      dwBlock.catalogYear || "",
        requirementValue: dwBlock.requirementValue || "",
      },
    });
  }

  function buildGraphFromAudit(audit) {
    if (!audit || !Array.isArray(audit.blockArray)) {
      throw new Error("buildGraphFromAudit: audit.blockArray missing");
    }
    const blocks = audit.blockArray.filter((b) => !isReferentialOnly(b));
    // Pre-index blocks so BlocktypeRef nodes could later be resolved without
    // another pass. We populate `requirementValue → id` for Block refs and
    // `inferredBlockType → id` for Blocktype refs.
    const blockIndex = {
      byValue:     new Map(),
      byBlockType: new Map(),
    };
    for (const b of blocks) {
      if (b.requirementValue) blockIndex.byValue.set(String(b.requirementValue), b.requirementId || "");
      const bt = inferBlockType(b);
      if (!blockIndex.byBlockType.has(bt)) blockIndex.byBlockType.set(bt, []);
      blockIndex.byBlockType.get(bt).push(b.requirementId || "");
    }
    const roots = blocks.map((b) => convertBlock(b, blockIndex));
    const exceptions = Array.isArray(audit.exceptionList) ? audit.exceptionList.slice() : [];
    const meta = {
      studentId:  audit.auditHeader && audit.auditHeader.studentId || "",
      catalog:    audit.auditHeader && audit.auditHeader.catalogYear || "",
      snapshotAt: new Date().toISOString(),
    };
    return createGraph({ roots, exceptions, meta });
  }

  // ─── compat layer: graph → legacy `eligible[]`-ish list ─────────────────
  //
  // This lets us land the parser without touching the solver. Downstream code
  // continues to receive `{subject, courseNumber, label}` entries; wildcards
  // are surfaced as a parallel list so a later call site can resolve them via
  // DegreeWorks' `courseInformation` endpoint. Exceptions are excluded from
  // concrete-entry output by exact `discipline|number` match.

  function deriveEligible(graph) {
    const entries = [];
    const wildcards = [];
    const seen = new Set();

    for (const { node, ancestorLabels } of _leaves(graph)) {
      if (node.kind !== KIND.COURSE_QUANT) continue;
      const pct = typeof node.percentComplete === "number" ? node.percentComplete : null;
      if (pct != null && pct >= 100) continue;
      // "Done" means every declared threshold is at zero. A threshold that was
      // never declared (e.g. `credits` when only `classes` was set) does not
      // get interpreted as "zero remaining" — undefined means "N/A".
      const rem = node.remaining || {};
      const classesDone = !("classes" in rem) || rem.classes === 0;
      const creditsDone = !("credits" in rem) || rem.credits === 0;
      if (classesDone && creditsDone) continue;

      const exceptSet = new Set(
        node.exceptOptions
          .filter((o) => o.kind === OPTION_KIND.CONCRETE)
          .map((o) => `${o.course.discipline}|${o.course.number}`),
      );
      const exceptWildcards = node.exceptOptions.filter(
        (o) => o.kind !== OPTION_KIND.CONCRETE,
      );

      for (const opt of node.options) {
        if (opt.kind === OPTION_KIND.CONCRETE) {
          const key = `${opt.course.discipline}|${opt.course.number}`;
          if (exceptSet.has(key)) continue;
          if (seen.has(key)) continue; // many-to-many collapse, preserved for Phase 1.5
          seen.add(key);
          entries.push({
            subject:      opt.course.discipline,
            courseNumber: opt.course.number,
            label:        node.label || "",
            parentLabels: ancestorLabels.slice(),
            hideFromUi:   !!opt.hideFromUi,
            ruleId:       node.id,
          });
          continue;
        }
        // Wildcards — surface separately; a caller with access to DegreeWorks
        // `courseInformation` can resolve them. Concrete fallback entries in
        // the same option list (usually hideFromAdvice=Yes siblings) are
        // already captured above, so the immediate UX stays intact.
        wildcards.push({
          kind:           opt.kind,
          discipline:     opt.discipline || "@",
          numberPrefix:   opt.numberPrefix || "",
          withClauses:    opt.withClauses || [],
          ruleId:         node.id,
          ruleLabel:      node.label || "",
          parentLabels:   ancestorLabels.slice(),
          exceptOptions:  node.exceptOptions.slice(),
          exceptWildcards,
        });
      }
    }
    return { entries, wildcards };
  }

  function _leaves(graph) {
    return g.collectCourseLeaves(graph);
  }

  // ─── exports ─────────────────────────────────────────────────────────────

  const api = {
    buildGraphFromAudit,
    deriveEligible,
    // exposed for tests
    _internals: {
      inferBlockType,
      isReferentialOnly,
      mapCourseOption,
      mapExceptOptions,
      convertRule,
      convertCourse,
      convertGroup,
      convertSubset,
      convertBlock,
    },
  };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  global.BPReq = global.BPReq || {};
  Object.assign(global.BPReq, api);
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
