/**
 * Shared course chip colors for full tab calendar + popup mini-calendar.
 * Uses localStorage bobcat_course_colors so both UIs stay in sync.
 */
const TXST_CHIPS = [
  "chip-0",
  "chip-1",
  "chip-2",
  "chip-3",
  "chip-4",
  "chip-5",
  "chip-6",
  "chip-7",
];

function getCourseColors() {
  try {
    return JSON.parse(localStorage.getItem("bobcat_course_colors") || "{}");
  } catch (e) {
    return {};
  }
}

function saveCourseColors(map) {
  try {
    localStorage.setItem("bobcat_course_colors", JSON.stringify(map));
  } catch (e) {}
}

function getChipForCourse(courseKey) {
  const map = getCourseColors();
  if (!map[courseKey]) {
    const used = Object.values(map);
    const available = TXST_CHIPS.filter((c) => !used.includes(c));
    const pool = available.length > 0 ? available : TXST_CHIPS;
    map[courseKey] = pool[Math.floor(Math.random() * pool.length)];
    saveCourseColors(map);
  }
  return map[courseKey];
}
