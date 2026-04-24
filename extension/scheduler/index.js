// ============================================================
// 13. ORCHESTRATOR — handleUserTurn
//
// Action types the extension must handle:
//   show_context_recap  { recap, ambiguities, confidence }
//   show_message        { text, followUp }
//   show_schedules      { summary, schedules[], relaxations, followUp }
//   show_rejected_candidates { candidates[] }
//   show_relaxation_notice   { relaxations[] }
//   show_infeasible     { message, suggestions[] }
//   add_calendar_block  { block }
//   add_avoid_day       { day }
//   lock_course         { crn }
//   unlock_course       { crn }
//   add_suggested_course { reference }
//
// Trace events fire via onTrace(entry, allEntries) in real time.
// ============================================================

import { createTrace } from "./trace.js";
import { mergeCalendarBlocks, compressForSolver } from "./profile.js";
import { validateSchedule } from "./validate.js";
import { solveWithRelaxation } from "./solver/solver.js";
import { rankSchedules } from "./solver/rank.js";
import { callIntent, calibrateIntentWeights } from "./llm/intent.js";
import { callAffinity, clearAffinityCache } from "./llm/affinity.js";
import { callRationales, buildRationaleFacts } from "./llm/rationale.js";
import { callAdvisor } from "./llm/advisor.js";
import { computeArchetypeVector, computeArchetypeDistance, computePenaltyEffectiveness } from "./metrics.js";
import { _infeasibleSuggestions } from "./solver/solver.js";

function _validateCrns(crns, rawData) {
  const eligibleCrns = new Set();
  for (const c of rawData.eligible || []) {
    for (const s of c.sections || []) eligibleCrns.add(String(s.courseReferenceNumber));
  }
  return (crns || []).filter((crn) => eligibleCrns.has(String(crn)));
}

// Phase 0: top-20 candidates with deltas so the debug pane can show
// why each pick beat its runner-ups. Deltas are vs the top-1 under the
// scheduler's actual chosen vector for that schedule (not a global max).
function _buildRankBreakdown(topSchedules, allScored, preferences) {
  const VECTOR_ORDER = [
    { key: "scoreAffinity", vec: "affinity" },
    { key: "scoreOnline",   vec: "online" },
    { key: "scoreBalanced", vec: "balanced" },
  ];
  const TOP_N = 20;
  const by = {};
  for (const { key, vec } of VECTOR_ORDER) {
    const sorted = allScored.slice().sort((a, b) => b[key] - a[key]);
    const topScore = sorted[0] ? sorted[0][key] : 0;
    by[vec] = sorted.slice(0, TOP_N).map((s, i) => ({
      rank: i + 1,
      score: +s[key].toFixed(4),
      delta: +(topScore - s[key]).toFixed(4),
      courses: s.result.picks.map((p) => p.courseObj.course),
      crns:    s.result.picks.map((p) => p.section.crn),
      credits: s.result.credits,
      breakdown: s.scoreBreakdown[vec],
      metrics: s.metrics,
    }));
  }
  const pickedLike = topSchedules.map((t) => ({
    label: t.label,
    courses: t.result.picks.map((p) => ({
      days: p.section.days || [],
      start: p.section.start,
      end: p.section.end,
      online: !!p.section.online,
      credits: p.section.credits ?? 3,
    })),
  }));
  return {
    totalCandidates: allScored.length,
    picked: topSchedules.map((t) => ({
      label: t.label,
      courses: t.result.picks.map((p) => p.courseObj.course),
      crns:    t.result.picks.map((p) => p.section.crn),
      breakdown: t.scoreBreakdown,
      metrics: t.metrics,
    })),
    top20: by,
    archetype: {
      vectors: pickedLike.map(computeArchetypeVector),
      distance: computeArchetypeDistance(pickedLike),
    },
    penaltyEffectiveness: computePenaltyEffectiveness({
      topSchedules, allScored, preferences, vectorKey: "scoreAffinity",
    }),
  };
}

function _schedulesForAction(topSchedules, rationales, affinityScores, preferences) {
  return topSchedules.map((top) => {
    const r = rationales.find((x) => x.label === top.label);
    const facts = buildRationaleFacts(top, affinityScores, preferences || {});
    return {
      label: top.label,
      tagline: top.tagline,
      rationale: r?.text || top.tagline,
      totalCredits: top.result.credits,
      metrics: top.metrics,
      scoreBreakdown: top.scoreBreakdown || null,
      honoredPreferences: facts.honored,
      unhonoredPreferences: facts.unhonored,
      courses: top.result.picks.map((p) => ({
        course: p.courseObj.course,
        title: p.courseObj.title,
        crn: p.section.crn,
        days: p.section.days || [],
        start: p.section.start,
        end: p.section.end,
        online: p.section.online,
        requirementSatisfied: p.courseObj.requirementLabel,
        instructor: p.section.instructor,
        credits: p.section.credits ?? 3,
        affinity: affinityScores[p.courseObj.course]?.score ?? 0.5,
        affinityReason: affinityScores[p.courseObj.course]?.reason ?? "",
      })),
    };
  });
}

