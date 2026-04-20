/**
 * Bobcat Plus — faculty email lookup from public TXST department pages.
 * Runs in extension page context (e.g. tab.js) where fetch + DOMParser are allowed.
 *
 * API: window.BobcatFaculty (see bottom). Wire UI later; use getInstructorEmail().
 */

const DEPT_MAP = {
  CS: {
    url: "https://cs.txst.edu/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Computer%20Science&page=1&perpage=200",
  },
  MATH: {
    url: "https://www.math.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Mathematics&page=1&perpage=200",
  },
  PHYS: {
    url: "https://www.physics.txst.edu/about/people/faculty.html",
    fallback: "https://faculty.txst.edu/search?dept=Physics&page=1&perpage=200",
  },
  AST: {
    url: "https://www.physics.txst.edu/about/people/faculty.html",
    fallback: "https://faculty.txst.edu/search?dept=Physics&page=1&perpage=200",
  },
  BIO: {
    url: "https://www.bio.txst.edu/about/people/faculty.html",
    fallback: "https://faculty.txst.edu/search?dept=Biology&page=1&perpage=200",
  },
  BIOL: {
    url: "https://www.bio.txst.edu/about/people/faculty.html",
    fallback: "https://faculty.txst.edu/search?dept=Biology&page=1&perpage=200",
  },
  CHEM: {
    url: "https://www.chem.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Chemistry%20and%20Biochemistry&page=1&perpage=200",
  },
  BICH: {
    url: "https://www.chem.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Chemistry%20and%20Biochemistry&page=1&perpage=200",
  },
  EE: {
    url: "https://www.engineering.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Ingram%20School%20of%20Engineering&page=1&perpage=200",
  },
  CE: {
    url: "https://www.engineering.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Ingram%20School%20of%20Engineering&page=1&perpage=200",
  },
  ME: {
    url: "https://www.engineering.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Ingram%20School%20of%20Engineering&page=1&perpage=200",
  },
  IE: {
    url: "https://www.engineering.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Ingram%20School%20of%20Engineering&page=1&perpage=200",
  },
  ENGR: {
    url: "https://www.engineering.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Ingram%20School%20of%20Engineering&page=1&perpage=200",
  },
  ET: {
    url: "https://www.et.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Department%20of%20Engineering%20Technology&page=1&perpage=200",
  },
  AG: {
    url: "https://ag.txst.edu/faculty-staff.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Department%20of%20Agricultural%20Sciences&page=1&perpage=200",
  },
  AGRI: {
    url: "https://ag.txst.edu/faculty-staff.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Department%20of%20Agricultural%20Sciences&page=1&perpage=200",
  },
  ANSC: {
    url: "https://ag.txst.edu/faculty-staff.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Department%20of%20Agricultural%20Sciences&page=1&perpage=200",
  },
  ENG: {
    url: "https://www.english.txst.edu/about/people/faculty-directory.html",
    fallback: "https://faculty.txst.edu/search?dept=English&page=1&perpage=200",
  },
  ENGL: {
    url: "https://www.english.txst.edu/about/people/faculty-directory.html",
    fallback: "https://faculty.txst.edu/search?dept=English&page=1&perpage=200",
  },
  HIST: {
    url: "https://www.history.txst.edu/about/people/faculty.html",
    fallback: "https://faculty.txst.edu/search?dept=History&page=1&perpage=200",
  },
  POLS: {
    url: "https://www.polisci.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Political%20Science&page=1&perpage=200",
  },
  PSYC: {
    url: "https://www.psych.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Psychology&page=1&perpage=200",
  },
  PSY: {
    url: "https://www.psych.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Psychology&page=1&perpage=200",
  },
  SOC: {
    url: "https://www.soc.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Sociology&page=1&perpage=200",
  },
  SOCI: {
    url: "https://www.soc.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Sociology&page=1&perpage=200",
  },
  ANTH: {
    url: "https://www.anth.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Anthropology&page=1&perpage=200",
  },
  GEOG: {
    url: "https://www.geo.txst.edu/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20Geography%20%26%20Environmntl%20Studies&page=1&perpage=200",
  },
  GEO: {
    url: "https://www.geo.txst.edu/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20Geography%20%26%20Environmntl%20Studies&page=1&perpage=200",
  },
  PHIL: {
    url: "https://www.phil.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Philosophy&page=1&perpage=200",
  },
  WL: {
    url: "https://www.wll.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20World%20Languages%20%26%20Literatures&page=1&perpage=200",
  },
  SPAN: {
    url: "https://www.wll.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20World%20Languages%20%26%20Literatures&page=1&perpage=200",
  },
  FR: {
    url: "https://www.wll.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20World%20Languages%20%26%20Literatures&page=1&perpage=200",
  },
  GER: {
    url: "https://www.wll.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20World%20Languages%20%26%20Literatures&page=1&perpage=200",
  },
  COMM: {
    url: "https://www.commstudies.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Department%20of%20Communication%20Studies&page=1&perpage=200",
  },
  IS: {
    url: "https://www.internationalstudies.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=International%20Studies%20Program&page=1&perpage=200",
  },
  ACC: {
    url: "https://www.mccoy.txst.edu/departments/accounting/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Department%20of%20Accounting&page=1&perpage=200",
  },
  ACCT: {
    url: "https://www.mccoy.txst.edu/departments/accounting/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Department%20of%20Accounting&page=1&perpage=200",
  },
  MGT: {
    url: "https://www.mccoy.txst.edu/departments/management/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Department%20of%20Management&page=1&perpage=200",
  },
  MKT: {
    url: "https://www.mccoy.txst.edu/departments/marketing/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Department%20of%20Marketing&page=1&perpage=200",
  },
  FIN: {
    url: "https://www.mccoy.txst.edu/departments/finance-economics/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Finance%20%26%20Economics&page=1&perpage=200",
  },
  ECON: {
    url: "https://www.mccoy.txst.edu/departments/finance-economics/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Finance%20%26%20Economics&page=1&perpage=200",
  },
  ISA: {
    url: "https://www.mccoy.txst.edu/departments/information-systems-analytics/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20Information%20Systems%20%26%20Analytics&page=1&perpage=200",
  },
  CIS: {
    url: "https://www.mccoy.txst.edu/departments/information-systems-analytics/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20Information%20Systems%20%26%20Analytics&page=1&perpage=200",
  },
  CJ: {
    url: "https://www.cj.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Criminal%20Justice%20%26%20Criminology&page=1&perpage=200",
  },
  SW: {
    url: "https://www.socialwork.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Social%20Work&page=1&perpage=200",
  },
  FCS: {
    url: "https://www.fcs.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Family%20%26%20Consumer%20Sciences&page=1&perpage=200",
  },
  NUTR: {
    url: "https://www.fcs.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Family%20%26%20Consumer%20Sciences&page=1&perpage=200",
  },
  OWLS: {
    url: "https://www.owls.txst.edu/about-us/department-directory.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Org%2C%20Wkforce%2C%20%26%20Ldrshp%20Studies&page=1&perpage=200",
  },
  CI: {
    url: "https://www.education.txst.edu/ci/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Curriculum%20And%20Instruction&page=1&perpage=200",
  },
  EDUC: {
    url: "https://www.education.txst.edu/ci/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Curriculum%20And%20Instruction&page=1&perpage=200",
  },
  HHP: {
    url: "https://www.hhp.txst.edu/about/faculty-profiles.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20Health%20%26%20Human%20Performance&page=1&perpage=200",
  },
  KINE: {
    url: "https://www.hhp.txst.edu/about/faculty-profiles.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20Health%20%26%20Human%20Performance&page=1&perpage=200",
  },
  PHED: {
    url: "https://www.hhp.txst.edu/about/faculty-profiles.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20Health%20%26%20Human%20Performance&page=1&perpage=200",
  },
  COUN: {
    url: "https://www.education.txst.edu/clas/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Conslng%2C%20Ldrship%2C%20Adlt%20Educ%20%26%20Schl%20Psych&page=1&perpage=200",
  },
  ART: {
    url: "https://www.art.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Art%20and%20Design&page=1&perpage=200",
  },
  MUS: {
    url: "https://www.music.txst.edu/info/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Music&page=1&perpage=200",
  },
  MUSI: {
    url: "https://www.music.txst.edu/info/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Music&page=1&perpage=200",
  },
  THEA: {
    url: "https://www.theatredancefilm.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Theatre%2C%20Dance%2C%20%26%20Film&page=1&perpage=200",
  },
  DANC: {
    url: "https://www.theatredancefilm.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Theatre%2C%20Dance%2C%20%26%20Film&page=1&perpage=200",
  },
  FILM: {
    url: "https://www.theatredancefilm.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Theatre%2C%20Dance%2C%20%26%20Film&page=1&perpage=200",
  },
  MC: {
    url: "https://www.journalism.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Jrnlism%20%26%20Mass%20Comm&page=1&perpage=200",
  },
  MCOM: {
    url: "https://www.journalism.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Jrnlism%20%26%20Mass%20Comm&page=1&perpage=200",
  },
  NUR: {
    url: "https://www.nursing.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=St.%20David's%20School%20of%20Nursing&page=1&perpage=200",
  },
  NURS: {
    url: "https://www.nursing.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=St.%20David's%20School%20of%20Nursing&page=1&perpage=200",
  },
  PT: {
    url: "https://www.pt.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Department%20of%20Physical%20Therapy&page=1&perpage=200",
  },
  RC: {
    url: "https://www.rc.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Department%20of%20Respiratory%20Care&page=1&perpage=200",
  },
  CDS: {
    url: "https://www.commdisorders.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Communication%20Disorders&page=1&perpage=200",
  },
  HIM: {
    url: "https://www.him.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=Dept%20of%20Health%20Informatics%20and%20Info%20Mgmt&page=1&perpage=200",
  },
  HA: {
    url: "https://www.healthadmin.txst.edu/about/people/faculty.html",
    fallback:
      "https://faculty.txst.edu/search?dept=School%20of%20Health%20Administration&page=1&perpage=200",
  },
};

