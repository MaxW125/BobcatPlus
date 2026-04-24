// ============================================================
// 11. RATIONALE LLM — grounded, streaming
//
// We pass ONLY the structured facts (courses + metrics + honored
// preferences) and explicitly forbid invention. Streams per-schedule
// via onRationaleDelta callback.
// ============================================================

import { openaiJson } from "./openai.js";

export function buildRationaleFacts(topSchedule, affinityScores, preferences) {
  const picks = topSchedule.result.picks.map((p) => ({
    course: p.courseObj.course,
    title: p.courseObj.title,
    requirement: p.courseObj.requirementLabel,
    days: p.section.days,
    start: p.section.start,
    end: p.section.end,
    online: p.section.online,
    instructor: p.section.instructor,
    credits: p.section.credits,
    affinity: affinityScores[p.courseObj.course]?.score ?? 0.5,
    affinityReason: affinityScores[p.courseObj.course]?.reason ?? "",
  }));
  const honored = [];
  if (preferences.careerKeywords?.length && topSchedule.metrics.affinityNorm > 0.6)
    honored.push(`career fit (avg affinity ${topSchedule.metrics.affinityNorm.toFixed(2)})`);
  if (preferences.preferOnline && topSchedule.metrics.onlineRatio > 0)
    honored.push(`${Math.round(topSchedule.metrics.onlineRatio * picks.length)}/${picks.length} online`);
  if (preferences.noEarlierThan && topSchedule.metrics.morningPenalty === 0)
    honored.push(`no classes before ${preferences.noEarlierThan}`);
  if (preferences.noLaterThan && topSchedule.metrics.latePenalty === 0)
    honored.push(`done by ${preferences.noLaterThan}`);
  const avoidList = preferences.softAvoidDays || [];
  if (avoidList.length && topSchedule.metrics.softAvoidPenalty === 0)
    honored.push(`kept ${avoidList.join(", ")} clear`);
  if (preferences.targetCredits)
    honored.push(`${topSchedule.result.credits} credits (target ${preferences.targetCredits})`);

  // Transparency: surface soft preferences the solver couldn't honor so
  // the student sees the tradeoff rather than silently getting a schedule
  // that ignored what they asked for.
  const unhonored = [];
  if (preferences.noEarlierThan && topSchedule.metrics.morningPenalty > 0)
    unhonored.push(`some classes start before ${preferences.noEarlierThan}`);
  if (preferences.noLaterThan && topSchedule.metrics.latePenalty > 0)
    unhonored.push(`some classes run past ${preferences.noLaterThan}`);
  const dayLoad = topSchedule.metrics.dayLoad || {};
  const violatedAvoid = avoidList.filter((d) => (dayLoad[d] || 0) > 0);
  if (violatedAvoid.length)
    unhonored.push(`classes still on ${violatedAvoid.join(", ")} (soft preference)`);
  if (preferences.targetCredits && topSchedule.result.credits !== preferences.targetCredits)
    unhonored.push(`${topSchedule.result.credits} credits vs target ${preferences.targetCredits}`);
  if (preferences.preferOnline && topSchedule.metrics.onlineRatio === 0)
    unhonored.push("no online sections available in this pick");

  return { label: topSchedule.label, tagline: topSchedule.tagline, picks, honored, unhonored };
}

export async function callRationales({ topSchedules, affinityScores, preferences, ragChunks = [], apiKey, trace }) {
  if (!topSchedules.length) return [];
  const t = trace.start("rationale", "Writing rationales…");
  try {
    const facts = topSchedules.map((s) => buildRationaleFacts(s, affinityScores, preferences));
    const system = `
You write short 2-sentence rationales for schedule recommendations. You MUST only describe
what appears in the structured FACTS provided. Do NOT invent degree tracks, career paths,
concentrations, or outcomes. Do NOT use marketing language. Plain, direct, honest.

Return JSON:
{
  "rationales": [
    { "label": "<schedule label>", "text": "2 sentences grounded in facts" }
  ]
}

For each schedule: first sentence says what makes this schedule's tradeoff (use the tagline).
Second sentence cites 1-2 specific picks or honored preferences from the facts. Do not
restate every course; pick the ones that matter.
`.trim();
    const user = `FACTS:\n${JSON.stringify(facts, null, 2)}`;
    const { json, tokensIn, tokensOut } = await openaiJson({
      apiKey,
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    t.done({ tokensIn, tokensOut, summary: `Generated ${json.rationales?.length || 0} rationales` });
    return json.rationales || [];
  } catch (e) {
    t.fail(e);
    // Fallback to taglines if rationale call fails — schedules still ship
    return topSchedules.map((s) => ({ label: s.label, text: s.tagline }));
  }
}
