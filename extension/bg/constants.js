// Bobcat Plus — service-worker constants (ES module).
//
// Stateless leaf module: no fetches, no storage, no side effects. Imported
// by every other bg/* module that needs grade math, subject-code mapping,
// or TXST base URLs. Put things here that a contributor might otherwise
// hard-code in three places and then have to hunt for when a subject code
// changes or Banner moves behind a new hostname.
//
// Do NOT add functions here. If it takes an argument, it belongs in a
// behavior module (bg/cache.js, bg/bannerApi.js, …).

export const BANNER_BASE_URL =
  "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb/ssb";

export const DW_BASE_URL =
  "https://dw-prod.ec.txstate.edu/responsiveDashboard/api";

// Letter grades to points. CR (credit-by-exam / transfer credit) is
// treated as an A-equivalent for the purposes of prereq min-grade gates
// (e.g. "MATH 1315 with min grade C"). This matches Banner's own
// interpretation — CR always satisfies min-grade-of-D and min-grade-of-C
// rules.
export const GRADE_MAP = { A: 4, B: 3, C: 2, D: 1, F: 0, CR: 4 };

// DegreeWorks audit text uses the human-readable subject name
// ("Computer Science"), while Banner's registration API keys off the
// 2–4 char subject code ("CS"). Prereq parsing pulls the long name out of
// the audit string and translates it through this table; anything not
// here falls through unchanged (and will usually then fail the lookup
// silently — safer than guessing).
//
// When TXST adds a new subject: append the (human-name → code) pair below,
// *not* in a parallel table elsewhere.
export const SUBJECT_MAP = {
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