/** When subject prefix is not in DEPT_MAP — broad directory search (match by instructor name). */
const UNKNOWN_DEPT_CONFIG = {
  url: "https://faculty.txst.edu/search?page=1&perpage=400",
  fallback: "https://faculty.txst.edu/search?page=2&perpage=400",
};

const STORAGE_KEY = "bobcat_faculty_cache_v1";
/** Default 7-day TTL; bump if directory HTML is stable longer */
let facultyCacheTtlMs = 7 * 24 * 60 * 60 * 1000;

/** In-memory cache: primary faculty page URL → faculty list */
const _cache = {};
/** In-flight fetches so concurrent calls share one network request */
const _inFlight = {};

function getDeptConfig(courseCode) {
  if (!courseCode || typeof courseCode !== "string") return null;
  const prefix = courseCode.trim().split(/\s+/)[0].toUpperCase();
  if (!prefix) return null;
  return DEPT_MAP[prefix] || UNKNOWN_DEPT_CONFIG;
}

function isTxstEmail(email) {
  const e = String(email || "").toLowerCase();
  return e.includes("@txstate.edu") || e.includes("@txst.edu");
}

function extractMailtoEmail(href) {
  const raw = href.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
  return raw;
}

function parseMailtoFaculty(doc) {
  const results = [];
  const seen = new Set();

  doc.querySelectorAll('a[href*="mailto"]').forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (!href.toLowerCase().includes("mailto")) return;
    const email = extractMailtoEmail(href);
    if (!isTxstEmail(email) || seen.has(email)) return;
    seen.add(email);

    let name = "";
    let title = "";
    const container = a.closest(
      "li, article, div.person, div.faculty, div.profile, tr, .views-row, .field-content, td, section",
    );
    if (container) {
      const heading = container.querySelector(
        "h2, h3, h4, strong.name, .person-name, .field-name",
      );
      if (heading) {
        name = heading.textContent.trim();
      } else {
        const texts = [];
        container.querySelectorAll("*").forEach((el) => {
          el.childNodes.forEach((n) => {
            if (n.nodeType === 3 && n.textContent.trim().length > 3)
              texts.push(n.textContent.trim());
          });
        });
        name = texts[0] || "";
      }
      const titleEl = container.querySelector(
        ".title, .rank, .position, .field-title, p.title",
      );
      if (titleEl) title = titleEl.textContent.trim();
    }

    name = name
      .replace(/^email\s+/i, "")
      .replace(/\s+at\s+[\w.]+@[\w.]+\s*$/i, "")
      .trim();

    results.push({ name, email, title });
  });

  return results;
}

