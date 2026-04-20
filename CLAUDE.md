# Bobcat Plus — CLAUDE.md

AI-powered schedule planner Chrome extension for Texas State University.
Scrapes Banner (registration) and DegreeWorks (degree audit) to show
what courses a student still needs, which are open this term, and lets
an AI or the student build a conflict-free weekly schedule.

---

## Project layout

```
extension/
  manifest.json       MV3 manifest — permissions, host_permissions
  background.js       Service worker: degree audit parsing, Banner API calls,
                      caching, session mutex, prereq checking, plan management
  tab.js              Full-page UI: calendar renderer, eligible course list,
                      AI chat panel, schedule save/load, modal
  tab.html            Shell HTML for the full-page tab
  tab.css             All styles (CSS custom properties, chip colors, panels)
  popup.html/js       Small toolbar popup (minimal — mostly defers to tab)
  facultyScraper.js   RateMyProfessor / faculty directory scraping
  courseColors.js     Deterministic chip color assignment per course
  images/             TXST star logo, generic profile avatar
```

---

## Architecture

### Two separate execution contexts

| Context | File | Talks to |
|---|---|---|
| Service worker | `background.js` | DegreeWorks API, Banner API, chrome.storage |
| Tab page | `tab.js` | background.js via chrome.runtime.sendMessage |

**Never** import tab.js functions into background.js or vice versa. They
communicate only through message passing.

### Session mutex — critical

Banner's registration endpoints are stateful: every POST to
`term/search?mode=search` sets server-side session state that the next
`getResults` call reads. Parallel calls corrupt each other.

All Banner POSTs in background.js are wrapped in `withSessionLock`:

```js
let sessionQueue = Promise.resolve();
function withSessionLock(fn) {
  const task = sessionQueue.then(fn, fn); // fn runs after previous task settles
  sessionQueue = task.then(() => {}, () => {}); // swallow rejection so queue continues
  return task;
}
```

tab.js has an identical `queueRegistrationFetch` / `registrationFetchQueue`
for its own `getCurrentSchedule` calls (tab and background share the
Banner session cookie but run in different JS contexts, so they each
need their own queue).

**Rule:** any new Banner fetch that calls `term/search` or `getResults`
MUST go inside `withSessionLock` (background) or `queueRegistrationFetch`
(tab). Do not add bare fetches to these endpoints.

### Analysis cancellation

Long-running analyses (searching 10–20 courses sequentially) must bail
when the user switches terms. Pattern:

```js
let analysisGeneration = 0;
// On term change: bump generation, send cancelAnalysis, clear UI
chrome.runtime.sendMessage({ action: "cancelAnalysis" });

// In runAnalysis:
const gen = ++analysisGeneration;
const isCurrent = () => analysisGeneration === gen;
const bail = () => !isCurrent();
// ... after every await:
if (bail()) return;
```

### Caching (chrome.storage.local)

```js
const CACHE_TTL = {
  course: 1h,    // Banner section search results (seats change)
  prereq: 24h,   // Prerequisites HTML (fixed once schedule publishes)
  desc:   7d,    // Course descriptions (static)
  terms:  24h,   // Term list
};
```

Cache keys: `course|{term}|{subject}|{courseNumber}`, `prereq|{term}|{crn}`,
`desc|{term}|{crn}`.

Use `cacheGet(key, ttl)` / `cacheSet(key, data)` — never write to
chrome.storage.local directly for course data.

---

## Key data flows

### Eligible course pipeline

```
getStudentInfo()              → student ID, school, degree
  ↓
getAuditData(id, school, deg) → { completed[], inProgress[], needed[] }
  ↓ (needed = degree rules with no classes yet applied, non-wildcard)
searchCourse(subj, num, term) → sections[] (Banner search, cached 1h)
  ↓
checkPrereqs(crn, term, ...)  → { met: bool, missing: string[] }
  ↓
getCourseDescription(crn, term) → string (cached 7d)
  ↓
eligible[] | blocked[] | notOffered[]
```

### Working schedule (tab.js)

