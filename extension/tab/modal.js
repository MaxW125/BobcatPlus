// ============================================================
// MODAL — registration-event metadata helpers, RateMyProfessors
// URL builder, Banner section fetch by CRN, and the course /
// calendar-block modal DOMContentLoaded wiring.
// Exported helpers are also consumed by auth.js (for the
// registered-schedule metadata sweep) and ai.js (block modal).
// ============================================================

import * as State from "./state.js";
import {
  $, registerCourseMeta, calendarCourseMetaByCrn,
} from "./state.js";
import { applyNewCalendarBlocks } from "./ai.js";

// ── tiny utilities ───────────────────────────────────────

export function pickFirstStr(...vals) {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const s = typeof v === "number" ? String(v) : String(v).trim();
    if (s) return s;
  }
  return "";
}

export function isDashPlaceholder(val) {
  const s = String(val ?? "").trim();
  return !s || s === "—";
}

export function formatInstructionalMethodLabel(code) {
  const u = String(code || "").trim().toUpperCase();
  if (!u) return "—";
  if (u === "INT" || u === "IN" || u === "INS" || u === "WEB") return "Internet (Online)";
  if (u === "TR" || u === "TRD") return "Traditional (in person)";
  if (u === "HYB" || u === "HY") return "Hybrid";
  return String(code).length > 48 ? String(code).slice(0, 45) + "…" : String(code);
}

export function normalizeInstructionalMethodRaw(ev, imVal) {
  if (imVal != null && typeof imVal === "object") {
    return (
      imVal.description || imVal.longDescription ||
      imVal.label || imVal.code || imVal.key || ""
    );
  }
  return (
    imVal ||
    pickFirstStr(
      ev.scheduleTypeDescription, ev.scheduleType,
      ev.partOfTermDescription, ev.courseInstructionalMethodDescription,
    )
  );
}

export function unwrapExtDirectTabPayload(payload) {
  if (payload != null && typeof payload === "object" && "result" in payload) {
    return payload.result;
  }
  return payload;
}