/** Secondary parse: visible emails in profile-like blocks (handles pages that omit mailto:). */
function parseLooseEmailsInContainers(doc) {
  const results = [];
  const seen = new Set();

  doc
    .querySelectorAll(
      "li, article, .views-row, .person, .faculty, tr, section, .field-content",
    )
    .forEach((container) => {
      const blockText = container.textContent || "";
      if (blockText.length > 8000) return;
      const re =
        /\b([A-Za-z0-9._%+-]+@(txstate|txst)\.edu)\b/gi;
      let m;
      while ((m = re.exec(blockText)) !== null) {
        const email = m[1].toLowerCase();
        if (seen.has(email)) continue;
        seen.add(email);

        let name = "";
        const heading = container.querySelector(
          "h2, h3, h4, strong.name, .person-name, .field-name",
        );
        if (heading) name = heading.textContent.trim();

        results.push({ name, email, title: "" });
      }
    });

  doc.querySelectorAll("[data-email]").forEach((el) => {
    const email = String(el.getAttribute("data-email") || "")
      .trim()
      .toLowerCase();
    if (!isTxstEmail(email) || seen.has(email)) return;
    seen.add(email);
    const container =
      el.closest(
        "li, article, .views-row, .person, tr, section",
      ) || el.parentElement;
    let name = "";
    if (container) {
      const heading = container.querySelector(
        "h2, h3, h4, strong.name, .person-name, .field-name",
      );
      if (heading) name = heading.textContent.trim();
    }
    results.push({ name, email, title: "" });
  });

  return results;
}

