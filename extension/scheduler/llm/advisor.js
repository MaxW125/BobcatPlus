// ============================================================
// 12. ADVISOR LLM — unchanged conceptually from v2
// ============================================================

import { openaiJson } from "./openai.js";

export function buildAdvisorPrompt(studentProfile, ragChunks = []) {
  const profile = `
STUDENT PROFILE
Name: ${studentProfile.name}
Major: ${studentProfile.major}${studentProfile.concentration ? ` — ${studentProfile.concentration}` : ""}
Classification: ${studentProfile.classification} (${studentProfile.catalogYear} catalog)
Hours: ${studentProfile.completedHours} completed, ${studentProfile.remainingHours} remaining
${studentProfile.gpa ? `GPA: ${studentProfile.gpa}` : ""}
${studentProfile.holds?.length ? `HOLDS: ${studentProfile.holds.join(", ")}` : ""}
${studentProfile.careerGoals ? `Career goals: ${studentProfile.careerGoals}` : ""}
Calendar blocks: ${(studentProfile.calendarBlocks || []).map(b => `${b.label} ${b.days.join("/")} ${b.start}-${b.end}`).join("; ") || "none"}
Avoid days: ${(studentProfile.avoidDays || []).join(", ") || "none"}
`.trim();
  const rag = ragChunks.length
    ? `\n\nCATALOG EXCERPTS:\n${ragChunks.map((c, i) => `[${i + 1}] ${c.source}\n${c.text}`).join("\n\n")}`
    : "";
  return `
You are an academic advisor for Texas State University. Answer the student's question
directly, warmly, and with specificity. Use catalog excerpts when relevant. If you don't
know, say so and name who to ask (the student's official advisor).

Return JSON:
{ "response": "plain text; use \\n for paragraph breaks", "followUpQuestion": "short or empty" }

${profile}${rag}
`.trim();
}

export async function callAdvisor({ userMessage, studentProfile, conversationHistory, ragChunks, apiKey, trace }) {
  const t = trace.start("advisor", "Thinking about your question…");
  try {
    const { json, tokensIn, tokensOut } = await openaiJson({
      apiKey,
      model: "gpt-4o",
      temperature: 0.6,
      messages: [
        { role: "system", content: buildAdvisorPrompt(studentProfile, ragChunks) },
        ...conversationHistory,
        { role: "user", content: userMessage },
      ],
    });
    t.done({ tokensIn, tokensOut, summary: "Generated advisor response" });
    return json;
  } catch (e) {
    t.fail(e);
    throw e;
  }
}