export function normalizeRegistrationEventsPayload(payload) {
  if (payload == null) return [];
  const root = unwrapExtDirectTabPayload(payload);
  if (Array.isArray(root)) return root;
  if (Array.isArray(root?.data)) return root.data;
  if (Array.isArray(root?.events)) return root.events;
  if (Array.isArray(root?.registrationEvents)) return root.registrationEvents;
  if (Array.isArray(root?.rows)) return root.rows;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

// ── registration-event expansion + merge ─────────────────

export function expandRegistrationEvent(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const xp = raw.extendedProps || raw.extendedProperties || raw.resource || raw.eventExtendedProps;
  const merged = xp && typeof xp === "object" ? { ...xp, ...raw } : { ...raw };
  const out = { ...merged };
  const mergeCo = (co) => {
    if (!co || typeof co !== "object") return;
    const crn = co.courseReferenceNumber ?? co.crn ?? co.courseRegistrationNumber;
    if (crn != null && String(crn).trim() && !pickFirstStr(out.crn, out.courseReferenceNumber)) {
      out.courseReferenceNumber = String(crn).trim();
      out.crn = String(crn).trim();
    }
    const subj = pickFirstStr(co.subject, co.subjectCode, co.courseSubject);
    if (subj && !pickFirstStr(out.subject, out.subjectCode)) out.subject = subj;
    const num = pickFirstStr(co.courseNumber, co.number, co.catalogNumber, co.courseNum);
    if (num && !pickFirstStr(out.courseNumber)) out.courseNumber = num;
    const seq = pickFirstStr(co.sequenceNumber, co.sectionNumber, co.section, co.sequence);
    if (seq && !pickFirstStr(out.sequenceNumber, out.sectionNumber, out.section)) out.sequenceNumber = seq;
    if (Array.isArray(co.meetingsFaculty) && (!Array.isArray(out.meetingsFaculty) || !out.meetingsFaculty.length)) {
      out.meetingsFaculty = co.meetingsFaculty;
    }
    const title = pickFirstStr(co.courseTitle, co.courseDescription, co.title);
    if (title && !pickFirstStr(out.title, out.courseTitle)) {
      out.title = title;
      out.courseTitle = title;
    }
    if (co.instructionalMethod != null && out.instructionalMethod == null) {
      out.instructionalMethod = co.instructionalMethod;
    }
  };
  mergeCo(out.courseOffering);
  mergeCo(out.sectionHeader);
  mergeCo(out.sectionInformation);
  mergeCo(out.section);
  const sc = out.subjectCourse;
  if (sc && typeof sc === "object") {
    const sj = pickFirstStr(sc.subject, sc.subjectCode);
    const nm = pickFirstStr(sc.courseNumber, sc.number);
    if (sj && !pickFirstStr(out.subject)) out.subject = sj;
    if (nm && !pickFirstStr(out.courseNumber)) out.courseNumber = nm;
  }
  return out;
}

export function mergeRegistrationEventRows(rows) {
  if (!rows || !rows.length) return null;
  if (rows.length === 1) return { ...rows[0] };
  const out = { ...rows[0] };
  for (let i = 1; i < rows.length; i++) {
    const b = rows[i];
    for (const k of Object.keys(b)) {
      const bv = b[k];
      if (bv == null || bv === "") continue;
      if (k === "meetingsFaculty" && Array.isArray(bv)) {
        out[k] = [...(out[k] || []), ...bv];
        continue;
      }
      if (out[k] == null || out[k] === "") out[k] = bv;
    }
  }
  return out;
}

export function groupRegistrationEventsByCrn(events) {
  const buckets = new Map();
  for (const ev of events || []) {
    const crn = String(ev.crn ?? ev.courseReferenceNumber ?? "").trim();
    if (!crn) continue;
    if (!buckets.has(crn)) buckets.set(crn, []);
    buckets.get(crn).push(ev);
  }
  const merged = new Map();
  buckets.forEach((rows, crn) => merged.set(crn, mergeRegistrationEventRows(rows)));
  return merged;
}

// ── metadata extraction ──────────────────────────────────

export function extractFacultyName(ev) {
  const tryFac = (f) => {
    if (!f) return "";
    const n = f.displayName || f.preferredName || f.fullName || f.sortName || f.name ||
      (f.firstName && f.lastName ? f.lastName + ", " + f.firstName : "") || "";
    if (!n || n === "Faculty, Unassigned") return "";
    return String(n).trim();
  };
  if (Array.isArray(ev.faculty)) {
    for (const f of ev.faculty) { const n = tryFac(f); if (n) return n; }
  }
  if (Array.isArray(ev.meetingsFaculty)) {
    for (const mf of ev.meetingsFaculty) {
      const direct = pickFirstStr(mf.facultyDisplayName, mf.displayName, mf.instructorName,
        typeof mf.faculty === "string" ? mf.faculty : "");
      if (direct) return direct;
      const arr = mf.faculty || mf.instructors || mf.instructor;
      const list = Array.isArray(arr) ? arr : arr ? [arr] : [];
      for (const f of list) { const n = tryFac(f); if (n) return n; }
    }
  }
  return pickFirstStr(
    typeof ev.instructor === "string" ? ev.instructor : "",
    ev.instructorName, ev.primaryInstructor, ev.facultyDisplayName,
  );
}

export function extractMeetingLocation(ev) {
  const fromMt = (mt) => {
    if (!mt) return "";
    const bits = [
      mt.buildingDescription, mt.buildingAndRoomDescription, mt.facilityDescription,
      mt.building, mt.room, mt.roomNumber, mt.campusDescription, mt.campus,
    ].filter(Boolean);
    return bits.length ? bits.join(" · ") : "";
  };
  if (Array.isArray(ev.meetingsFaculty)) {
    for (const mf of ev.meetingsFaculty) {
      const mt = mf.meetingTime || mf.meetTime || mf.schedule || mf.classMeeting;
      const loc = fromMt(mt);
      if (loc) return loc;
    }
  }
  const loc = fromMt(ev.meetingTime || ev.schedule || ev.scheduledMeeting);
  if (loc) return loc;
  return pickFirstStr(
    ev.buildingDescription, ev.roomDescription, ev.room, ev.building,
    ev.campusDescription, ev.campus, ev.meetingSchedule, ev.location,
  );
}

export function extractMetaFromRegistrationEvent(rawEv) {
  const ev = expandRegistrationEvent(rawEv);
  const crn = String(ev.crn ?? ev.courseReferenceNumber ?? "").trim();
  const subject = pickFirstStr(ev.subject, ev.subjectCode, ev.courseSubject);
  const courseNumber = pickFirstStr(ev.courseNumber, ev.courseNum, ev.number, ev.catalogNumber);
  const courseCode = (subject + " " + courseNumber).trim();
  const title = pickFirstStr(ev.title, ev.courseTitle, ev.courseDescription, ev.scheduleDescription);
  const sectionRaw = pickFirstStr(
    ev.sequenceNumber, ev.sectionNumber,
    typeof ev.section === "string" || typeof ev.section === "number" ? ev.section : "",
    ev.sequence,
  );
  const section = sectionRaw || "—";
  const prof = extractFacultyName(ev);
  const imRaw = ev.instructionalMethod;
  const imAlt = pickFirstStr(
    imRaw, ev.scheduleType, ev.courseInstructionalMethod,
    ev.courseInstructionalMethodDescription, ev.instructionalMethodDescription,
  );
  let location = extractMeetingLocation(ev);
  let methodLabel = imAlt ? formatInstructionalMethodLabel(imAlt) : "—";
  if (!location && (String(imAlt || "").toUpperCase() === "INT" || methodLabel.includes("Online"))) {
    location = "Online";
  }
  return {
    crn, courseCode, subject, courseNumber,
    title: title || "—",
    section,
    professor: prof ? String(prof).trim() : "—",
    location: location || "—",
    instructionalMethod: methodLabel,
    meetingTimeDisplay: "",
  };
}

export function mergeRegistrationMetaForModal(existing, fresh) {
  const pick = (oldVal, newVal) => !isDashPlaceholder(newVal) ? newVal : oldVal;
  if (!fresh) return existing;
  const base = existing || {};
  return {
    crn: pick(base.crn, fresh.crn),
    courseCode: pick(base.courseCode, fresh.courseCode),
    subject: pick(base.subject, fresh.subject),
    courseNumber: pick(base.courseNumber, fresh.courseNumber),
    title: pick(base.title, fresh.title),
    section: pick(base.section, fresh.section),
    professor: pick(base.professor, fresh.professor),
    location: pick(base.location, fresh.location),
    instructionalMethod: pick(base.instructionalMethod, fresh.instructionalMethod),
    meetingTimeDisplay: base.meetingTimeDisplay || fresh.meetingTimeDisplay || "",
  };
}

export function parseCourseCodeFromTitle(titleLine) {
  const m = String(titleLine || "").trim().match(/^([A-Za-z&]{2,12})\s+(\d{3,5}[A-Za-z]?)\b/);
  if (m) return { subject: m[1].toUpperCase(), courseNumber: m[2] };
  return { subject: "", courseNumber: "" };
}

// ── RateMyProfessors URL builder ─────────────────────────

export const RMP_TXST_SCHOOL_ID = "938";

export function professorNameForRateMyProfessorsQuery(displayName) {
  const raw = String(displayName || "").trim();
  if (!raw || raw === "—" || /unassigned|tba|^staff$/i.test(raw.toLowerCase())) return "";
  const comma = raw.indexOf(",");
  if (comma > 0) {
    const last = raw.slice(0, comma).trim();
    const after = raw.slice(comma + 1).trim().replace(/\s+/g, " ");
    if (last && after) return (after.split(/\s+/)[0] + " " + last).trim();
    return last;
  }
  return raw;
}

export function buildRateMyProfessorsUrl(professorDisplayName) {
  const q = professorNameForRateMyProfessorsQuery(professorDisplayName);
  if (!q) return `https://www.ratemyprofessors.com/school/${RMP_TXST_SCHOOL_ID}`;
  return `https://www.ratemyprofessors.com/search/professors/${RMP_TXST_SCHOOL_ID}?q=${encodeURIComponent(q)}`;
}

// ── Banner section row lookup (modal hydration fallback) ──

export const TXST_REG_BASE = "https://reg-prod.ec.txstate.edu/StudentRegistrationSsb";

export async function fetchBannerSectionRowByCrn(term, crn, subject, courseNumber) {
  const crnStr = String(crn || "").trim();
  const sub = String(subject || "").trim();
  const num = String(courseNumber || "").trim();
  if (!crnStr || !term || !sub || !num) return null;
  try {
    await fetch(TXST_REG_BASE + "/ssb/classSearch/resetDataForm", {
      method: "POST", credentials: "include",
    });
    await fetch(TXST_REG_BASE + "/ssb/term/search?mode=search", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        term, studyPath: "", studyPathText: "",
        startDatepicker: "", endDatepicker: "",
      }).toString(),
    });
    const form = new FormData();
    form.append("txt_subject", sub);
    form.append("txt_courseNumber", num);
    form.append("txt_term", term);
    form.append("pageOffset", "0");
    form.append("pageMaxSize", "500");
    form.append("sortColumn", "subjectDescription");
    form.append("sortDirection", "asc");
    form.append("startDatepicker", "");
    form.append("endDatepicker", "");
    form.append("uniqueSessionId", sub + num + "-bobcat-modal-" + Date.now());
    const res = await fetch(TXST_REG_BASE + "/ssb/searchResults/searchResults", {
      method: "POST", credentials: "include", body: form,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data?.success || !Array.isArray(data.data)) return null;
    return data.data.find((s) => String(s.courseReferenceNumber || "").trim() === crnStr) || null;
  } catch (e) {
    console.warn("[BobcatPlus] fetchBannerSectionRowByCrn:", e);
    return null;
  }
}