function dedupeFacultyByEmail(rows) {
  const byEmail = new Map();
  for (const r of rows) {
    if (!r.email) continue;
    const prev = byEmail.get(r.email);
    if (
      !prev ||
      String(r.name || "").length > String(prev.name || "").length
    ) {
      byEmail.set(r.email, r);
    }
  }
  return [...byEmail.values()];
}

function parseFacultyFromHTML(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const primary = parseMailtoFaculty(doc);
  const loose = parseLooseEmailsInContainers(doc);

  let merged = dedupeFacultyByEmail([...primary, ...loose]);

  if (merged.length === 0) {
    const bodyHtml = doc.body ? doc.body.innerHTML : html;
    const re = /\b([A-Za-z0-9._%+-]+@(txstate|txst)\.edu)\b/gi;
    let m;
    const lastResort = [];
    const seen = new Set();
    while ((m = re.exec(bodyHtml)) !== null) {
      const email = m[1].toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      lastResort.push({ name: "", email, title: "" });
    }
    merged = dedupeFacultyByEmail(lastResort);
  }

  return merged;
}

function normalizeToken(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\./g, "")
    .trim();
}

/**
 * Parse Banner instructor display into parts for scoring (handles initials, truncation).
 */
function parseInstructorBanner(raw) {
  let s = String(raw || "")
    .replace(/\([^)]{1,120}\)/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const comma = s.indexOf(",");
  if (comma === -1) {
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const last = normalizeToken(parts[0]);
      const firstRest = parts.slice(1).join(" ");
      const firstTokens = parts
        .slice(1)
        .map(normalizeToken)
        .filter(Boolean);
      return {
        last,
        firstRest,
        firstTokens,
        informalOrder: true,
      };
    }
    return {
      last: normalizeToken(s),
      firstRest: "",
      firstTokens: [],
      informalOrder: false,
    };
  }

  const last = normalizeToken(s.slice(0, comma));
  const rest = s.slice(comma + 1).trim();
  const firstTokens = rest
    .split(/[\s,.]+/)
    .map(normalizeToken)
    .filter(Boolean);

  return {
    last,
    firstRest: rest,
    firstTokens,
    informalOrder: false,
  };
}

