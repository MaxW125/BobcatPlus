// ============================================================
// scheduleGenerator.js — v3 HYBRID architecture
//
// Plain script (not ESM). Exposes globals on window for tab.js.
//
// Pipeline per schedule request:
//
//   1. Intent LLM (gpt-4o-mini, temp 0)
//        — parse rambling student prompt into frozen IntentSchema v1
//        — includes weights, career keywords, confidence, recap
//
//   2. Context recap UI
//        — extension surfaces the intent's recap so student can catch
//          misreads in <1s, before expensive solver work
//
//   3. Affinity LLM (gpt-4o-mini, temp 0) — skipped if no career signals
//        — scores each eligible course 0–1 for career-goal fit
//        — cached per (eligible-hash, career-keywords)
//
//   4. Deterministic CSP solver (JavaScript, sync)
//        — enumerates feasible schedules with hard constraints
//        — hard constraints NEVER violated (no-conflict guarantee)
//        — graceful relaxation if infeasible
//        — ranks by weighted score; 3 schedules via shifted weight vectors
//
//   5. Rationale LLM (gpt-4o-mini, streaming)
//        — grounded 2-sentence rationale per schedule
//        — receives only structured facts to prevent hallucination
//
// RAG seam: every LLM prompt accepts ragChunks[]. Empty in v1.
// ============================================================