// ── draft/saved row meta (legacy helpers, kept for parity) ──

export function extractMetaFromDraftRow(row) {
  const sec = row.section;
  const crn = String(row.key || "");
  const subject = row.subject || "";
  const courseNumber = row.courseNumber || "";
  const courseCode = (subject + " " + courseNumber).trim();
  const sn = sec?.sequenceNumber ?? sec?.sectionNumber ?? sec?.section ?? "?";
  let prof = "";
  const f0 = sec?.faculty?.[0];
  if (f0?.displayName && f0.displayName !== "Faculty, Unassigned") prof = f0.displayName;
  const im = sec?.instructionalMethod || "";
  const mt = sec?.meetingsFaculty?.[0]?.meetingTime;
  let location = "—";
  if (mt) {
    const bits = [
      mt.buildingDescription, mt.building, mt.room, mt.campusDescription,
    ].filter(Boolean);
    if (bits.length) location = bits.join(" · ");
  }
  if ((im === "INT" || String(im).toUpperCase() === "INT") && location === "—") {
    location = "Online";
  }
  return {
    crn, courseCode, subject, courseNumber,
    title: sec?.courseTitle || sec?.courseDescription || "—",
    section: String(sn),
    professor: prof || "—",
    location,
    instructionalMethod: formatInstructionalMethodLabel(im),
    meetingTimeDisplay: "",
  };
}