function lastNameMatchesFaculty(parsed, f) {
  const last = parsed.last;
  if (!last) return false;

  const fName = (f.name || "").toLowerCase();
  const emailLocal = (f.email || "").split("@")[0].toLowerCase();

  const wordBoundary = new RegExp("\\b" + escapeReg(last) + "\\b");
  if (wordBoundary.test(fName)) return true;

  const tokens = fName.split(/[\s,]+/).map(normalizeToken);
  if (tokens.some((t) => t === last || t.includes(last))) return true;

  if (emailLocal.includes(last)) return true;

  return false;
}

function scoreFacultyMatch(parsed, f) {
  if (!lastNameMatchesFaculty(parsed, f)) return 0;

  let score = 6;

  const fName = (f.name || "").toLowerCase();
  const emailLocal = (f.email || "").split("@")[0].toLowerCase();

  if (fName.includes(parsed.last + ",")) score += 3;

  const fts = parsed.firstTokens;
  if (fts.length >= 2) {
    if (fName.includes(fts[0]) && fName.includes(fts[1])) score += 10;
    else if (fName.includes(fts[0])) score += 6;
  } else if (fts.length === 1) {
    const p = fts[0];
    if (p.length >= 2) {
      if (fName.includes(p)) score += 8;
      if (emailLocal.includes(p.slice(0, Math.min(5, p.length)))) score += 3;
    } else if (p.length === 1) {
      const words = fName.split(/[\s,]+/).filter(Boolean);
      if (words.some((w) => w.startsWith(p))) score += 5;
      if (emailLocal.includes(p)) score += 2;
    }
  }

  if (parsed.firstRest && parsed.firstRest.length >= 2) {
    const fr = parsed.firstRest.toLowerCase();
    if (fName.includes(fr.split(/\s+/)[0])) score += 2;
  }

  const title = (f.title || "").toLowerCase();
  if (title.includes("professor") || title.includes("lecturer")) score += 1;

  score += Math.min(String(f.name || "").length / 80, 1);

  return score;
}

/**
 * Match Banner-style instructor string (e.g. "Ali, Moonis (Prim...)") to parsed faculty row.
 */