(function () {
  "use strict";

  const BP = (window.BP = window.BP || {});

  // ============================================================
  // 1. TIME + DAY HELPERS
  // ============================================================

  function toMinutes(timeStr) {
    if (!timeStr) return null;
    const h = parseInt(timeStr.slice(0, 2), 10);
    const m = parseInt(timeStr.slice(2, 4), 10);
    return h * 60 + m;
  }

  function timesOverlap(aStart, aEnd, bStart, bEnd) {
    const a1 = toMinutes(aStart), a2 = toMinutes(aEnd);
    const b1 = toMinutes(bStart), b2 = toMinutes(bEnd);
    if (a1 == null || b1 == null) return false;
    return a1 < b2 && b1 < a2;
  }

  function daysOverlap(aDays, bDays) {
    if (!aDays || !bDays) return false;
    return aDays.some((d) => bDays.includes(d));
  }

  function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  // ============================================================
  // 2. COMPRESSION + PROFILE
  // ============================================================

  function stripHtml(html) {
    if (!html) return null;
    return html
      .replace(/<[^>]+>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&rsquo;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .split("Section Description:")[0]
      .trim();
  }

  // TXST numbering convention: the second digit of a 4-digit course number
  // typically encodes credit hours (e.g. BIO 1331 = 3 cr lecture, BIO 1131 =
  // 1 cr lab). Use as a last-resort fallback when Banner data is missing.
  function creditsFromCourseNumber(num) {
    const s = String(num || "");
    const m = s.match(/^(\d)(\d)/);
    if (!m) return null;
    const digit = parseInt(m[2], 10);
    return digit >= 1 && digit <= 6 ? digit : null;
  }

  function deriveCredits(section, courseNumber) {
    if (section.creditHourLow != null && section.creditHourLow > 0) return section.creditHourLow;
    if (section.creditHourHigh != null && section.creditHourHigh > 0) return section.creditHourHigh;
    const fromNumber = creditsFromCourseNumber(courseNumber);
    if (fromNumber != null) return fromNumber;
    return 3;
  }

  // Lab-pair detection by TXST numbering convention: a lecture (e.g. BIO 1331,
  // 3 cr) and its lab (BIO 1131, 1 cr) share the same subject, the same first
  // digit (level), and the same last two digits (sequence), but different
  // second digits (credit hours). The pair is enforced in the solver so the
  // student never gets a lab without its lecture or vice versa.
  function labPartnerCandidate(courseName) {
    // Returns an array of possible partner course names ordered by likelihood.
    const m = courseName.match(/^([A-Z]+)\s+(\d)(\d)(\d{2})$/);
    if (!m) return [];
    const [, subj, first, second, tail] = m;
    const candidates = [];
    // Same level, same sequence, different 2nd digit. Try common pairings:
    // 3↔1 (3cr lec ↔ 1cr lab) and 4↔1 (4cr lec ↔ 1cr lab) and 3↔2 rare.
    const thisDigit = parseInt(second, 10);
    const partners = thisDigit === 1 ? [3, 4] : thisDigit === 3 ? [1] : thisDigit === 4 ? [1] : [];
    for (const d of partners) candidates.push(`${subj} ${first}${d}${tail}`);
    return candidates;
  }

  function annotateLabPairs(eligibleCourses) {
    const byName = new Map(eligibleCourses.map((c) => [c.course, c]));
    for (const course of eligibleCourses) {
      if (course.pairedCourse) continue;
      for (const candidate of labPartnerCandidate(course.course)) {
        if (byName.has(candidate)) {
          course.pairedCourse = candidate;
          byName.get(candidate).pairedCourse = course.course;
          break;
        }
      }
    }
    return eligibleCourses;
  }

  function compressForSolver(rawData) {
    const eligible = (rawData.eligible || [])
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
              crn: String(s.courseReferenceNumber),
              online: s.instructionalMethod === "INT",
              days: days.length ? days : null,
              start: mt?.beginTime || null,
              end: mt?.endTime || null,
              seatsAvailable: s.seatsAvailable,
              instructor:
                s.faculty[0]?.displayName !== "Faculty, Unassigned"
                  ? s.faculty[0]?.displayName
                  : null,
              credits: deriveCredits(s, course.courseNumber),
              scheduleType: s.scheduleType || null,
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
          pairedCourse: null,
        };
      })
      .filter((c) => c.sections.length > 0);
    annotateLabPairs(eligible);
    return { eligible };
  }

  function buildStudentProfile({
    name,
    major,
    concentration = null,
    classification,
    catalogYear,
    completedHours,
    remainingHours,
    gpa = null,
    completedCourses = [],
    holds = [],
    calendarBlocks = [],
    avoidDays = [],
    careerGoals = null,
    advisingNotes = null,
  }) {
    return {
      name, major, concentration, classification, catalogYear,
      completedHours, remainingHours, gpa, completedCourses, holds,
      calendarBlocks, avoidDays, careerGoals, advisingNotes,
    };
  }

  function mergeCalendarBlocks(existing = [], incoming = []) {
    const map = new Map(existing.map((b) => [b.label.toLowerCase(), b]));
    for (const block of incoming) map.set(block.label.toLowerCase(), block);
    return Array.from(map.values());
  }

  // ============================================================
  // 3. DEFENSE-IN-DEPTH VALIDATOR
  // The solver guarantees feasibility, but we keep a validator for
  // data-quality issues (sections with missing meeting data, etc.).
  // ============================================================

  function validateSchedule(schedule, calendarBlocks = [], lockedCourses = []) {
    const violations = [];
    const courses = schedule.courses || [];

    for (let i = 0; i < courses.length; i++) {
      for (let j = i + 1; j < courses.length; j++) {
        const a = courses[i], b = courses[j];
        if (a.online || b.online) continue;
        if (daysOverlap(a.days, b.days) && timesOverlap(a.start, a.end, b.start, b.end)) {
          violations.push({ type: "course_conflict", a: a.course, b: b.course });
        }
      }
    }
    for (const c of courses) {
      if (c.online) continue;
      for (const b of calendarBlocks) {
        if (daysOverlap(c.days, b.days) && timesOverlap(c.start, c.end, b.start, b.end)) {
          violations.push({ type: "block_conflict", course: c.course, block: b.label });
        }
      }
      for (const l of lockedCourses) {
        if (!l.days || !l.start || !l.end) continue;
        if (daysOverlap(c.days, l.days) && timesOverlap(c.start, c.end, l.start, l.end)) {
          violations.push({ type: "locked_conflict", course: c.course, locked: l.course });
        }
      }
    }
    return violations;
  }

  // ============================================================
  // 4. TRACE / OBSERVABILITY
  // Every stage records {stage, status, duration, summary, tokens}.
  // The extension's Thinking panel subscribes via onTrace callback.
  // ============================================================

  function createTrace(onTrace) {
    const entries = [];
    const emit = (entry) => {
      entries.push(entry);
      try { onTrace && onTrace(entry, entries); } catch (_) {}
    };
    return {
      entries,
      start(stage, summary = "") {
        const entry = { stage, status: "running", startedAt: Date.now(), summary };
        emit(entry);
        return {
          done: (extra = {}) => {
            entry.status = "done";
            entry.duration = Date.now() - entry.startedAt;
            Object.assign(entry, extra);
            emit({ ...entry });
          },
          fail: (err) => {
            entry.status = "error";
            entry.duration = Date.now() - entry.startedAt;
            entry.error = err?.message || String(err);
            emit({ ...entry });
          },
          update: (extra) => {
            Object.assign(entry, extra);
            emit({ ...entry });
          },
        };
      },
    };
  }

  // ============================================================
  // 5. OPENAI CALL WRAPPER — shared error handling, token tracing
  // ============================================================

  async function openaiChat({ apiKey, model, temperature, messages, responseFormat, stream = false }) {
    const body = { model, temperature, messages };
    if (responseFormat) body.response_format = responseFormat;
    if (stream) body.stream = true;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (stream) return res;

    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "OpenAI API error");
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");
    return {
      content,
      tokensIn: data.usage?.prompt_tokens ?? null,
      tokensOut: data.usage?.completion_tokens ?? null,
    };
  }

  async function openaiJson({ apiKey, model, temperature, messages, retries = 1 }) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await openaiChat({
          apiKey, model, temperature, messages,
          responseFormat: { type: "json_object" },
        });
        return { json: JSON.parse(r.content), tokensIn: r.tokensIn, tokensOut: r.tokensOut };
      } catch (e) {
        lastErr = e;
        if (i < retries) {
          messages = [
            ...messages,
            { role: "system", content: "Return ONLY valid JSON. No prose, no markdown." },
          ];
        }
      }
    }
    throw lastErr;
  }

  // ============================================================
  // 6. INTENT LLM — frozen IntentSchema v1
  //
  // All downstream stages consume this shape. Changes to this schema
  // cascade; treat as a contract. The `confidence` and `ambiguities`
  // fields are how the intent call signals uncertainty back to the UI.
  // ============================================================

  const INTENT_SCHEMA_VERSION = 1;

  function buildIntentPrompt(studentProfile, ragChunks = []) {
    const ragSection = ragChunks.length
      ? `\n\nCATALOG EXCERPTS (for interpretation only, do not echo):\n${ragChunks.map((c) => c.text).join("\n\n")}`
      : "";
    return `
You are the intent + preference extraction layer of a Texas State University scheduling
assistant. You do NOT generate schedules, give advising answers, or invent courses. You
classify the student's message into a structured JSON object and extract every constraint
and preference you can, with calibrated weights.

SCHEMA (return EXACTLY this shape — never omit fields, use null/[] where unknown):
{
  "schemaVersion": ${INTENT_SCHEMA_VERSION},
  "intent": "advise" | "schedule" | "adjust_schedule" | "lock_course" | "unlock_course" | "accept_suggestion" | "reject_suggestion" | "chat",
  "confidence": 0.0-1.0,
  "recap": "One plain sentence summarizing what you extracted, for the student to confirm.",
  "ambiguities": ["short phrases of things you were uncertain about; empty array if none"],
  "newCalendarBlocks": [
    { "label": "Work", "days": ["Tue","Thu"], "start": "1700", "end": "2200" }
  ],
  "newAvoidDays": ["Fri"],
  "statedPreferences": {
    "noEarlierThan": "HHMM" | null,
    "noLaterThan":  "HHMM" | null,
    "preferOnline": true | false | null,
    "onlineWeight": 0.0-1.0 | null,
    "targetCredits": number | null,
    "minCredits":    number | null,
    "maxCredits":    number | null,
    "careerKeywords": ["lowercase expanded career-related terms"],
    "careerAffinityWeight": 0.0-1.0 | null,
    "avoidDayWeight": 0.0-1.0 | null,
    "morningCutoffWeight": 0.0-1.0 | null,
    "freeTextPreferences": "any extra nuance, career aspirations, instructor preferences"
  },
  "referencesSuggestion": "GEO 2342" | null,
  "lockCRNs": ["12345"],
  "unlockCRNs": []
}

WEIGHT CALIBRATION (read carefully — this drives the solver):
- Language intensity maps to weights on a 0–1 scale:
    "absolutely must" / "cannot" / "never"       → 1.0  (treated as HARD constraint)
    "really want" / "strongly prefer"            → 0.8
    "want" / "prefer"                            → 0.6
    "would be nice" / "if possible"              → 0.4
    "open to anything"                           → ≤ 0.3
- If a preference is stated but intensity unclear, default to 0.6.
- "I work Mon 5pm" = 1.0 hard block (person can't teleport).
- "no mornings" = 0.6 default; "absolutely no mornings" = 1.0.
- "cybersecurity goal, open to anything" = careerAffinityWeight ~0.5 (soft bias).

CAREER KEYWORD EXPANSION:
When a student states a career goal, expand to adjacent terms a degree-audit system
would recognize. Examples:
- "cybersecurity" → ["cybersecurity","security","cryptography","networks","systems","privacy"]
- "data science" → ["data science","machine learning","statistics","analytics","databases"]
- "game dev" → ["game","graphics","animation","simulation"]
Keep 4-8 terms. Lowercase.

CALENDAR BLOCK EXTRACTION:
Non-course time commitments (work, commute, therapy, childcare). Infer reasonable windows
generously: "I work late Tuesdays" → Tue 1700-2200. Only include NEW blocks; existing
blocks in the profile are already saved.

RECAP DISCIPLINE:
The recap is one sentence the student will see for confirmation. Include: new blocks,
avoid days, credit target, top preferences, career goal. Keep it natural, not a dump.
Example: "Saving Mon/Wed evenings for work, keeping Friday clear, targeting 15 credits
with a cybersecurity lean and no mornings."

CONFIDENCE:
0.9+ when the message is explicit. 0.6-0.8 when you had to infer. <0.6 when significant
guessing was required — flag the specific guess in ambiguities.

INTENT DEFINITIONS:
- "advise": asking a question, wants information/guidance, NOT a schedule
- "schedule": wants schedules built (includes messages that mainly state preferences/blocks)
- "adjust_schedule": modify already-generated schedules
- "lock_course" / "unlock_course": pin/unpin a specific CRN
- "accept_suggestion": agreeing to a previously-rejected course candidate
- "reject_suggestion": declining a previously-offered schedule or course
- "chat": small talk, greetings, unclear

Times are 4-char 24hr strings ("0900","1230","1700").

STUDENT PROFILE (disambiguation only):
Name: ${studentProfile.name}
Major: ${studentProfile.major}
Existing calendar blocks: ${JSON.stringify(studentProfile.calendarBlocks)}
Existing avoid days: ${JSON.stringify(studentProfile.avoidDays)}${ragSection}
`.trim();
  }

  // Deterministic post-processor that corrects LLM weight miscalibration.
  // The intent LLM often returns 0.6 for both "preferably no Mondays" and
  // "I absolutely cannot do Mondays" — same constraint, opposite intensity.
  // We scan the raw message for hedge vs. hard language near each constraint
  // and cap/floor the weight accordingly. The LLM stays in charge of value
  // extraction; this layer just rescues calibration.
  const HEDGE_PATTERN = /\b(preferably|ideally|if possible|hopefully|rather|somewhat|maybe|kinda|kind of|sort of|would like|would prefer|i'd like|i would like|open to|flexible)\b/;
  const HARD_PATTERN = /\b(cannot|can't|can not|impossible|won't|will not|never|absolutely no|absolutely not|under no circumstances|must not|no way|refuse|have to avoid|need to avoid|no classes at all)\b/;

  function _clausesMentioning(msg, keywords) {
    const lower = (msg || "").toLowerCase();
    const clauses = lower.split(/[,.;:!?\n]/);
    return clauses.filter((c) => keywords.some((k) => c.includes(k)));
  }

  function _calibrate(weight, clauses) {
    if (!clauses.length) return weight;
    const anyHedge = clauses.some((c) => HEDGE_PATTERN.test(c));
    const anyHard = clauses.some((c) => HARD_PATTERN.test(c));
    let w = weight == null ? null : weight;
    // If the LLM didn't set a weight but the language is clear, seed one.
    if (w == null) {
      if (anyHard) w = 1.0;
      else if (anyHedge) w = 0.5;
      else return null;
    }
    if (anyHedge) w = Math.min(w, 0.7);
    if (anyHard) w = Math.max(w, 1.0);
    return w;
  }

  function calibrateIntentWeights(intent, userMessage) {
    if (!intent || !intent.statedPreferences) return intent;
    const prefs = intent.statedPreferences;
    const dayNames = ["monday","tuesday","wednesday","thursday","friday","mon ","tue ","wed ","thu ","fri "];
    const morningKw = ["morning","before 8","before 9","before 10","before 11","before noon","am ","early"," early"];
    const onlineKw = ["online","remote","async","asynchronous","in person","in-person","on campus"];
    const careerKw = ["career","goal","into ","interested","passionate","love","hate","want to","plan to"];

    prefs.morningCutoffWeight = _calibrate(prefs.morningCutoffWeight, _clausesMentioning(userMessage, morningKw));
    prefs.avoidDayWeight = _calibrate(prefs.avoidDayWeight, _clausesMentioning(userMessage, dayNames));
    prefs.onlineWeight = _calibrate(prefs.onlineWeight, _clausesMentioning(userMessage, onlineKw));
    prefs.careerAffinityWeight = _calibrate(prefs.careerAffinityWeight, _clausesMentioning(userMessage, careerKw));

    intent.statedPreferences = prefs;
    return intent;
  }

  async function callIntent({ userMessage, studentProfile, ragChunks, apiKey, trace }) {
    const t = trace.start("intent", "Understanding your request…");
    try {
      const { json, tokensIn, tokensOut } = await openaiJson({
        apiKey,
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: buildIntentPrompt(studentProfile, ragChunks) },
          { role: "user", content: userMessage },
        ],
      });
      // Minimal shape normalization so downstream code can trust fields
      json.newCalendarBlocks = Array.isArray(json.newCalendarBlocks) ? json.newCalendarBlocks : [];
      json.newAvoidDays = Array.isArray(json.newAvoidDays) ? json.newAvoidDays : [];
      json.lockCRNs = Array.isArray(json.lockCRNs) ? json.lockCRNs : [];
      json.unlockCRNs = Array.isArray(json.unlockCRNs) ? json.unlockCRNs : [];
      json.ambiguities = Array.isArray(json.ambiguities) ? json.ambiguities : [];
      json.statedPreferences = json.statedPreferences || {};
      t.done({ tokensIn, tokensOut, summary: json.recap || "Parsed preferences." });
      return json;
    } catch (e) {
      t.fail(e);
      throw e;
    }
  }

  // ============================================================
  // 7. AFFINITY LLM — per-course career-fit scoring
  //
  // Skipped when no career signals. Results cached per session per
  // (eligible-set, career-keywords) hash. Descriptions truncated to
  // 200 chars to reduce tokens.
  // ============================================================

  const affinityCache = new Map();

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

  async function callAffinity({ eligible, careerKeywords, freeTextPrefs, ragChunks, apiKey, trace }) {
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

  // ============================================================
  // 8. SOLVER — CSP backtracking with pruning
  //
  // State: pick at most one section per course; total credits within
  // [minCredits, maxCredits]; no pairwise time overlaps; no overlaps
  // with calendar blocks or locked courses; hard avoid-days respected.
  //
  // Enumeration cap: 50k partial states or 20k feasible results, then
  // we stop and rank what we have. Tuned for snappy UX on browser.
  // ============================================================

  const SOLVER_NODE_CAP = 200000;
  const SOLVER_RESULT_CAP = 2000;

  function sectionConflictsFixed(section, fixedSlots) {
    // fixedSlots: [{ days, start, end }]
    if (section.online || !section.days || !section.start) return false;
    for (const slot of fixedSlots) {
      if (!slot.days || !slot.start) continue;
      if (daysOverlap(section.days, slot.days) &&
          timesOverlap(section.start, section.end, slot.start, slot.end)) return true;
    }
    return false;
  }

  function sectionsConflict(a, b) {
    if (a.online || b.online) return false;
    return daysOverlap(a.days, b.days) && timesOverlap(a.start, a.end, b.start, b.end);
  }

  // Mulberry32 seeded PRNG — deterministic shuffles for reproducible searches.
  function seededRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  function solve(eligible, constraints, options = {}) {
    const { calendarBlocks, lockedCourses, hardAvoidDays, minCredits, maxCredits, minCourses, maxCourses } = constraints;

    // Fixed slots = blocks + locked courses with meeting data
    const fixedSlots = [
      ...(calendarBlocks || []).map((b) => ({ days: b.days, start: b.start, end: b.end })),
      ...(lockedCourses || []).filter((l) => l.days && l.start && l.end)
                              .map((l) => ({ days: l.days, start: l.start, end: l.end })),
    ];

    // Per-course pre-filter: drop sections that conflict with fixed slots
    // or land on hard avoid-days. Also drop sections missing meeting data
    // unless online (data-quality defense).
    const perCourse = [];
    const dataQualityDrops = [];
    const perCourseCounts = [];
    const eliminatedCourses = [];
    for (const course of eligible) {
      const original = course.sections.length;
      const dropReasons = { missingData: 0, fixedConflict: 0, hardAvoidDay: 0 };
      const viable = course.sections.filter((s) => {
        if (!s.online && (!s.days || !s.start || !s.end)) {
          dataQualityDrops.push({ course: course.course, crn: s.crn, reason: "missing meeting data" });
          dropReasons.missingData++;
          return false;
        }
        if (s.online) return true;
        if (sectionConflictsFixed(s, fixedSlots)) { dropReasons.fixedConflict++; return false; }
        if ((hardAvoidDays || []).length && s.days.some((d) => hardAvoidDays.includes(d))) {
          dropReasons.hardAvoidDay++;
          return false;
        }
        return true;
      });
      perCourseCounts.push({ course: course.course, original, viable: viable.length, dropReasons });
      if (viable.length) perCourse.push({ course, viable });
      else eliminatedCourses.push({ course: course.course, original, dropReasons });
    }

    // Course ordering strategy — defaults to MRV (fewest viable sections first)
    // for single-pass searches. Multi-pass callers supply alternatives to
    // diversify the search space; MRV alone fixates on the same subset of
    // small-branching-factor courses, producing near-identical schedules.
    const ordering = options.ordering || "mrv";
    if (ordering === "mrv") {
      perCourse.sort((a, b) => a.viable.length - b.viable.length);
    } else if (ordering === "reverse-mrv") {
      perCourse.sort((a, b) => b.viable.length - a.viable.length);
    } else if (ordering === "shuffled") {
      const rng = seededRng(options.seed ?? 42);
      perCourse.sort((a, b) => a.viable.length - b.viable.length);
      shuffleInPlace(perCourse, rng);
    }

    // Also shuffle sections within each course for shuffled/reverse passes so
    // the same {courseSet, sectionSet} prefix isn't explored first every time.
    if (ordering !== "mrv") {
      const rng = seededRng((options.seed ?? 42) + 1);
      for (const pc of perCourse) {
        const copy = pc.viable.slice();
        shuffleInPlace(copy, rng);
        pc.viable = copy;
      }
    }

    const results = [];
    let nodes = 0;

    // Index lookup for lab-pair constraints. Course order may have been
    // shuffled by ordering strategy, so we compute indices after sorting.
    const courseIdxByName = new Map();
    perCourse.forEach((pc, i) => courseIdxByName.set(pc.course.course, i));

    function recurse(idx, picked, credits) {
      nodes++;
      if (nodes > SOLVER_NODE_CAP) return;
      if (results.length >= SOLVER_RESULT_CAP) return;
      if (credits > maxCredits) return;
      if (picked.length > maxCourses) return;

      const remaining = perCourse.length - idx;

      // Pruning: can't reach minCourses even if we pick every remaining course
      if (picked.length + remaining < minCourses) return;

      // Pruning: can't reach minCredits even if every remaining course is 4cr
      if (credits + remaining * 4 < minCredits) return;

      if (idx === perCourse.length) {
        if (credits >= minCredits && picked.length >= minCourses) {
          // Final pair validation: every picked course whose pair is in the
          // eligible set must have its partner also picked.
          const pickedNames = new Set(picked.map((p) => p.courseObj.course));
          let pairOk = true;
          for (const p of picked) {
            const partner = p.courseObj.pairedCourse;
            if (partner && courseIdxByName.has(partner) && !pickedNames.has(partner)) {
              pairOk = false;
              break;
            }
          }
          if (pairOk) results.push({ picks: picked.slice(), credits });
        }
        return;
      }

      // Lab-pair pruning: consult partner's decision state before branching.
      const { course, viable } = perCourse[idx];
      const partner = course.pairedCourse;
      const partnerIdx = partner ? courseIdxByName.get(partner) : undefined;
      const partnerDecided = partnerIdx !== undefined && partnerIdx < idx;
      const partnerPicked = partnerDecided && picked.some((p) => p.courseObj.course === partner);
      const mustPickToHonorPair = partnerDecided && partnerPicked;   // partner picked → must pick
      const mustSkipToHonorPair = partnerDecided && !partnerPicked;  // partner skipped → must skip

      // Pick branches FIRST so DFS reaches leaves fast — the first complete
      // assignment gets scored / credit-bounded immediately, which prunes
      // sibling subtrees aggressively. Skip-first wastes the node budget on
      // dead paths (picked stays < minCourses for most of the tree).
      if (!mustSkipToHonorPair) {
        for (const sec of viable) {
          let ok = true;
          for (const p of picked) if (sectionsConflict(sec, p.section)) { ok = false; break; }
          if (!ok) continue;
          picked.push({ courseObj: course, section: sec });
          recurse(idx + 1, picked, credits + (sec.credits ?? 3));
          picked.pop();
          if (results.length >= SOLVER_RESULT_CAP) return;
        }
      }

      // Skip branch last
      if (!mustPickToHonorPair) {
        recurse(idx + 1, picked, credits);
      }
    }

    recurse(0, [], 0);

    const totalViableSections = perCourse.reduce((s, c) => s + c.viable.length, 0);
    return {
      results, nodesExplored: nodes, dataQualityDrops, capHit: nodes > SOLVER_NODE_CAP,
      perCourseCounts, eliminatedCourses, totalViableSections,
      coursesWithViableSections: perCourse.length,
    };
  }

  // ============================================================
  // 9. SCORING — weighted sum with three shifted vectors
  //
  // Each scorer returns a number (higher = better). We compute three
  // scores for every feasible schedule (one per weight vector) and
  // pick the argmax of each to get 3 distinct top schedules with
  // clear labels (affinity / online / balanced).
  // ============================================================

  function scoreSchedule(result, preferences, affinityScores) {
    const picks = result.picks;
    const n = picks.length || 1;
    let affinitySum = 0, onlineCount = 0, morningPenalty = 0, softAvoidPenalty = 0;
    const dayLoad = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 };

    for (const p of picks) {
      const sc = affinityScores[p.courseObj.course];
      affinitySum += sc ? sc.score : 0.5;
      if (p.section.online) onlineCount++;
      if (!p.section.online && preferences.noEarlierThan) {
        const cutoff = toMinutes(preferences.noEarlierThan);
        const start = toMinutes(p.section.start);
        if (start != null && cutoff != null && start < cutoff) {
          morningPenalty += (cutoff - start) / 60; // hours below cutoff
        }
      }
      if (!p.section.online && (preferences.softAvoidDays || []).length) {
        const hits = (p.section.days || []).filter((d) => preferences.softAvoidDays.includes(d));
        softAvoidPenalty += hits.length;
      }
      for (const d of (p.section.days || [])) dayLoad[d] = (dayLoad[d] || 0) + 1;
    }

    const affinityNorm = affinitySum / n;
    const onlineRatio = onlineCount / n;
    // Balance = low variance across active days. Penalty grows with spread.
    const activeDays = Object.values(dayLoad).filter((v) => v > 0);
    const mean = activeDays.reduce((s, v) => s + v, 0) / (activeDays.length || 1);
    const variance = activeDays.reduce((s, v) => s + (v - mean) ** 2, 0) / (activeDays.length || 1);
    const balance = 1 / (1 + variance);

    const creditTargetDist = preferences.targetCredits
      ? Math.abs(result.credits - preferences.targetCredits) / 18
      : 0;

    return {
      affinityNorm, onlineRatio, morningPenalty, softAvoidPenalty, balance,
      creditTargetDist, dayLoad,
    };
  }

  // Three shifted weight vectors → three distinct top schedules.
  // Each returns a scalar; higher is better.
  const WEIGHT_VECTORS = {
    affinity: {
      affinity: 1.0, online: 0.2, balance: 0.1,
      morning: 0.3, avoidDay: 0.6, creditTarget: 0.4,
    },
    online: {
      affinity: 0.3, online: 1.0, balance: 0.1,
      morning: 0.3, avoidDay: 0.6, creditTarget: 0.4,
    },
    balanced: {
      affinity: 0.4, online: 0.2, balance: 1.0,
      morning: 0.3, avoidDay: 0.6, creditTarget: 0.4,
    },
  };

  function applyVector(metrics, vec, prefs) {
    const onlineTerm = (prefs.onlineWeight ?? 0.5) * vec.online * metrics.onlineRatio;
    const affinityTerm = (prefs.careerAffinityWeight ?? 0.5) * vec.affinity * metrics.affinityNorm;
    const balanceTerm = vec.balance * metrics.balance;
    const morningPen = (prefs.morningCutoffWeight ?? 0.5) * vec.morning * metrics.morningPenalty;
    const softAvoidPen = (prefs.avoidDayWeight ?? 0.5) * vec.avoidDay * metrics.softAvoidPenalty;
    const creditPen = vec.creditTarget * metrics.creditTargetDist;
    return affinityTerm + onlineTerm + balanceTerm - morningPen - softAvoidPen - creditPen;
  }

  function pickTop3(results, preferences, affinityScores) {
    if (!results.length) return [];
    const scored = results.map((r) => {
      const metrics = scoreSchedule(r, preferences, affinityScores);
      return {
        result: r, metrics,
        scoreAffinity: applyVector(metrics, WEIGHT_VECTORS.affinity, preferences),
        scoreOnline:   applyVector(metrics, WEIGHT_VECTORS.online,   preferences),
        scoreBalanced: applyVector(metrics, WEIGHT_VECTORS.balanced, preferences),
      };
    });

    const picksById = (s) => s.result.picks.map((p) => p.section.crn).sort().join(",");
    const courseSet = (s) => new Set(s.result.picks.map((p) => p.courseObj.course));
    // Jaccard similarity on course sets — two schedules with the same 5 courses
    // differing only in section choice are not "tradeoffs", they're the same
    // plan at different times. Require each top pick to be <= 0.7 similar to
    // already-picked tops; if no candidate qualifies, fall back to next-best.
    const JACCARD_CAP = 0.7;
    function jaccard(a, b) {
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      return inter / (a.size + b.size - inter);
    }

    const top = [];
    const taken = new Set();

    const pickFrom = (sortKey, label, tagline) => {
      const sorted = scored.slice().sort((a, b) => b[sortKey] - a[sortKey]);
      // First pass: require Jaccard <= cap against all already-picked tops
      for (const s of sorted) {
        const id = picksById(s);
        if (taken.has(id)) continue;
        const mine = courseSet(s);
        const tooSimilar = top.some((t) => jaccard(mine, courseSet(t)) > JACCARD_CAP);
        if (tooSimilar) continue;
        taken.add(id);
        top.push({ ...s, label, tagline });
        return;
      }
      // Second pass: relax the similarity requirement rather than return < 3.
      // Rare, but possible when the pool is genuinely narrow (small eligible set).
      for (const s of sorted) {
        const id = picksById(s);
        if (taken.has(id)) continue;
        taken.add(id);
        top.push({ ...s, label, tagline });
        return;
      }
    };

    pickFrom("scoreAffinity", "Best for your goals", "maximizes career-fit");
    pickFrom("scoreOnline",   "Most online / flexible", "maximizes online / time-flexible");
    pickFrom("scoreBalanced", "Most balanced week", "spreads load evenly across days");

    return top;
  }

  // ============================================================
  // 10. RELAXATION — if no feasible schedule, loosen softly
  //
  // Relaxation order (softest first):
  //   1. morning cutoff (if weight < 1.0)
  //   2. soft avoid days (weight < 1.0) — already soft, confirms
  //   3. target credits band widening
  //   4. online preference ignored
  //   5. minCredits down to 9
  // Each step records what was relaxed so we can tell the student.
  // ============================================================

  function buildConstraints(preferences, studentProfile, lockedCourses) {
    const hardAvoidDays = (studentProfile.avoidDays || []).filter(() =>
      (preferences.avoidDayWeight ?? 0.5) >= 1.0
    );
    // If avoidDayWeight is 1.0, ALL avoid days are hard. Otherwise none are
    // (they become soft penalties in scoring).
    return {
      calendarBlocks: studentProfile.calendarBlocks || [],
      lockedCourses: lockedCourses || [],
      hardAvoidDays,
      minCredits: preferences.minCredits ?? 12,
      maxCredits: preferences.maxCredits ?? 18,
      minCourses: 3,
      maxCourses: 6,
    };
  }

  function _constraintSnapshot(constraints, workingPrefs) {
    return {
      minCredits: constraints.minCredits,
      maxCredits: constraints.maxCredits,
      hardAvoidDays: constraints.hardAvoidDays.slice(),
      calendarBlocks: (constraints.calendarBlocks || []).length,
      lockedCourses: (constraints.lockedCourses || []).length,
      noEarlierThan: workingPrefs.noEarlierThan || null,
      preferOnline: workingPrefs.preferOnline ?? null,
    };
  }

  // Run solve() with several course-orderings and merge results. Each
  // ordering reaches a different region of the search space first, so pooling
  // their results (deduped by section-set signature) produces a diverse pool
  // — the prerequisite for meaningful top-3 tradeoff picks. Single-pass MRV
  // fixates on small-branching courses and yields near-identical schedules.
  function solveMulti(eligible, constraints) {
    const orderings = [
      { ordering: "mrv" },
      { ordering: "reverse-mrv" },
      { ordering: "shuffled", seed: 17 },
      { ordering: "shuffled", seed: 101 },
    ];
    const allResults = [];
    const seen = new Set();
    let totalNodes = 0;
    let capHitAnywhere = false;
    let firstSolved = null;
    for (const opts of orderings) {
      const s = solve(eligible, constraints, opts);
      if (!firstSolved) firstSolved = s;
      totalNodes += s.nodesExplored;
      capHitAnywhere = capHitAnywhere || s.capHit;
      for (const r of s.results) {
        const key = r.picks.map((p) => p.section.crn).sort().join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        allResults.push(r);
      }
      if (allResults.length >= SOLVER_RESULT_CAP) break;
    }
    return {
      ...firstSolved,
      results: allResults,
      nodesExplored: totalNodes,
      capHit: capHitAnywhere,
      passes: orderings.length,
    };
  }

  function solveWithRelaxation(eligible, preferences, studentProfile, lockedCourses, trace) {
    const relaxations = [];
    const attempts = [];
    let constraints = buildConstraints(preferences, studentProfile, lockedCourses);
    let workingPrefs = { ...preferences };

    const t = trace.start("solver", "Searching feasible schedules…");
    let solved = solveMulti(eligible, constraints);
    attempts.push({
      label: "initial",
      constraints: _constraintSnapshot(constraints, workingPrefs),
      viableCourses: solved.coursesWithViableSections,
      viableSections: solved.totalViableSections,
      eliminatedCourses: solved.eliminatedCourses,
      perCourseCounts: solved.perCourseCounts,
      nodesExplored: solved.nodesExplored,
      capHit: solved.capHit,
      results: solved.results.length,
    });
    t.update({ summary: `Pass 1: ${solved.coursesWithViableSections}/${eligible.length} courses viable, ${solved.results.length} unique schedules across ${solved.passes} orderings (${solved.nodesExplored} nodes)` });

    const steps = [
      {
        label: "ignoring 'no mornings' preference",
        apply: () => { workingPrefs.noEarlierThan = null; workingPrefs.morningCutoffWeight = 0; },
        condition: () => (workingPrefs.noEarlierThan && (workingPrefs.morningCutoffWeight ?? 0.5) < 1.0),
      },
      {
        label: "allowing classes on avoid-days",
        apply: () => { constraints.hardAvoidDays = []; workingPrefs.avoidDayWeight = 0; },
        condition: () => constraints.hardAvoidDays.length > 0,
      },
      {
        label: "widening credit target",
        apply: () => { constraints.minCredits = Math.max(9, constraints.minCredits - 3); constraints.maxCredits = Math.min(21, constraints.maxCredits + 3); },
        condition: () => constraints.minCredits > 9,
      },
      {
        label: "dropping online preference",
        apply: () => { workingPrefs.preferOnline = null; workingPrefs.onlineWeight = 0; },
        condition: () => workingPrefs.preferOnline === true,
      },
    ];

    for (const step of steps) {
      if (solved.results.length > 0) break;
      if (!step.condition()) continue;
      step.apply();
      relaxations.push(step.label);
      solved = solveMulti(eligible, constraints);
      attempts.push({
        label: step.label,
        constraints: _constraintSnapshot(constraints, workingPrefs),
        viableCourses: solved.coursesWithViableSections,
        viableSections: solved.totalViableSections,
        eliminatedCourses: solved.eliminatedCourses,
        perCourseCounts: solved.perCourseCounts,
        nodesExplored: solved.nodesExplored,
        capHit: solved.capHit,
        results: solved.results.length,
      });
    }

    if (solved.results.length > 0) {
      t.done({
        summary: `${solved.results.length} feasible schedules${relaxations.length ? ` (relaxed: ${relaxations.join("; ")})` : ""}`,
        capHit: solved.capHit,
        attempts,
      });
    } else {
      t.done({
        summary: `No feasible schedule after ${attempts.length} attempts. Final: ${solved.coursesWithViableSections}/${eligible.length} courses viable, ${solved.totalViableSections} sections`,
        error: "infeasible",
        attempts,
      });
    }

    return { solved, relaxations, constraints, workingPrefs, attempts };
  }

  // ============================================================
  // 11. RATIONALE LLM — grounded, streaming
  //
  // We pass ONLY the structured facts (courses + metrics + honored
  // preferences) and explicitly forbid invention. Streams per-schedule
  // via onRationaleDelta callback.
  // ============================================================

  function buildRationaleFacts(topSchedule, affinityScores, preferences) {
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

  async function callRationales({ topSchedules, affinityScores, preferences, apiKey, trace }) {
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

  // ============================================================
  // 12. ADVISOR LLM — unchanged conceptually from v2
  // ============================================================

  function buildAdvisorPrompt(studentProfile, ragChunks = []) {
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

  async function callAdvisor({ userMessage, studentProfile, conversationHistory, ragChunks, apiKey, trace }) {
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

  // Smart suggestions for the infeasible state, derived from attempt data.
  // We look at what dropped sections to identify the dominant blocker.
  function _infeasibleSuggestions(attempts, eligible, profile) {
    const out = [];
    const last = attempts[attempts.length - 1];
    if (!last) return ["Try easing one restriction or reducing your credit target."];

    // Aggregate drop reasons across ALL eligible courses in the final attempt
    const agg = { missingData: 0, fixedConflict: 0, hardAvoidDay: 0 };
    for (const ec of last.eliminatedCourses || []) {
      agg.missingData += ec.dropReasons.missingData;
      agg.fixedConflict += ec.dropReasons.fixedConflict;
      agg.hardAvoidDay += ec.dropReasons.hardAvoidDay;
    }

    if (agg.hardAvoidDay > agg.fixedConflict && agg.hardAvoidDay > agg.missingData) {
      const days = (last.constraints.hardAvoidDays || []).join("/");
      if (days) out.push(`Many sections meet on ${days} — try softening that day instead of fully blocking it.`);
    }
    if (agg.fixedConflict > 0) {
      const blockCount = last.constraints.calendarBlocks || 0;
      out.push(`Your calendar blocks eliminated ${agg.fixedConflict} candidate section${agg.fixedConflict !== 1 ? "s" : ""}${blockCount ? ` across ${blockCount} block${blockCount !== 1 ? "s" : ""}` : ""}. Consider tightening the block time range.`);
    }
    if (agg.missingData > 0) {
      out.push(`${agg.missingData} section${agg.missingData !== 1 ? "s" : ""} had TBA/missing meeting data and were skipped — these are often project courses or independent study.`);
    }
    if (last.viableCourses < 3) {
      out.push(`Only ${last.viableCourses} course${last.viableCourses !== 1 ? "s" : ""} ${last.viableCourses === 1 ? "has" : "have"} any viable sections after filtering. Broaden your constraints or check this term's offerings.`);
    }
    if (last.constraints.minCredits > 9) {
      out.push(`Credit floor is ${last.constraints.minCredits} — drop to 9 or 12 if you're open to a lighter load.`);
    }
    if (!out.length) {
      out.push("Try easing one restriction — fewer blocked days, wider credit range, or allowing online.");
    }
    return out;
  }

  function _validateCrns(crns, rawData) {
    const eligibleCrns = new Set();
    for (const c of rawData.eligible || []) {
      for (const s of c.sections || []) eligibleCrns.add(String(s.courseReferenceNumber));
    }
    return (crns || []).filter((crn) => eligibleCrns.has(String(crn)));
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

  async function handleUserTurn({
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
    affinityCache.clear();

    // Stage 1: Intent
    const intent = await callIntent({ userMessage, studentProfile, ragChunks, apiKey, trace });
    // Rescue weight calibration with deterministic hedge/hard overrides.
    calibrateIntentWeights(intent, userMessage);

    // Merge new blocks/avoid days into a working profile
    const updatedProfile = {
      ...studentProfile,
      calendarBlocks: mergeCalendarBlocks(studentProfile.calendarBlocks, intent.newCalendarBlocks || []),
      avoidDays: Array.from(new Set([...(studentProfile.avoidDays || []), ...(intent.newAvoidDays || [])])),
    };

    // Context recap fires before expensive work so student can catch misreads
    actions.push({
      type: "show_context_recap",
      recap: intent.recap || "",
      ambiguities: intent.ambiguities || [],
      confidence: intent.confidence ?? 1,
    });

    // Emit block/avoid-day actions immediately so extension persists & renders
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
        trace
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

      // Stage 4: Score + pick top 3
      const t4 = trace.start("rank", `Ranking ${solved.results.length} schedules across 3 tradeoffs…`);
      const topSchedules = pickTop3(solved.results, workingPrefs, affinityScores);
      t4.done({ summary: `Top 3: ${topSchedules.map((s) => s.label).join(" · ")}` });

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

  // ============================================================
  // 14. GOLDEN-PROMPTS FIXTURE RUNNER
  // Run via window.BP.runFixture(fixture, { apiKey, rawData, profile })
  // Fixture entries declare property-test assertions, not exact matches.
  // ============================================================

  async function runFixture(fixture, { apiKey, rawData, studentProfile }) {
    const results = [];
    for (const entry of fixture) {
      const profile = { ...studentProfile, calendarBlocks: [], avoidDays: [] };
      let turnResult;
      try {
        turnResult = await handleUserTurn({
          userMessage: entry.prompt, rawData, studentProfile: profile,
          conversationHistory: [], lockedCourses: [], apiKey,
        });
      } catch (e) {
        results.push({ name: entry.name, pass: false, failures: [`threw: ${e.message}`] });
        continue;
      }
      const failures = [];
      for (const assertion of entry.assertions) {
        try {
          if (!assertion.check(turnResult)) failures.push(assertion.name);
        } catch (e) { failures.push(`${assertion.name} threw: ${e.message}`); }
      }
      results.push({
        name: entry.name, pass: failures.length === 0, failures,
        turnResult,
      });
    }
    return results;
  }

  // ============================================================
  // EXPORTS
  // ============================================================

  Object.assign(BP, {
    // Primary API
    handleUserTurn,
    buildStudentProfile,
    mergeCalendarBlocks,
    // Exposed internals for testing / future reuse
    compressForSolver,
    validateSchedule,
    solve,
    pickTop3,
    scoreSchedule,
    callIntent, callAffinity, callRationales, callAdvisor,
    calibrateIntentWeights,
    createTrace,
    runFixture,
    INTENT_SCHEMA_VERSION,
  });

  // Back-compat window globals (tab.js consumes these names)
  window.handleUserTurn = handleUserTurn;
  window.buildStudentProfile = buildStudentProfile;
  window.mergeCalendarBlocks = mergeCalendarBlocks;
  // Clear old affinity cache on term switch — called by tab.js on term change
  window.clearAffinityCache = () => affinityCache.clear();
})();