`workingCourses` — array of course entries on the calendar.  
`lockedCrns` — Set of CRN strings that are pinned.

Mutation functions (always call `renderCalendarFromWorkingCourses` after):
- `addToWorkingSchedule(entry)` — replaces by CRN, transfers lock if same course
- `removeFromWorkingSchedule(crn)` — removes + unlocks
- `toggleLock(crn)` — flips lock state

---

## Known limitations

### Elective pools are invisible

DegreeWorks represents "CS Advanced Electives" and "Minor in Music" as
wildcard rules (`course.number === "@"`). These are filtered out of
`needed` because Banner can't search for `@`. Fix: scrape the TXST
course catalog for each elective pool once per catalog year and expand
wildcards against that list before running `searchCourse`.

### Prereq grade index alignment

`checkPrereqGroup` aligns `gradeMatches[i]` to `prereqMatches[i]` by
position in the HTML text. If a prerequisite has no explicit minimum
grade, subsequent grades shift by one position. Mitigation: Banner
almost always emits one grade line per prereq; this is a theoretical
bug in practice but worth a proper fix if prereq checks start failing.

### classesAppliedToRule skips partially-done pools

`findNeeded` skips an entire requirement rule if any class has already
been applied to it. For pool requirements that need N courses (e.g.,
"3 of 9 credits done"), once 1 course is applied the remaining needed
courses disappear from the list. Would need to check against
`percentComplete` rather than presence of any applied class.

---

## Branch + deploy workflow

- **main** — stable, deployed to the Chrome Web Store (eventually)
- **Demo** — demo-ready branch used for showing to external people
- **feature branches** — `git checkout -b my-feature Demo`

Active development happens in a Claude Code worktree at
`.claude/worktrees/<name>/`. After commits land there, cherry-pick to
Demo and push:

```bash
git cherry-pick <sha>            # from Demo branch
git push origin Demo
```

Merge Demo → main via PR when a milestone is stable.

---

## Files NOT to touch carelessly

| File | Risk |
|---|---|
| `background.js` — `withSessionLock` / `sessionQueue` | Removing or bypassing this causes cross-term race conditions that are hard to reproduce and silent |
| `background.js` — `runAnalysis` `bail()` checks | Removing any of the `if (bail()) return` guards causes stale analyses to mutate UI after term switch |
| `background.js` — `getAuditData` `findNeeded` | Logic that decides what courses to surface; test with real audit data before changing |
| `tab.js` — `addToWorkingSchedule` | Replaces by CRN AND transfers lock — keep both behaviors together |

---

## External APIs

| API | Base URL | Auth | Notes |
|---|---|---|---|
| DegreeWorks | `dw-prod.ec.txstate.edu/responsiveDashboard/api` | Session cookie | Requires TXST SSO login |
| Banner registration | `reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb` | Session cookie | Stateful — use session mutex |
| AI (n8n webhook) | `ml3392.app.n8n.cloud` | None (webhook secret in n8n) | Routes to OpenAI |
| RateMyProfessor | GraphQL via facultyScraper.js | None | Public GraphQL API |

All TXST APIs require the user to be logged in to the TXST portal.
The extension detects auth failure and prompts an Import/login flow.

---

## Common tasks

**Add a new Banner endpoint:**
1. Wrap in `withSessionLock` if it calls `term/search` first
2. Add caching if the response is reusable (use `cacheGet`/`cacheSet`)
3. Handle `if (bail()) return` if it's called inside `runAnalysis`

**Add a new UI panel section:**
1. Add HTML to `tab.html`
2. Add CSS to `tab.css` (use CSS custom properties, not hard-coded colors)
3. Wire up in `tab.js` — keep render functions pure (no side effects other
   than DOM mutation)

**Change what courses appear as eligible:**
- Edit `findNeeded` in `background.js` — this is the source of truth
- Test by loading the extension on your TXST account and checking the
  Build panel against your actual DegreeWorks audit

**Add a new chip color:**
- Edit `courseColors.js` and add a `chip-N` class to `tab.css`
- Colors should be legible on the white calendar background at 10% opacity
