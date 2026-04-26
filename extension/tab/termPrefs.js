// ============================================================
// TERM PREFS — calendar blocks + avoid-days keyed by Banner
// term code (SCRUM-21). Legacy flat chrome.storage keys are
// migrated once under the active term at load time.
// ============================================================

import * as State from "./state.js";

export const KEYS = {
  blocksByTerm: "calendarBlocksByTerm",
  daysByTerm: "avoidDaysByTerm",
};

export const LEGACY_BLOCKS = "calendarBlocks";
export const LEGACY_DAYS = "avoidDays";

/** Keys to read on boot / when switching terms (legacy + new). */
export const CALENDAR_PREFS_STORAGE_KEYS = [
  KEYS.blocksByTerm,
  KEYS.daysByTerm,
  LEGACY_BLOCKS,
  LEGACY_DAYS,
];

function cloneTermMap(m) {
  if (!m || typeof m !== "object") return Object.create(null);
  const o = Object.create(null);
  for (const k of Object.keys(m)) {
    const v = m[k];
    o[k] = Array.isArray(v) ? v.slice() : v;
  }
  return o;
}

export function storageLocalGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

export function storageLocalSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, resolve);
  });
}

export function storageLocalRemove(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, resolve);
  });
}

/**
 * Hydrate State.calendarBlocks / State.avoidDays from resolved maps.
 */
export function hydrateCalendarPrefsForTerm(term, blocksByTerm, daysByTerm) {
  const t = String(term);
  const b = blocksByTerm && blocksByTerm[t];
  const d = daysByTerm && daysByTerm[t];
  State.setCalendarBlocks(Array.isArray(b) ? b : []);
  State.setAvoidDays(Array.isArray(d) ? d : []);
  if (State.studentProfile) {
    State.studentProfile.calendarBlocks = State.calendarBlocks;
    State.studentProfile.avoidDays = State.avoidDays;
  }
}

/**
 * Resolve maps from a chrome.storage.local result, migrate legacy flat
 * keys into the term bucket when the term slot is still empty, persist
 * if anything changed, return final maps for hydration.
 */
export async function resolveAndMigrateCalendarPrefs(raw, term) {
  const t = String(term);
  let blocksByTerm = cloneTermMap(raw[KEYS.blocksByTerm]);
  let daysByTerm = cloneTermMap(raw[KEYS.daysByTerm]);

  const removeLegacy = [];
  let mapsChanged = false;

  if (Object.prototype.hasOwnProperty.call(raw, LEGACY_BLOCKS)) {
    if (blocksByTerm[t] === undefined) {
      blocksByTerm[t] = Array.isArray(raw[LEGACY_BLOCKS]) ? raw[LEGACY_BLOCKS] : [];
      mapsChanged = true;
    }
    removeLegacy.push(LEGACY_BLOCKS);
  }

  if (Object.prototype.hasOwnProperty.call(raw, LEGACY_DAYS)) {
    if (daysByTerm[t] === undefined) {
      const a = raw[LEGACY_DAYS];
      daysByTerm[t] = Array.isArray(a) ? a.slice() : [];
      mapsChanged = true;
    }
    removeLegacy.push(LEGACY_DAYS);
  }

  if (mapsChanged) {
    await storageLocalSet({
      [KEYS.blocksByTerm]: blocksByTerm,
      [KEYS.daysByTerm]: daysByTerm,
    });
  }
  if (removeLegacy.length) {
    await storageLocalRemove([...new Set(removeLegacy)]);
  }

  return { blocksByTerm, daysByTerm };
}

/** Load maps from storage for `term`, migrate legacy if present, hydrate State. */
export async function loadCalendarPrefsForTerm(term) {
  const raw = await storageLocalGet([
    KEYS.blocksByTerm,
    KEYS.daysByTerm,
    LEGACY_BLOCKS,
    LEGACY_DAYS,
  ]);
  const { blocksByTerm, daysByTerm } = await resolveAndMigrateCalendarPrefs(raw, term);
  hydrateCalendarPrefsForTerm(term, blocksByTerm, daysByTerm);
}

export async function persistCalendarBlocksForTerm(term, blocks) {
  const t = String(term);
  const raw = await storageLocalGet([KEYS.blocksByTerm]);
  const next = cloneTermMap(raw[KEYS.blocksByTerm]);
  next[t] = blocks;
  await storageLocalSet({ [KEYS.blocksByTerm]: next });
}

export async function persistAvoidDaysForTerm(term, days) {
  const t = String(term);
  const raw = await storageLocalGet([KEYS.daysByTerm]);
  const next = cloneTermMap(raw[KEYS.daysByTerm]);
  next[t] = days;
  await storageLocalSet({ [KEYS.daysByTerm]: next });
}
