//combined old Registration.js and DegreeAudit.js

const GRADE_MAP = { A: 4, B: 3, C: 2, D: 1, F: 0, CR: 4 };

const SUBJECT_MAP = {
  "Academic Enrichment": "AE",
  Accounting: "ACC",
  "Adult Education": "ADED",
  "Aerospace Studies": "A S",
  "African American Studies": "AAS",
  Agriculture: "AG",
  "American Sign Language": "ASL",
  Analytics: "ANLY",
  Anthropology: "ANTH",
  Arabic: "ARAB",
  Art: "ART",
  "Art Foundation": "ARTF",
  "Art History": "ARTH",
  "Art Studio": "ARTS",
  "Art Theory & Practice": "ARTT",
  "Athletic Training": "AT",
  "Bilingual Education": "BILG",
  Biology: "BIO",
  "Business Administration": "B A",
  "Business Law": "BLAW",
  "Career & Technical Education": "CTE",
  Chemistry: "CHEM",
  Chinese: "CHI",
  "Civil Engineering": "CE",
  "Communication Design": "ARTC",
  "Communication Disorders": "CDIS",
  "Communication Studies": "COMM",
  "Computer Science": "CS",
  "Concrete Industry Management": "CIM",
  "Construction Science & Mgmt": "CSM",
  "Consumer Affairs": "CA",
  Counseling: "COUN",
  "Criminal Justice": "CJ",
  "Curriculum & Instruction": "CI",
  Dance: "DAN",
  "Developmental Education": "DE",
  "Diversity Studies": "DVST",
  "Early Childhood Education": "ECE",
  Economics: "ECO",
  Education: "ED",
  "Education Student Teaching": "EDST",
  "Educational Leadership": "EDCL",
  "Educational Psychology": "EDP",
  "Educational Technology": "EDTC",
  "Electrical Engineering": "EE",
  Engineering: "ENGR",
  "Engineering Management": "EMGT",
  English: "ENG",
  "English, Lang Arts & Reading": "ELAR",
  "Exercise & Sports Science": "ESS",
  "Family & Consumer Sciences": "FCS",
  "Fashion Merchandising": "FM",
  Finance: "FIN",
  French: "FR",
  "General Science": "GS",
  Geography: "GEO",
  Geology: "GEOL",
  German: "GER",
  "Health & Human Performance": "HHP",
  "Health Informatics": "HI",
  "Health Information Management": "HIM",
  "Health Professions": "HP",
  "Health Sciences": "HS",
  "Healthcare Administration": "HA",
  History: "HIST",
  Honors: "HON",
  "Human Dev & Family Sciences": "HDFS",
  "IPSE Program": "RISE",
  "Industrial Engineering": "IE",
  "Information Systems": "ISAN",
  "Innovation & Entrepreneurship": "IEM",
  "Integrated Studies": "INTS",
  "Interior Design": "ID",
  "International Studies": "IS",
  Italian: "ITAL",
  Japanese: "JAPA",
  Latin: "LAT",
  "Latina/o Studies": "LATS",
  "Legal Studies": "LS",
  "Long Term Care Administration": "LTCA",
  Management: "MGT",
  "Manufacturing Engineering": "MFGE",
  Marketing: "MKT",
  "Mass Communication": "MC",
  Mathematics: "MATH",
  "Matrls Sci, Engnr, Comrclztn": "MSEC",
  "Mechanical & Manufacturing Eng": "MMIE",
  "Mechanical Engineering": "ME",
  "Medical Laboratory Science": "MLS",
  "Military Science": "MS",
  Music: "MU",
  "Music Ensemble": "MUSE",
  "Music Performance": "MUSP",
  "NCBO Mathematics": "NCBM",
  "Nature & Heritage Tourism": "NHT",
  Nursing: "NURS",
  "Nutrition & Foods": "NUTR",
  "Occupational Education": "OCED",
  Philosophy: "PHIL",
  "Physical Fitness & Wellness": "PFW",
  "Physical Therapy": "PT",
  Physics: "PHYS",
  "Political Science (POSI)": "POSI",
  "Political Science (PS)": "PS",
  Portuguese: "POR",
  Psychology: "PSY",
  "Public Administration": "PA",
  "Public Health": "PH",
  "Quant Finance & Economics": "QFE",
  "Radiation Therapy": "RTT",
  Reading: "RDG",
  Recreation: "REC",
  Religion: "REL",
  "Research & Creative Expression": "RES",
  "Respiratory Care": "RC",
  Russian: "RUSS",
  "School Psychology": "SPSY",
  "Social Work": "SOWK",
  Sociology: "SOCI",
  "Span Lang, Lit, Culture in Eng": "HSPN",
  Spanish: "SPAN",
  "Special Education": "SPED",
  Statistics: "STAT",
  "Student Affairs in Higher Ed": "SAHE",
  "Sustainability Studies": "SUST",
  Technology: "TECH",
  "The Graduate College": "GC",
  Theatre: "TH",
  "University Seminar": "US",
  "Women's Studies": "WS",
};

