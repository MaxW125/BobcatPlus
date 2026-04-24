// scheduler/profile.js — student profile + course data compression
// Extracted from scheduleGenerator.js section 2. Pure, no OpenAI calls.

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
  const m = courseName.match(/^([A-Z]+)\s+(\d)(\d)(\d{2})$/);
  if (!m) return [];
  const [, subj, first, second, tail] = m;
  const candidates = [];
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

export function compressForSolver(rawData) {
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

export function buildStudentProfile({
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

export function mergeCalendarBlocks(existing = [], incoming = []) {
  const map = new Map(existing.map((b) => [b.label.toLowerCase(), b]));
  for (const block of incoming) map.set(block.label.toLowerCase(), block);
  return Array.from(map.values());
}
