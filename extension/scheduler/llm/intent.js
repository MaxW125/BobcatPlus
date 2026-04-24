// scheduler/llm/intent.js — frozen IntentSchema v1 + weight calibrator
// Extracted from scheduleGenerator.js section 6.
//
// COUPLING RULE (invariant #2 — enforced by file boundary):
// buildIntentPrompt, INTENT_SCHEMA_VERSION, calibrateIntentWeights, and
// callIntent MUST all live in this file and change in one diff. They form
// a single behavioral unit: the schema version embedded in the prompt
// determines the shape callIntent normalizes, and calibrateIntentWeights
// corrects the weights that prompt instructs the LLM to set. Splitting them
// across files or commits creates a window where schema and calibration
// diverge silently. See docs/invariants.md #2 and docs/plans/scheduler-refactor.md.
//
// PROMPT FREEZE: the string inside buildIntentPrompt is the live production
// prompt. Do NOT edit it in this commit or any commit that isn't exclusively
// a prompt-engineering change reviewed against production traces.
//
// Depends on: ./openai.js

import { openaiJson } from "./openai.js";

// All downstream stages consume this shape. Changes to this schema cascade;
// treat as a contract. The `confidence` and `ambiguities` fields are how the
// intent call signals uncertainty back to the UI.
export const INTENT_SCHEMA_VERSION = 1;

export function buildIntentPrompt(studentProfile, ragChunks = []) {
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
  "removeAvoidDays": ["Mon","Wed"],
  "resetAvoidDays": false,
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
    "lateCutoffWeight": 0.0-1.0 | null,
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
- Bare declarative phrasing with "no" is FIRM, not soft:
    "no mornings" / "no classes before noon" / "no classes on Friday"
    / "no online classes" → 1.0 (the student is stating a rule, not a preference).
- Only use < 1.0 when the student actually hedges:
    "preferably no mornings" / "ideally done by 5" / "would like to avoid Fridays" = 0.7.
    "really prefer afternoons" = 0.8.
- "absolutely no mornings" / "cannot do mornings" / "never before 10" = 1.0.
- "done by 5pm" / "out by 5" / "finish by 3" → noLaterThan: "1700" / "1500", lateCutoffWeight 1.0 if bare, 0.6–0.8 if hedged.
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

AVOID-DAY EXTRACTION (includes POSITIVE FRAMING):
- "keep Friday clear" / "no Monday classes" → newAvoidDays: ["Fri"] / ["Mon"]
- POSITIVE framing like "only on Tue and Thu" / "just T/Th" / "put everything on Tuesday
  and Thursday" means the OTHER weekdays are avoid days. For "only Tue/Thu" emit
  newAvoidDays: ["Mon","Wed","Fri"]. For "only on MWF" emit newAvoidDays: ["Tue","Thu"].
- Reset language like "actually", "instead", "nevermind", "let's just do", "now just",
  "forget that" in combination with a new day preference signals the student is REPLACING
  their prior avoid days, not adding. In that case:
    • set resetAvoidDays: true (the orchestrator wipes existing avoidDays)
    • emit only the NEW avoid days in newAvoidDays
  Example: prior avoidDays=["Mon","Wed","Fri"], user says "actually just no Friday" →
    resetAvoidDays: true, newAvoidDays: ["Fri"], removeAvoidDays: []
- Explicit removal like "I can do Mondays again" / "drop the Wednesday block" →
  removeAvoidDays: ["Mon"] / ["Wed"]. Do not set resetAvoidDays here.
- Default: resetAvoidDays: false, removeAvoidDays: [].

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
// Declarative-no: plain "no X" where X is a scheduling noun the student only
// uses when stating a rule. Live-trace evidence (docs/postmortems/
// bug1-morning-preference.md) showed the intent LLM returns 0.6 for "no classes before noon"
// and HARD_PATTERN didn't rescue it, so the weight-1.0 → hard-constraint
// promotion in buildConstraints never fired in production.
// Scoped narrowly to avoid false positives like "no problem", "no clue",
// "no preference", "no strong feelings about mornings".
const DECLARATIVE_NO_PATTERN = /\bno\s+(?:class(?:es)?|morning|mornings|afternoon|afternoons|evening|evenings|night|nights|early|late|online|remote|in[- ]?person|on[- ]?campus|(?:mon|tues?|wed(?:nes)?|thur?s?|fri)(?:day)?s?)\b/;

function _clausesMentioning(msg, keywords) {
  const lower = (msg || "").toLowerCase();
  const clauses = lower.split(/[,.;:!?\n]/);
  return clauses.filter((c) => keywords.some((k) => c.includes(k)));
}

function _calibrate(weight, clauses) {
  if (!clauses.length) return weight;
  const anyHedge = clauses.some((c) => HEDGE_PATTERN.test(c));
  const anyHard = clauses.some(
    (c) => HARD_PATTERN.test(c) || DECLARATIVE_NO_PATTERN.test(c),
  );
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

export function calibrateIntentWeights(intent, userMessage) {
  if (!intent || !intent.statedPreferences) return intent;
  const prefs = intent.statedPreferences;
  const dayNames = ["monday","tuesday","wednesday","thursday","friday","mon ","tue ","wed ","thu ","fri "];
  const morningKw = ["morning","before 8","before 9","before 10","before 11","before noon","am ","early"," early"];
  const lateKw = ["done by","end by","finish by","out by","over by","home by","evening","night","late","after 5","after 6","after 7","pm "];
  const onlineKw = ["online","remote","async","asynchronous","in person","in-person","on campus"];
  const careerKw = ["career","goal","into ","interested","passionate","love","hate","want to","plan to"];

  prefs.morningCutoffWeight = _calibrate(prefs.morningCutoffWeight, _clausesMentioning(userMessage, morningKw));
  prefs.lateCutoffWeight = _calibrate(prefs.lateCutoffWeight, _clausesMentioning(userMessage, lateKw));
  prefs.avoidDayWeight = _calibrate(prefs.avoidDayWeight, _clausesMentioning(userMessage, dayNames));
  prefs.onlineWeight = _calibrate(prefs.onlineWeight, _clausesMentioning(userMessage, onlineKw));
  prefs.careerAffinityWeight = _calibrate(prefs.careerAffinityWeight, _clausesMentioning(userMessage, careerKw));

  intent.statedPreferences = prefs;
  return intent;
}

export async function callIntent({ userMessage, studentProfile, ragChunks, apiKey, trace }) {
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
    json.removeAvoidDays = Array.isArray(json.removeAvoidDays) ? json.removeAvoidDays : [];
    json.resetAvoidDays = json.resetAvoidDays === true;
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