// --- Step 1: Fetch student info ---
async function getStudentInfo() {
  const response = await fetch(
    "https://dw-prod.ec.txstate.edu/responsiveDashboard/api/students/myself",
    { credentials: "include" },
  );
  const me = await response.json();
  const student = me._embedded.students[0];
  return {
    id: student.id,
    name: student.name,
    school: student.goals[0].school.key,
    degree: student.goals[0].degree.key,
    major:
      student.goals[0].details.find((d) => d.code.key === "MAJOR")?.value
        .description || "",
  };
}

// --- Step 2: Fetch and parse degree audit ---
async function getAuditData(studentId, school, degree) {
  const auditUrl =
    "https://dw-prod.ec.txstate.edu/responsiveDashboard/api/audit?studentId=" +
    studentId +
    "&school=" +
    school +
    "&degree=" +
    degree +
    "&is-process-new=false&audit-type=AA&auditId=&include-inprogress=true&include-preregistered=true&aid-term=";
  const response = await fetch(auditUrl, { credentials: "include" });
  const audit = await response.json();

  const completed = [];
  const inProgress = [];
  const needed = [];

  for (const c of audit.classInformation.classArray) {
    if (c.letterGrade === "IP") {
      inProgress.push({
        subject: c.discipline,
        courseNumber: c.number,
        title: c.courseTitle,
      });
    } else if (c.letterGrade !== "W" && c.credits > 0) {
      completed.push({
        subject: c.discipline,
        courseNumber: c.number,
        grade: c.letterGrade,
      });
    }
  }

  function findNeeded(rules) {
    for (const rule of rules) {
      if (rule.ruleArray) findNeeded(rule.ruleArray);
      if (rule.percentComplete === "100") continue;
      if (rule.ruleType !== "Course") continue;
      if (!rule.requirement || !rule.requirement.courseArray) continue;
      if (
        rule.classesAppliedToRule &&
        rule.classesAppliedToRule.classArray &&
        rule.classesAppliedToRule.classArray.length > 0
      )
        continue;
      for (const course of rule.requirement.courseArray) {
        if (course.discipline === "@" || course.number === "@") continue;
        if (course.hideFromAdvice === "Yes") continue;
        const done = completed.some(
          (c) =>
            c.subject === course.discipline && c.courseNumber === course.number,
        );
        const ip = inProgress.some(
          (c) =>
            c.subject === course.discipline && c.courseNumber === course.number,
        );
        const already = needed.some(
          (n) =>
            n.subject === course.discipline && n.courseNumber === course.number,
        );
        if (!done && !ip && !already) {
          needed.push({
            subject: course.discipline,
            courseNumber: course.number,
            label: rule.label,
          });
        }
      }
    }
  }

  for (const block of audit.blockArray) {
    if (block.ruleArray) findNeeded(block.ruleArray);
  }

  return { completed, inProgress, needed };
}

// --- Step 3: Get current registration term ---
async function getCurrentTerm() {
  const response = await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=10",
    { credentials: "include" },
  );
  const terms = await response.json();
  const active = terms.find(
    (t) =>
      !t.description.includes("View Only") &&
      !t.description.includes("Correspondence"),
  );
  return { code: active.code, description: active.description };
}

