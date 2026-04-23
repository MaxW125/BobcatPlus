// Bobcat Plus — RequirementGraph primitives (Phase 1, TXST-only).
//
// This module is *pure data*: node factories, validators, traversal helpers.
// It knows nothing about DegreeWorks. A separate adapter
// (`txstFromAudit.js`) is the sole producer; downstream consumers
// (`scheduleGenerator.js`, eventually the solver) treat the graph as opaque.
//
// Shape defined in `docs/requirement-graph-rfc.md`. Any type change here must
// land a companion RFC update in the same PR.
//
// Dual-export: usable both in the extension runtime (attaches to
// `globalThis.BPReq`) and in Node unit tests (`module.exports`).

(function (global) {
  "use strict";

  // ─── node kinds ──────────────────────────────────────────────────────────

  const KIND = Object.freeze({
    BLOCK:        "block",
    ALL_OF:       "allOf",
    CHOOSE_N:     "chooseN",
    COURSE_QUANT: "courseQuant",
    COURSE_SLOT:  "courseSlot",
    BLOCKTYPE_REF:"blocktypeRef",
    STATUS:       "status",
  });

  const OPTION_KIND = Object.freeze({
    CONCRETE:           "concrete",
    SUBJECT_WILDCARD:   "subjectWildcard",
    ATTRIBUTE_WILDCARD: "attributeWildcard",
  });

  const BLOCK_TYPE = Object.freeze({
    DEGREE: "DEGREE",
    MAJOR:  "MAJOR",
    MINOR:  "MINOR",
    CORE:   "CORE",
    OTHER:  "OTHER",
  });

  // ─── factories ───────────────────────────────────────────────────────────
  //
  // All factories return plain objects. No prototype chains, no classes —
  // keeps the graph trivially JSON-serializable for tracing + debugging.

  function _base(id, label, extras) {
    return Object.assign(
      { id: String(id || ""), label: String(label || "") },
      extras || {},
    );
  }

  function block({ id, label, blockType, children = [], extras = {} }) {
    return Object.assign(_base(id, label, extras), {
      kind:      KIND.BLOCK,
      blockType: blockType || BLOCK_TYPE.OTHER,
      children:  children.slice(),
    });
  }

  function allOf({ id, label, children = [], extras = {} }) {
    return Object.assign(_base(id, label, extras), {
      kind:     KIND.ALL_OF,
      children: children.slice(),
    });
  }

  function chooseN({ id, label, n, children = [], extras = {} }) {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`chooseN.n must be positive integer, got ${n}`);
    }
    return Object.assign(_base(id, label, extras), {
      kind:     KIND.CHOOSE_N,
      n,
      children: children.slice(),
    });
  }

  function courseQuant({
    id, label, take, mode, ordered, options, exceptOptions, applied, remaining,
    extras = {},
  }) {
    return Object.assign(_base(id, label, extras), {
      kind:          KIND.COURSE_QUANT,
      take:          take || {},
      mode:          mode || "classes",
      ordered:       !!ordered,
      options:       (options || []).slice(),
      exceptOptions: (exceptOptions || []).slice(),
      applied:       (applied || []).slice(),
      remaining:     remaining || {},
    });
  }

  function courseSlot({ id, label, course, extras = {} }) {
    return Object.assign(_base(id, label, extras), {
      kind:   KIND.COURSE_SLOT,
      course,
    });
  }

  function blocktypeRef({ id, label, targetKind, targetValue, extras = {} }) {
    return Object.assign(_base(id, label, extras), {
      kind:        KIND.BLOCKTYPE_REF,
      targetKind:  targetKind || null,
      targetValue: targetValue || null,
    });
  }

  function status({ id, label, state, extras = {} }) {
    return Object.assign(_base(id, label, extras), {
      kind:  KIND.STATUS,
      state: state === "complete" ? "complete" : "incomplete",
    });
  }

  // ─── options ─────────────────────────────────────────────────────────────

  function concreteOption({ discipline, number, withClauses, hideFromUi }) {
    return {
      kind:        OPTION_KIND.CONCRETE,
      course:      { discipline: String(discipline || ""), number: String(number || "") },
      withClauses: withClauses || [],
      hideFromUi:  !!hideFromUi,
    };
  }

  function subjectWildcardOption({ discipline, numberPrefix, withClauses }) {
    return {
      kind:         OPTION_KIND.SUBJECT_WILDCARD,
      discipline:   String(discipline || ""),
      numberPrefix: String(numberPrefix || ""),
      withClauses:  withClauses || [],
    };
  }

  function attributeWildcardOption({ withClauses }) {
    return {
      kind:        OPTION_KIND.ATTRIBUTE_WILDCARD,
      withClauses: withClauses || [],
    };
  }

  // ─── traversal ───────────────────────────────────────────────────────────

  function walk(node, visit, path = []) {
    visit(node, path);
    const kids =
      node.kind === KIND.BLOCK ? node.children :
      node.kind === KIND.ALL_OF ? node.children :
      node.kind === KIND.CHOOSE_N ? node.children :
      [];
    for (let i = 0; i < kids.length; i++) {
      walk(kids[i], visit, path.concat(i));
    }
  }

  function walkGraph(graph, visit) {
    for (const root of graph.roots) walk(root, visit);
  }

  // Flatten the graph into every leaf that describes a takeable course (for the
  // compat shim that produces `eligible[]`). Non-leaf nodes are skipped. Caller
  // gets back `{ node, ownerChain }` so it can reconstruct rule labels.
  function collectCourseLeaves(graph) {
    const leaves = [];
    const stack = [];
    walkGraph(graph, (node, path) => {
      // Maintain a simple ancestor label chain by trimming to path depth.
      while (stack.length > path.length) stack.pop();
      stack.push(node);
      if (node.kind === KIND.COURSE_QUANT || node.kind === KIND.COURSE_SLOT) {
        leaves.push({
          node,
          ancestorLabels: stack.slice(0, -1).map((n) => n.label).filter(Boolean),
        });
      }
    });
    return leaves;
  }

  // Index every concrete course option to the owning leaves. Wildcards are NOT
  // resolved here — the caller expands them lazily via the DegreeWorks
  // `courseInformation` endpoint and adds them after resolution.
  function buildCourseIndex(graph) {
    const index = new Map();
    for (const { node } of collectCourseLeaves(graph)) {
      if (node.kind === KIND.COURSE_SLOT) {
        const key = courseKey(node.course);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(node);
        continue;
      }
      if (node.kind !== KIND.COURSE_QUANT) continue;
      for (const opt of node.options) {
        if (opt.kind !== OPTION_KIND.CONCRETE) continue;
        const key = courseKey(opt.course);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(node);
      }
    }
    return index;
  }

  function courseKey(courseRef) {
    return `${courseRef.discipline || ""}|${courseRef.number || ""}`;
  }

  // ─── graph container ─────────────────────────────────────────────────────

  function createGraph({ roots = [], exceptions = [], meta = {} } = {}) {
    const graph = {
      roots: roots.slice(),
      exceptions: exceptions.slice(),
      meta: Object.assign({}, meta),
      courseIndex: null,
    };
    graph.courseIndex = buildCourseIndex(graph);
    return graph;
  }

  // ─── invariant checks (used by tests + defensive parse) ─────────────────

  function validateGraph(graph) {
    const errors = [];
    if (!graph || !Array.isArray(graph.roots)) {
      errors.push("graph.roots must be an array");
      return errors;
    }
    walkGraph(graph, (node, path) => {
      if (!node || !node.kind) {
        errors.push(`node at ${path.join("/")} missing kind`);
        return;
      }
      if (node.kind === KIND.CHOOSE_N) {
        if (!Number.isInteger(node.n) || node.n < 1) {
          errors.push(`chooseN at ${path.join("/")} has invalid n=${node.n}`);
        }
        if (node.n > node.children.length) {
          errors.push(
            `chooseN at ${path.join("/")} requires n=${node.n} but has only ${node.children.length} children`,
          );
        }
      }
      if (node.kind === KIND.COURSE_QUANT) {
        if (!node.take.classes && !node.take.credits) {
          errors.push(
            `courseQuant "${node.label}" has neither classes nor credits target`,
          );
        }
        if (node.take.credits) {
          const c = node.take.credits;
          if (!(typeof c.min === "number") || c.min < 0) {
            errors.push(
              `courseQuant "${node.label}" credits.min invalid: ${c.min}`,
            );
          }
        }
      }
    });
    return errors;
  }

  // ─── exports ─────────────────────────────────────────────────────────────

  const api = {
    KIND,
    OPTION_KIND,
    BLOCK_TYPE,
    // factories
    block,
    allOf,
    chooseN,
    courseQuant,
    courseSlot,
    blocktypeRef,
    status,
    concreteOption,
    subjectWildcardOption,
    attributeWildcardOption,
    // traversal + container
    createGraph,
    walk,
    walkGraph,
    collectCourseLeaves,
    buildCourseIndex,
    courseKey,
    // validation
    validateGraph,
  };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  global.BPReq = global.BPReq || {};
  Object.assign(global.BPReq, api);
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