function _rejectedFromSolver(eligible, topSchedules, affinityScores, limit = 4) {
  // Surface high-affinity courses not in any top schedule as "also considered"
  const taken = new Set();
  for (const t of topSchedules)
    for (const p of t.result.picks) taken.add(p.courseObj.course);
  const candidates = [];
  for (const c of eligible) {
    if (taken.has(c.course)) continue;
    const score = affinityScores[c.course]?.score ?? 0.5;
    if (score < 0.6) continue;
    // Use the first viable section for display
    const sec = c.sections.find((s) => s.seatsAvailable > 0) || c.sections[0];
    if (!sec) continue;
    candidates.push({
      course: c.course,
      crn: sec.crn,
      days: sec.days || [],
      start: sec.start,
      end: sec.end,
      wouldSatisfy: c.requirementLabel,
      reason: `Match ${score.toFixed(2)} for your goals — ${affinityScores[c.course]?.reason || ""}`,
      affinity: score,
    });
  }
  return candidates.sort((a, b) => b.affinity - a.affinity).slice(0, limit);
}

export async function handleUserTurn({
  userMessage,
  rawData,
  studentProfile,
  conversationHistory = [],
  lockedCourses = [],
  ragChunks = [],
  apiKey,
  onTrace = () => {},
}) {
  const trace = createTrace(onTrace);
  const actions = [];

  // Reset career-signal state per turn so stale affinity scores from a
  // prior prompt can't bias this turn's ranking. The solver + affinity
  // pipeline re-derives everything from the current message's intent.
  clearAffinityCache();

  // Stage 1: Intent
  const intent = await callIntent({ userMessage, studentProfile, ragChunks, apiKey, trace });
  // Rescue weight calibration with deterministic hedge/hard overrides.
  calibrateIntentWeights(intent, userMessage);

  // Merge avoid-day changes into a working profile. Order matters:
  // (1) reset wipes prior days if the student used reset-style language,
  // (2) explicit removals drop specific days,
  // (3) new additions are appended.
  const baseAvoid = intent.resetAvoidDays
    ? []
    : (studentProfile.avoidDays || []).filter((d) => !(intent.removeAvoidDays || []).includes(d));
  const updatedProfile = {
    ...studentProfile,
    calendarBlocks: mergeCalendarBlocks(studentProfile.calendarBlocks, intent.newCalendarBlocks || []),
    avoidDays: Array.from(new Set([...baseAvoid, ...(intent.newAvoidDays || [])])),
  };

  // Context recap fires before expensive work so student can catch misreads
  actions.push({
    type: "show_context_recap",
    recap: intent.recap || "",
    ambiguities: intent.ambiguities || [],
    confidence: intent.confidence ?? 1,
  });

  // Emit block/avoid-day actions immediately so extension persists & renders.
  // Reset + removals come first so they take effect before additions on the
  // same turn (otherwise the remove could wipe a day the user just re-added).
  if (intent.resetAvoidDays) actions.push({ type: "reset_avoid_days" });
  for (const day of intent.removeAvoidDays || [])
    actions.push({ type: "remove_avoid_day", day });
  for (const block of intent.newCalendarBlocks || [])
    actions.push({ type: "add_calendar_block", block });
  for (const day of intent.newAvoidDays || [])
    actions.push({ type: "add_avoid_day", day });

  // Branch on intent
  if (intent.intent === "advise" || intent.intent === "chat") {
    const advisorResult = await callAdvisor({
      userMessage, studentProfile: updatedProfile, conversationHistory, ragChunks, apiKey, trace,
    });
    actions.push({
      type: "show_message",
      text: advisorResult.response,
      followUp: advisorResult.followUpQuestion,
    });
    return { actions, updatedProfile, intent, trace: trace.entries };
  }

  if (intent.intent === "lock_course") {
    for (const crn of _validateCrns(intent.lockCRNs, rawData))
      actions.push({ type: "lock_course", crn });
    return { actions, updatedProfile, intent, trace: trace.entries };
  }

  if (intent.intent === "unlock_course") {
    for (const crn of _validateCrns(intent.unlockCRNs, rawData))
      actions.push({ type: "unlock_course", crn });
    return { actions, updatedProfile, intent, trace: trace.entries };
  }

  if (intent.intent === "accept_suggestion" && intent.referencesSuggestion) {
    actions.push({ type: "add_suggested_course", reference: intent.referencesSuggestion });
    return { actions, updatedProfile, intent, trace: trace.entries };
  }

  if (intent.intent === "reject_suggestion") {
    actions.push({ type: "show_message", text: "Got it — I'll drop that suggestion.", followUp: "" });
    return { actions, updatedProfile, intent, trace: trace.entries };
  }

  // Schedule / adjust_schedule path
  if (intent.intent === "schedule" || intent.intent === "adjust_schedule") {
    const compressed = compressForSolver(rawData);
    const prefs = intent.statedPreferences || {};
    const careerKeywords = prefs.careerKeywords || [];

    // Stage 2: Affinity
    const affinityScores = await callAffinity({
      eligible: compressed.eligible,
      careerKeywords,
      freeTextPrefs: prefs.freeTextPreferences,
      ragChunks,
      apiKey, trace,
    });

    // Stage 3: Solver with graceful relaxation
    const softAvoidDays = (updatedProfile.avoidDays || []).filter(() =>
      (prefs.avoidDayWeight ?? 0.5) < 1.0
    );
    const solverPrefs = { ...prefs, softAvoidDays };
    const { solved, relaxations, workingPrefs, attempts } = solveWithRelaxation(
      compressed.eligible,
      solverPrefs,
      updatedProfile,
      lockedCourses,
      trace,
    );

    if (!solved.results.length) {
      actions.push({
        type: "show_infeasible",
        message: "I couldn't build a schedule that respects every constraint, even after relaxing.",
        suggestions: _infeasibleSuggestions(attempts, compressed.eligible, updatedProfile),
        diagnostics: { attempts, eligibleCount: compressed.eligible.length },
      });
      return { actions, updatedProfile, intent, trace: trace.entries };
    }

    // Stage 4: Score + pick top 3. Use rankSchedules so we also get every
    // candidate's score breakdown — we stash the top-20 on the trace so
    // the debug pane can explain why Top-1 beat Top-2 without re-running.
    const t4 = trace.start("rank", `Ranking ${solved.results.length} schedules across 3 tradeoffs…`);
    const { top: topSchedules, allScored } = rankSchedules(solved.results, workingPrefs, affinityScores);
    const rankBreakdown = _buildRankBreakdown(topSchedules, allScored, workingPrefs);
    t4.done({
      summary: `Top 3: ${topSchedules.map((s) => s.label).join(" · ")}`,
      rankBreakdown,
    });

    // Defense-in-depth: validate no conflicts (solver should guarantee this)
    const t5 = trace.start("validate", "Verifying no conflicts…");
    let anyConflict = false;
    for (const top of topSchedules) {
      const pseudo = {
        courses: top.result.picks.map((p) => ({
          course: p.courseObj.course,
          days: p.section.days, start: p.section.start, end: p.section.end,
          online: p.section.online,
        })),
      };
      const v = validateSchedule(pseudo, updatedProfile.calendarBlocks, lockedCourses);
      if (v.length) { anyConflict = true; break; }
    }
    t5.done({ summary: anyConflict ? "CONFLICT detected — data issue" : "Clean" });
    if (anyConflict) {
      actions.push({
        type: "show_infeasible",
        message: "The solver returned a schedule that failed post-check — likely a section with bad meeting data. Try refreshing course data.",
        suggestions: ["Reload the term and try again."],
      });
      return { actions, updatedProfile, intent, trace: trace.entries };
    }

    // Stage 5: Rationales
    const rationales = await callRationales({
      topSchedules, affinityScores, preferences: workingPrefs, apiKey, trace,
    });

    // Compose final actions
    if (relaxations.length) {
      actions.push({ type: "show_relaxation_notice", relaxations });
    }
    actions.push({
      type: "show_schedules",
      summary: `Found ${solved.results.length} feasible schedules; here are 3 with different tradeoffs.`,
      schedules: _schedulesForAction(topSchedules, rationales, affinityScores, workingPrefs),
      relaxations,
      followUp: "Want to lock any of these, swap a section, or explore a different tradeoff?",
    });

    const rejected = _rejectedFromSolver(compressed.eligible, topSchedules, affinityScores);
    if (rejected.length) {
      actions.push({ type: "show_rejected_candidates", candidates: rejected });
    }

    return { actions, updatedProfile, intent, trace: trace.entries };
  }

  // Fallback
  actions.push({
    type: "show_message",
    text: "I didn't quite catch that — could you rephrase?",
    followUp: "",
  });
  return { actions, updatedProfile, intent, trace: trace.entries };
}
