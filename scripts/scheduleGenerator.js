// ============================================================
// COMPRESSION FUNCTION
// Run this before sending data to the LLM.
// Input: the full raw JSON from your degree audit pipeline
// Output: a lean object the LLM can reason over efficiently
// ============================================================

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]+>/g, " ") // remove all HTML tags
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .split("Section Description:")[0] // drop section-specific blurbs, keep course desc
    .trim();
}

function compressForLLM(data) {
  return {
    eligible: data.eligible
      .map((course) => {
        const description = stripHtml(course.sections[0]?.courseDescription);

        const openSections = course.sections
          .filter((s) => s.openSection)
          .map((s) => {
            const mt = s.meetingsFaculty[0]?.meetingTime;
            const days = [];
            if (mt?.monday) days.push("Mon");
            if (mt?.tuesday) days.push("Tue");
            if (mt?.wednesday) days.push("Wed");
            if (mt?.thursday) days.push("Thu");
            if (mt?.friday) days.push("Fri");

            return {
              crn: s.courseReferenceNumber,
              online: s.instructionalMethod === "INT",
              days: days.length ? days : null,
              start: mt?.beginTime || null, // 24hr string e.g. "1230"
              end: mt?.endTime || null, // 24hr string e.g. "1350"
              seatsAvailable: s.seatsAvailable,
              instructor:
                s.faculty[0]?.displayName !== "Faculty, Unassigned"
                  ? s.faculty[0]?.displayName
                  : null,
              credits: s.creditHourLow ?? 3,
            };
          });

        return {
          course: `${course.subject} ${course.courseNumber}`,
          title: course.sections[0]?.courseTitle
            ?.replace(/&amp;/g, "&")
            ?.replace(/&#39;/g, "'"),
          requirementLabel: course.label,
          description,
          sections: openSections,
        };
      })
      .filter((c) => c.sections.length > 0), // drop courses with no open sections
  };
}

// ============================================================
// SYSTEM PROMPT
// Pass this as the `system` message in every API call.
// The conversation history + user message go in `messages`.
// ============================================================

const SCHEDULE_SYSTEM_PROMPT = `
You are an academic schedule planning assistant helping students at Texas State University 
build optimal course schedules for an upcoming semester.

You will receive:
1. A JSON object listing the student's eligible courses — each with a requirement label, 
   course description, and one or more open sections (CRN, days, times, seats, instructor).
2. The student's preferences in natural language (e.g. "no classes before 11am", 
   "I'm interested in public health careers", "I like writing-intensive courses").

═══════════════════════════════════════════
HARD RULES — never violate these
═══════════════════════════════════════════
1. No time conflicts. Two sections cannot overlap on the same day. 
   Compare start/end times carefully for any days they share.
   Times are 24-hour strings (e.g. "1230" = 12:30 PM, "1400" = 2:00 PM).
2. Only select sections where seatsAvailable > 0, unless the student explicitly says 
   they are okay with waitlisting.
3. Never select two courses that satisfy the same requirementLabel unless the student 
   explicitly asks to double up on a category.
4. Respect all explicit timing constraints from the student 
   (e.g. "nothing before 1100" means no section with start < "1100").
5. Only use sections from the provided eligible list. Do not invent CRNs or courses.

═══════════════════════════════════════════
SOFT PREFERENCES — use these to rank choices
═══════════════════════════════════════════
- Career goals: use course descriptions to favor courses most relevant to the 
  student's stated career interests.
- Day/time preferences: prefer lighter days or specific time ranges if mentioned.
- Topic interests: if the student mentions interest in a subject (e.g. history, ethics), 
  favor courses in that area when multiple options satisfy the same requirement.
- Online vs in-person: default to in-person unless the student prefers online or 
  no in-person option exists.
- Instructor availability: if an instructor name is null, note this as a mild negative 
  (unassigned faculty), but don't exclude the section on this basis alone.

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════
Always respond with valid JSON only — no markdown, no preamble, no explanation outside 
the JSON. Use this exact schema:

{
  "schedules": [
    {
      "name": "Schedule A — <short evocative label>",
      "rationale": "<2-4 sentences explaining why this schedule was built this way, how it addresses the student's preferences, and any notable tradeoffs>",
      "totalCredits": 12,
      "courses": [
        {
          "course": "SOCI 3363",
          "title": "MEDICAL SOCI",
          "crn": "19272",
          "days": ["Mon", "Wed"],
          "start": "1230",
          "end": "1350",
          "online": false,
          "requirementSatisfied": "Sociology Requirement",
          "instructor": "Zhang, Yan"
        }
      ]
    }
  ],
  "followUpQuestion": "<a short, friendly question asking if the student wants to lock any courses or make adjustments>"
}

Generate exactly 3 schedules. They should be meaningfully distinct — vary the time 
distribution, course selection (where alternatives exist), or online/in-person mix 
so the student has genuinely different options to consider.

═══════════════════════════════════════════
ITERATION & LOCKING
═══════════════════════════════════════════
If the student's message includes locked courses (e.g. "lock in PHIL 4327 CRN 16707"), 
those exact CRNs must appear in all 3 schedules unchanged. Build the remaining slots 
around them.

If the student asks to adjust a specific schedule (e.g. "make Schedule B lighter on 
Tuesdays"), regenerate all 3 schedules with that constraint applied, keeping any 
previously locked courses locked.

Always regenerate all 3 schedules on each turn so the student can compare the full 
set after each change.
`.trim();

// ============================================================
// EXAMPLE API CALL (OpenAI)
// ============================================================

async function generateSchedules(rawData, conversationHistory) {
  const compressed = compressForLLM(rawData);

  // On the first turn, inject the course data into the user message.
  // On subsequent turns, it's already in the conversation history.
  const isFirstTurn = conversationHistory.length === 0;

  const userContent = isFirstTurn
    ? `Here are my eligible courses:\n${JSON.stringify(compressed, null, 2)}\n\n${conversationHistory[conversationHistory.length - 1]?.content ?? ""}`
    : conversationHistory[conversationHistory.length - 1].content;

  const messages = isFirstTurn
    ? [{ role: "user", content: userContent }]
    : conversationHistory;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      response_format: { type: "json_object" }, // enforces valid JSON output
      messages: [
        { role: "system", content: SCHEDULE_SYSTEM_PROMPT },
        ...messages,
      ],
    }),
  });

  const data = await response.json();
  const result = JSON.parse(data.choices[0].message.content);

  // Append assistant response to history for next turn
  conversationHistory.push({
    role: "assistant",
    content: data.choices[0].message.content,
  });

  return result; // { schedules: [...], followUpQuestion: "..." }
}

// ============================================================
// USAGE EXAMPLE
// ============================================================

// First turn — student states preferences
// const history = [];
// history.push({ role: 'user', content: "I want to work in public health after graduation. I don't want anything before 11am and I prefer in-person classes." });
// const result = await generateSchedules(rawJsonFromYourBackend, history);

// Second turn — student locks a course and asks for adjustment
// history.push({ role: 'user', content: "Lock in PHIL 4327 CRN 16707. Can you make Schedule B have fewer Tuesday classes?" });
// const result2 = await generateSchedules(rawJsonFromYourBackend, history);

export { compressForLLM, generateSchedules, SCHEDULE_SYSTEM_PROMPT };