export function extractMetaFromSavedCourse(course) {
  return {
    crn: String(course.crn || ""),
    courseCode: (
      String(course.subject || "").trim() + " " +
      String(course.courseNumber || "").trim()
    ).trim(),
    subject: course.subject || "",
    courseNumber: course.courseNumber || "",
    title: course.title || "—",
    section: course.section != null && course.section !== "" ? String(course.section) : "—",
    professor: course.instructor || "—",
    location: course.location || "—",
    instructionalMethod:
      course.instructionalMethod ||
      formatInstructionalMethodLabel(course.method) ||
      "—",
    meetingTimeDisplay: "",
  };
}

// ── course-block modal wiring ────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("courseModal");
  const overlay = document.getElementById("modalOverlay");
  const closeBtn = document.getElementById("modalClose");
  const modalProfEmailEl = document.getElementById("modalProfEmail");
  const modalCopyEmailBtn = document.getElementById("modalCopyEmail");
  const modalEmailBtn = document.getElementById("modalEmail");
  const modalRMPBtn = document.getElementById("modalRMP");

  if (!modal || !overlay) return;

  let modalEmailGeneration = 0;
  let modalResolvedEmail = "";
  let currentModalMeta = null;

  function setModalResolvedEmail(email, showCopy) {
    modalResolvedEmail = email && showCopy ? email : "";
    if (modalProfEmailEl) modalProfEmailEl.textContent = email || "—";
    if (modalCopyEmailBtn) modalCopyEmailBtn.hidden = !showCopy;
    if (modalEmailBtn) {
      modalEmailBtn.toggleAttribute("disabled", !showCopy);
      modalEmailBtn.classList.toggle("disabled", !showCopy);
    }
  }

  async function resolveModalEmail(meta) {
    const gen = ++modalEmailGeneration;
    modalResolvedEmail = "";
    if (!meta || typeof window.BobcatFaculty === "undefined" || !meta.courseCode || meta.professor === "—") {
      setModalResolvedEmail("—", false);
      return;
    }
    setModalResolvedEmail("Looking up…", false);
    try {
      const hit = await window.BobcatFaculty.getInstructorEmail(
        meta.courseCode.trim(), meta.professor,
      );
      if (gen !== modalEmailGeneration) return;
      if (hit && hit.email) setModalResolvedEmail(hit.email, true);
      else setModalResolvedEmail("Not in directory", false);
    } catch (err) {
      if (gen !== modalEmailGeneration) return;
      setModalResolvedEmail("—", false);
    }
  }

  async function openModal(block) {
    const crn = block.getAttribute("data-crn") || "";
    let meta = crn ? calendarCourseMetaByCrn.get(String(crn)) : null;
    const titleFromBlock = block.querySelector(".course-title")?.textContent?.trim() || "";
    const timeEls = block.querySelectorAll(".course-time");
    const timeFromBlock = timeEls[0]?.textContent?.trim() || "—";
    const secondLine = timeEls[1]?.textContent?.trim() || "";
    const termForSearch = State.currentTerm || document.getElementById("termSelect")?.value || "";

    function applyModalFields(m) {
      document.getElementById("modalTitle").textContent =
        m ? (m.subject || "") + " " + (m.courseNumber || "") : titleFromBlock;
      document.getElementById("modalSub").textContent = m?.title || secondLine || "";
      document.getElementById("modalSection").textContent = m?.section ?? "—";
      document.getElementById("modalCRN").textContent = crn || "—";
      document.getElementById("modalTime").textContent = m?.meetingTimeDisplay || timeFromBlock;
      document.getElementById("modalProf").textContent = m?.professor ?? "—";
      document.getElementById("modalLocation").textContent = m?.location ?? "—";
      document.getElementById("modalMethod").textContent = m?.instructionalMethod ?? "—";
    }

    applyModalFields(meta);

    const needsHydration = crn && termForSearch && (
      !meta ||
      isDashPlaceholder(meta.section) ||
      isDashPlaceholder(meta.professor) ||
      isDashPlaceholder(meta.location) ||
      isDashPlaceholder(meta.instructionalMethod)
    );
    if (needsHydration) {
      let subj = meta?.subject || "";
      let num = meta?.courseNumber || "";
      if (!subj || !num) {
        const parsed = parseCourseCodeFromTitle(titleFromBlock);
        subj = parsed.subject;
        num = parsed.courseNumber;
      }
      if (subj && num) {
        const row = await fetchBannerSectionRowByCrn(termForSearch, crn, subj, num);
        if (row) {
          const fresh = extractMetaFromRegistrationEvent(row);
          fresh.meetingTimeDisplay = meta?.meetingTimeDisplay || timeFromBlock;
          meta = mergeRegistrationMetaForModal(meta, fresh);
          if (crn) registerCourseMeta(String(crn), meta);
          applyModalFields(meta);
        }
      }
    }

    setModalResolvedEmail("…", false);
    modal.classList.add("active");
    overlay.classList.add("active");
    currentModalMeta = meta || null;
    if (meta) resolveModalEmail(meta);
    else setModalResolvedEmail("—", false);
  }

  function closeModal() {
    modal.classList.remove("active");
    overlay.classList.remove("active");
    modalEmailGeneration++;
    currentModalMeta = null;
    setModalResolvedEmail("—", false);
  }

  // Calendar block clicks open the modal in all modes.
  document.getElementById("calendar")?.addEventListener("click", async (e) => {
    const block = e.target.closest(".course-block");
    if (block) await openModal(block);
  });

  if (modalCopyEmailBtn) {
    modalCopyEmailBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (modalResolvedEmail && typeof window.BobcatFaculty !== "undefined") {
        window.BobcatFaculty.copyText(modalResolvedEmail);
      }
    });
  }
  if (modalEmailBtn) {
    modalEmailBtn.addEventListener("click", (e) => {
      if (!modalResolvedEmail) { e.preventDefault(); return; }
      e.preventDefault();
      window.location.href = window.BobcatFaculty.buildMailtoUrl(modalResolvedEmail, "", "");
    });
  }
  if (modalRMPBtn) {
    modalRMPBtn.setAttribute("type", "button");
    modalRMPBtn.setAttribute("title", "Open Rate My Professor (Texas State)");
    modalRMPBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const prof = currentModalMeta?.professor ||
        document.getElementById("modalProf")?.textContent?.trim();
      chrome.tabs.create({ url: buildRateMyProfessorsUrl(prof) });
    });
  }
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (overlay) overlay.addEventListener("click", closeModal);
});