// --- Step 4: Search for sections of a single course ---
async function searchCourse(subject, courseNumber, term) {
  await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classSearch/resetDataForm",
    { method: "POST", credentials: "include" },
  );
  await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/term/search?mode=search",
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        term: term,
        studyPath: "",
        studyPathText: "",
        startDatepicker: "",
        endDatepicker: "",
      }).toString(),
    },
  );
  const searchForm = new FormData();
  searchForm.append("txt_subject", subject);
  searchForm.append("txt_courseNumber", courseNumber);
  searchForm.append("txt_term", term);
  searchForm.append("pageOffset", "0");
  searchForm.append("pageMaxSize", "50");
  searchForm.append("sortColumn", "subjectDescription");
  searchForm.append("sortDirection", "asc");
  searchForm.append("startDatepicker", "");
  searchForm.append("endDatepicker", "");
  searchForm.append(
    "uniqueSessionId",
    subject + courseNumber + "-" + Date.now(),
  );
  const response = await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/searchResults/searchResults",
    { method: "POST", credentials: "include", body: searchForm },
  );
  const result = await response.json();
  if (result.success && result.data && result.data.length > 0) {
    return result.data;
  }
  return null;
}

// --- Step 5: Check prerequisites for a course ---
function checkPrereqGroup(group, completed, inProgress) {
  const prereqMatches = [
    ...group.matchAll(
      /Course or Test:\s*([A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d{4})/g,
    ),
  ];
  const gradeMatches = [...group.matchAll(/Minimum Grade of ([A-Z])/g)];
  const concurrentMatches = [
    ...group.matchAll(/May (not )?be taken concurrently/g),
  ];
  const missing = [];

  for (let i = 0; i < prereqMatches.length; i++) {
    const prereqSubject = prereqMatches[i][1].replace(/\s+/g, " ").trim();
    const prereqNumber = prereqMatches[i][2];
    const minGrade = gradeMatches[i] ? gradeMatches[i][1] : "D";
    const minGradeNum = GRADE_MAP[minGrade] || 1;
    const canTakeConcurrently =
      concurrentMatches[i] && !concurrentMatches[i][1];
    const abbrev = SUBJECT_MAP[prereqSubject] || prereqSubject;

    const match = completed.find(
      (c) => c.subject === abbrev && c.courseNumber === prereqNumber,
    );
    const ipMatch = inProgress.some(
      (c) => c.subject === abbrev && c.courseNumber === prereqNumber,
    );

    if (match && (GRADE_MAP[match.grade] || 0) >= minGradeNum) {
      continue;
    } else if (ipMatch && canTakeConcurrently) {
      continue;
    } else if (ipMatch) {
      missing.push(
        abbrev + " " + prereqNumber + " (in progress, no concurrent)",
      );
    } else {
      missing.push(abbrev + " " + prereqNumber + " (min " + minGrade + ")");
    }
  }
  return missing;
}

async function checkPrereqs(crn, term, completed, inProgress) {
  const response = await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/searchResults/getSectionPrerequisites?term=" +
      term +
      "&courseReferenceNumber=" +
      crn,
    { credentials: "include" },
  );
  const html = await response.text();
  const orGroups = html.split(/\)\s*or\s*\(/i);

  if (orGroups.length > 1) {
    let allMissing = [];
    for (const group of orGroups) {
      const missing = checkPrereqGroup(group, completed, inProgress);
      if (missing.length === 0) return { met: true, missing: [] };
      allMissing.push(...missing);
    }
    return { met: false, missing: [...new Set(allMissing)] };
  } else {
    const prereqMatches = [
      ...html.matchAll(
        /Course or Test:\s*([A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d{4})/g,
      ),
    ];
    if (prereqMatches.length === 0) return { met: true, missing: [] };
    const andGroups = html.split(/\)\s*and\s*\(/i);
    let allMissing = [];
    for (const group of andGroups) {
      const missing = checkPrereqGroup(group, completed, inProgress);
      allMissing.push(...missing);
    }
    if (allMissing.length === 0) return { met: true, missing: [] };
    return { met: false, missing: allMissing };
  }
}

// --- Fetch course description for a section ---
async function getCourseDescription(crn, term) {
  try {
    const response = await fetch(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/searchResults/getCourseDescription?term=" +
        term +
        "&courseReferenceNumber=" +
        crn,
      { credentials: "include" },
    );
    const rawHtml = await response.text();
    return rawHtml
      .replace(/<[^>]*>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
  } catch (e) {
    return "";
  }
}

// --- Main analysis function ---
async function runAnalysis(sendUpdate) {
  sendUpdate({ type: "status", message: "Detecting student info..." });
  const student = await getStudentInfo();
  sendUpdate({ type: "student", data: student });

  sendUpdate({ type: "status", message: "Loading degree audit..." });
  const { completed, inProgress, needed } = await getAuditData(
    student.id,
    student.school,
    student.degree,
  );
  sendUpdate({
    type: "audit",
    data: {
      completed: completed.length,
      inProgress: inProgress.length,
      needed: needed.length,
    },
  });

  if (needed.length === 0) {
    sendUpdate({
      type: "done",
      data: { eligible: [], blocked: [], notOffered: [], needed: [] },
    });
    return;
  }

  sendUpdate({ type: "status", message: "Detecting registration term..." });
  const term = await getCurrentTerm();
  sendUpdate({ type: "term", data: term });

  const eligible = [];
  const blocked = [];
  const notOffered = [];

  // Search for sections
  for (let i = 0; i < needed.length; i++) {
    const course = needed[i];
    sendUpdate({
      type: "status",
      message:
        "Searching " +
        course.subject +
        " " +
        course.courseNumber +
        " (" +
        (i + 1) +
        "/" +
        needed.length +
        ")",
    });

    try {
      const sections = await searchCourse(
        course.subject,
        course.courseNumber,
        term.code,
      );
      if (sections) {
        course.crn = sections[0].courseReferenceNumber;
        course.sections = sections;
      } else {
        notOffered.push(course);
      }
    } catch (e) {
      notOffered.push(course);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Check prereqs and fetch descriptions for eligible courses
  const coursesWithSections = needed.filter((c) => c.sections);
  for (let i = 0; i < coursesWithSections.length; i++) {
    const course = coursesWithSections[i];
    sendUpdate({
      type: "status",
      message:
        "Checking prereqs for " +
        course.subject +
        " " +
        course.courseNumber +
        " (" +
        (i + 1) +
        "/" +
        coursesWithSections.length +
        ")",
    });

    try {
      const result = await checkPrereqs(
        course.crn,
        term.code,
        completed,
        inProgress,
      );
      if (result.met) {
        sendUpdate({
          type: "status",
          message:
            "Fetching descriptions for " +
            course.subject +
            " " +
            course.courseNumber +
            "...",
        });
        for (const section of course.sections) {
          section.courseDescription = await getCourseDescription(
            section.courseReferenceNumber,
            term.code,
          );
        }
        eligible.push(course);
        sendUpdate({ type: "eligible", data: course });
      } else {
        course.missingPrereqs = result.missing;
        blocked.push(course);
        sendUpdate({ type: "blocked", data: course });
      }
    } catch (e) {
      eligible.push(course);
      sendUpdate({ type: "eligible", data: course });
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  sendUpdate({ type: "done", data: { eligible, blocked, notOffered, needed } });
}

// --- Get available terms ---
async function getTerms() {
  const response = await fetch(
    "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=10",
    { credentials: "include" },
  );
  const terms = await response.json();
  return terms.filter((t) => !t.description.includes("Correspondence"));
}

// --- Get current registered schedule ---
async function getCurrentSchedule(term) {
  try {
    await fetch(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/term/search?mode=registration",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ term: term }).toString(),
      },
    );
    await fetch(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/classRegistration",
      { credentials: "include" },
    );
    const response = await fetch(
      "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb/classRegistration/getRegistrationEvents?termFilter=",
      { credentials: "include" },
    );
    const data = await response.json();
    return data;
  } catch (e) {
    return null;
  }
}

// --- Listen for messages from popup and full tab ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "runAnalysis") {
    runAnalysis((update) => {
      chrome.runtime.sendMessage(update);
    });
    sendResponse({ started: true });
  }

  if (message.action === "openFullTab") {
    chrome.tabs.create({ url: chrome.runtime.getURL("tab.html") });
    sendResponse({ opened: true });
  }

  if (message.action === "getStudentInfo") {
    getStudentInfo()
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.action === "getTerms") {
    getTerms()
      .then((data) => sendResponse(data))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.action === "getSchedule") {
    getCurrentSchedule(message.term)
      .then((data) => sendResponse(data))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.action === "runAnalysisForTerm") {
    runAnalysis((update) => {
      chrome.runtime.sendMessage(update);
    });
    sendResponse({ started: true });
  }

  return true;
});