function matchInstructor(instructorRaw, facultyList) {
  if (!instructorRaw || !facultyList.length) return null;

  const parsed = parseInstructorBanner(instructorRaw);
  if (!parsed.last) return null;

  let best = null;
  let bestScore = 0;

  for (const f of facultyList) {
    const sc = scoreFacultyMatch(parsed, f);
    if (sc > bestScore) {
      bestScore = sc;
      best = f;
    } else if (sc === bestScore && sc > 0 && best) {
      const a = String(f.name || "").length;
      const b = String(best.name || "").length;
      if (a > b) best = f;
    }
  }

  return bestScore > 0 ? best : null;
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchFacultyFromConfig(config) {
  const fetchList = async (url) => {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    return parseFacultyFromHTML(html);
  };

  try {
    const primary = await fetchList(config.url);
    if (primary.length > 0) return primary;
  } catch (err) {
    console.warn("[BobcatFaculty] primary failed:", config.url, err.message);
  }

  if (!config.fallback || config.fallback === config.url) return [];

  try {
    return await fetchList(config.fallback);
  } catch (err2) {
    console.error("[BobcatFaculty] fallback failed:", err2.message);
    return [];
  }
}

function readPersistentFacultyCache(cacheKey) {
  return new Promise((resolve) => {
    if (
      typeof chrome === "undefined" ||
      !chrome.storage ||
      !chrome.storage.local
    ) {
      resolve(null);
      return;
    }
    chrome.storage.local.get([STORAGE_KEY], (r) => {
      const bag = r[STORAGE_KEY];
      if (!bag || !bag[cacheKey]) return resolve(null);
      const { ts, faculty } = bag[cacheKey];
      if (!faculty || !Array.isArray(faculty)) return resolve(null);
      if (Date.now() - ts > facultyCacheTtlMs) return resolve(null);
      resolve(faculty);
    });
  });
}

function writePersistentFacultyCache(cacheKey, faculty) {
  if (
    typeof chrome === "undefined" ||
    !chrome.storage ||
    !chrome.storage.local
  )
    return;
  chrome.storage.local.get([STORAGE_KEY], (r) => {
    const bag = { ...(r[STORAGE_KEY] || {}) };
    bag[cacheKey] = { ts: Date.now(), faculty };
    chrome.storage.local.set({ [STORAGE_KEY]: bag });
  });
}

function clearFacultyCache() {
  Object.keys(_cache).forEach((k) => delete _cache[k]);
  if (
    typeof chrome !== "undefined" &&
    chrome.storage &&
    chrome.storage.local
  ) {
    chrome.storage.local.remove(STORAGE_KEY);
  }
}

function setFacultyCacheTtlMs(ms) {
  if (typeof ms === "number" && ms > 0) facultyCacheTtlMs = ms;
}

/**
 * Returns an array of { name, email, title } for the course's subject prefix.
 */
async function getFacultyForCourse(courseCode) {
  const config = getDeptConfig(courseCode);
  if (!config) return [];

  const cacheKey = config.url;
  if (_cache[cacheKey]) return _cache[cacheKey];

  const persisted = await readPersistentFacultyCache(cacheKey);
  if (persisted !== null) {
    _cache[cacheKey] = persisted;
    return persisted;
  }

  if (_inFlight[cacheKey]) return _inFlight[cacheKey];

  const promise = fetchFacultyFromConfig(config);

  _inFlight[cacheKey] = promise;
  try {
    const faculty = await promise;
    _cache[cacheKey] = faculty;
    writePersistentFacultyCache(cacheKey, faculty);
    return faculty;
  } finally {
    delete _inFlight[cacheKey];
  }
}

/**
 * Resolves instructor display name from registration data to best-matching faculty email.
 * @param {string} courseCode e.g. "CS 4347"
 * @param {string} instructorRaw e.g. "Ali, Moonis (Primary Instructor)"
 * @returns {Promise<{ name: string, email: string, title?: string } | null>}
 */
async function getInstructorEmail(courseCode, instructorRaw) {
  if (
    !instructorRaw ||
    /unassigned/i.test(instructorRaw) ||
    /\bstaff\b/i.test(instructorRaw) ||
    /\bt\s*b\s*a\b/i.test(instructorRaw) ||
    /\btbd\b/i.test(instructorRaw)
  ) {
    return null;
  }
  const facultyList = await getFacultyForCourse(courseCode);
  if (!facultyList.length) return null;
  return matchInstructor(instructorRaw, facultyList);
}

function buildMailtoUrl(email, subject, body) {
  const q = new URLSearchParams();
  if (subject) q.set("subject", subject);
  if (body) q.set("body", body);
  const qs = q.toString();
  return "mailto:" + encodeURIComponent(email) + (qs ? "?" + qs : "");
}

/** For a future "Copy email" button */
async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    console.warn("[BobcatFaculty] clipboard:", e);
    return false;
  }
}

const BobcatFaculty = {
  UNKNOWN_DEPT_CONFIG,
  DEPT_MAP,
  getDeptConfig,
  parseFacultyFromHTML,
  getFacultyForCourse,
  matchInstructor,
  parseInstructorBanner,
  getInstructorEmail,
  buildMailtoUrl,
  copyText,
  clearFacultyCache,
  setFacultyCacheTtlMs,
};

if (typeof window !== "undefined") {
  window.BobcatFaculty = BobcatFaculty;
}
