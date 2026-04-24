// ============================================================
// 7. AFFINITY LLM — per-course career-fit scoring
//
// Skipped when no career signals. Results cached per session per
// (eligible-set, career-keywords) hash. Descriptions truncated to
// 200 chars to reduce tokens.
// ============================================================

import { openaiJson } from "./openai.js";
import { hashString } from "../time.js";

const affinityCache = new Map();

export function clearAffinityCache() {
  affinityCache.clear();
}

function _affinityCacheKey(eligible, careerKeywords) {
  const courseKey = eligible.map((c) => c.course).sort().join(",");
  const kwKey = (careerKeywords || []).map((k) => k.toLowerCase()).sort().join(",");
  return hashString(courseKey + "||" + kwKey);
}

function _truncateEligibleForAffinity(eligible) {
  return eligible.map((c) => ({
    course: c.course,
    title: c.title,
    requirementLabel: c.requirementLabel,
    description: (c.description || "").slice(0, 200),
  }));
}

export async function callAffinity({ eligible, careerKeywords, freeTextPrefs, ragChunks, apiKey, trace }) {
  // Skip entirely if no signal — uniform scoring is cheaper and less noisy
  const hasKeywords = (careerKeywords || []).length > 0;
  const hasFreeText = freeTextPrefs && freeTextPrefs.trim().length > 10;
  if (!hasKeywords && !hasFreeText) {
    const t = trace.start("affinity", "No career signal — using uniform scoring");
    const scores = Object.fromEntries(
      eligible.map((c) => [c.course, { score: 0.5, reason: "no career goal stated" }])
    );
    t.done({ summary: "Uniform 0.5 scoring (no career keywords)" });
    return scores;
  }

  const cacheKey = _affinityCacheKey(eligible, careerKeywords);
  if (affinityCache.has(cacheKey)) {
    const t = trace.start("affinity", "Cached affinity scores");
    const scores = affinityCache.get(cacheKey);
    t.done({ summary: "Reused cached scoring (same eligible list + career keywords)", cached: true });
    return scores;
  }

  const t = trace.start("affinity", "Scoring course fit for your goals…");
  try {
    const compressed = _truncateEligibleForAffinity(eligible);
    const ragSection = (ragChunks || []).length
      ? `\n\nCATALOG EXCERPTS:\n${ragChunks.map((c) => c.text).join("\n\n")}`
      : "";
    const system = `
You score each course 0.0-1.0 for how well it fits a student's career goals.

Return JSON: { "scores": { "<COURSE>": { "score": 0.0-1.0, "reason": "≤12 words" }, ... } }

Guidelines:
- 0.9-1.0: directly on path (e.g. "CS 4371 Security" for cybersecurity goal)
- 0.6-0.8: foundational / adjacent (e.g. "CS 4348 OS" for cybersecurity)
- 0.4-0.5: tangentially useful or fulfills a required core
- 0.1-0.3: unrelated to goal (but may still be required to graduate)
- Never 0.0 — every course has some value in a degree plan
- "reason" is a short honest phrase; no marketing language

Score every course in the list. Do not invent courses.${ragSection}
`.trim();
    const user = `
CAREER KEYWORDS: ${JSON.stringify(careerKeywords || [])}
ADDITIONAL PREFERENCES: ${freeTextPrefs || "(none)"}

COURSES:
${JSON.stringify(compressed, null, 2)}
`.trim();
    const { json, tokensIn, tokensOut } = await openaiJson({
      apiKey,
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const scores = json.scores || {};
    // Fill in defaults for any course the LLM skipped
    for (const c of eligible) {
      if (!scores[c.course]) scores[c.course] = { score: 0.5, reason: "no score returned" };
      const s = scores[c.course];
      if (typeof s.score !== "number" || s.score < 0 || s.score > 1) s.score = 0.5;
    }
    affinityCache.set(cacheKey, scores);
    t.done({ tokensIn, tokensOut, summary: `Scored ${Object.keys(scores).length} courses` });
    return scores;
  } catch (e) {
    t.fail(e);
    // Fallback to uniform — don't block schedule generation on affinity failure
    return Object.fromEntries(
      eligible.map((c) => [c.course, { score: 0.5, reason: "affinity unavailable" }])
    );
  }
}