// ── block-creation modal wiring ──────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const bOverlay = $("blockModalOverlay");
  const bModal = $("blockModal");
  const bClose = $("blockModalClose");
  const bSave = $("blockSaveBtn");
  const bAdd = $("addBlockBtn");

  function openBlockModal() {
    if (!bModal || !bOverlay) return;
    const label = $("blockLabelInput");
    if (label) { label.value = ""; label.focus(); }
    bModal.querySelectorAll(".block-day input[type='checkbox']").forEach((cb) => { cb.checked = false; });
    const startEl = $("blockStartInput");
    const endEl = $("blockEndInput");
    if (startEl) startEl.value = "17:00";
    if (endEl) endEl.value = "21:00";
    bModal.classList.add("active");
    bOverlay.classList.add("active");
  }

  function closeBlockModal() {
    if (!bModal || !bOverlay) return;
    bModal.classList.remove("active");
    bOverlay.classList.remove("active");
  }

  if (bAdd) bAdd.addEventListener("click", openBlockModal);
  if (bClose) bClose.addEventListener("click", closeBlockModal);
  if (bOverlay) bOverlay.addEventListener("click", closeBlockModal);

  if (bSave) {
    bSave.addEventListener("click", () => {
      const label = ($("blockLabelInput")?.value || "").trim();
      if (!label) { $("blockLabelInput")?.focus(); return; }
      const days = [];
      bModal.querySelectorAll(".block-day input[type='checkbox']:checked").forEach((cb) =>
        days.push(cb.value),
      );
      if (!days.length) return;
      const rawStart = ($("blockStartInput")?.value || "17:00").replace(":", "");
      const rawEnd = ($("blockEndInput")?.value || "21:00").replace(":", "");
      if (parseInt(rawStart, 10) >= parseInt(rawEnd, 10)) return;
      applyNewCalendarBlocks([{ label, days, start: rawStart, end: rawEnd }]);
      closeBlockModal();
    });
  }

  const labelInput = $("blockLabelInput");
  if (labelInput) {
    labelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") bSave?.click();
    });
  }
});
