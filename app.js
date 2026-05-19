"use strict";

/* ===================== Storage ===================== */
const STORAGE_KEY = "routines-app-v1";

const DEFAULT_STATE = () => ({
  routines: [],   // { id, name, type:'checkbox'|'counter', target, timeOfDay, weekdays:[0-6], createdAt }
  entries: {},    // { 'YYYY-MM-DD': { completions: { [routineId]: true|number }, note: string } }
  meta: { createdAt: Date.now() }
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE();
    const parsed = JSON.parse(raw);
    if (!parsed.routines) parsed.routines = [];
    if (!parsed.entries) parsed.entries = {};
    if (!parsed.meta) parsed.meta = { createdAt: Date.now() };
    return parsed;
  } catch (e) {
    console.warn("State korrupt, starte neu", e);
    return DEFAULT_STATE();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();

/* ===================== Date helpers ===================== */
const WEEKDAY_LABELS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const WEEKDAY_LONG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MONTHS = ["Januar","Februar","M&auml;rz","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];

function toKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseKey(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function isSameDay(a, b) { return toKey(a) === toKey(b); }
function todayKey() { return toKey(new Date()); }

/* ===================== App state ===================== */
let currentDate = new Date(); // welcher Tag wird angezeigt
let currentTab = "today";

/* ===================== Routine helpers ===================== */
function genId() {
  return "r_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function routinesForDate(date) {
  const wd = date.getDay();
  return state.routines.filter(r => Array.isArray(r.weekdays) && r.weekdays.includes(wd));
}

function getEntry(key) {
  if (!state.entries[key]) state.entries[key] = { completions: {}, note: "" };
  return state.entries[key];
}

function isRoutineDone(routine, entry) {
  const v = entry.completions[routine.id];
  if (routine.type === "counter") {
    return typeof v === "number" && v >= (routine.target || 1);
  }
  return v === true;
}

function setRoutineCompletion(routine, entry, value) {
  if (routine.type === "counter") {
    const target = routine.target || 1;
    const clamped = Math.max(0, Math.min(target, value));
    if (clamped === 0) delete entry.completions[routine.id];
    else entry.completions[routine.id] = clamped;
  } else {
    if (value) entry.completions[routine.id] = true;
    else delete entry.completions[routine.id];
  }
}

/* Streak: aufeinanderfolgende Tage (bis heute oder bis zum letzten erledigten Tag)
   an denen die Routine geplant UND erledigt war.
   Tage an denen die Routine nicht geplant war, brechen den Streak nicht.
*/
function calcStreak(routine) {
  let streak = 0;
  let d = new Date(); d.setHours(0,0,0,0);
  // Falls heute geplant aber nicht erledigt, starten wir ab gestern
  const todayE = state.entries[toKey(d)] || { completions: {} };
  const todayPlanned = routine.weekdays.includes(d.getDay());
  if (todayPlanned && !isRoutineDone(routine, todayE)) {
    d = addDays(d, -1);
  }
  // bis zu 365 Tage zur&uuml;ckschauen
  for (let i = 0; i < 365; i++) {
    const k = toKey(d);
    const planned = routine.weekdays.includes(d.getDay());
    if (planned) {
      const e = state.entries[k];
      if (e && isRoutineDone(routine, e)) {
        streak++;
      } else {
        break;
      }
    }
    d = addDays(d, -1);
  }
  return streak;
}

/* ===================== Rendering: Heute ===================== */
function renderTopbar() {
  const dateTitle = document.getElementById("dateTitle");
  const dateSub = document.getElementById("dateSub");
  if (isSameDay(currentDate, new Date())) {
    dateTitle.textContent = "Heute";
  } else if (isSameDay(currentDate, addDays(new Date(), -1))) {
    dateTitle.textContent = "Gestern";
  } else if (isSameDay(currentDate, addDays(new Date(), 1))) {
    dateTitle.textContent = "Morgen";
  } else {
    dateTitle.textContent = `${WEEKDAY_LONG[currentDate.getDay()]}`;
  }
  dateSub.innerHTML = `${currentDate.getDate()}. ${MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`;
}

const TIME_GROUPS = [
  { id: "morning",  label: "Morgen",   emoji: "&#9728;&#65039;" },
  { id: "noon",     label: "Mittag",   emoji: "&#127774;" },
  { id: "evening",  label: "Abend",    emoji: "&#127769;" },
  { id: "anytime",  label: "Jederzeit", emoji: "&#9851;&#65039;" }
];

function renderToday() {
  renderTopbar();
  const key = toKey(currentDate);
  const entry = getEntry(key);
  const routines = routinesForDate(currentDate);

  const container = document.getElementById("todayGroups");
  const empty = document.getElementById("todayEmpty");
  container.innerHTML = "";

  if (routines.length === 0) {
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
  }

  // Gruppieren nach Tageszeit
  for (const grp of TIME_GROUPS) {
    const inGroup = routines.filter(r => (r.timeOfDay || "anytime") === grp.id);
    if (inGroup.length === 0) continue;

    const groupEl = document.createElement("div");
    groupEl.className = "group";
    groupEl.innerHTML = `<div class="group-title"><span class="emoji">${grp.emoji}</span> ${grp.label}</div>`;

    for (const r of inGroup) {
      const row = document.createElement("div");
      row.className = "routine";
      if (isRoutineDone(r, entry)) row.classList.add("done");

      if (r.type === "counter") {
        const val = typeof entry.completions[r.id] === "number" ? entry.completions[r.id] : 0;
        const target = r.target || 1;
        row.innerHTML = `
          <div class="name">${escapeHtml(r.name)} <span class="muted" style="font-size:12px">(${val}/${target})</span></div>
          <div class="counter">
            <button class="dec" aria-label="Weniger">&minus;</button>
            <span class="val ${val >= target ? "complete" : ""}">${val}</span>
            <button class="inc" aria-label="Mehr">+</button>
          </div>`;
        row.querySelector(".dec").addEventListener("click", () => {
          const e = getEntry(key);
          const cur = typeof e.completions[r.id] === "number" ? e.completions[r.id] : 0;
          setRoutineCompletion(r, e, cur - 1);
          saveState(); renderToday(); updateProgressOnly();
        });
        row.querySelector(".inc").addEventListener("click", () => {
          const e = getEntry(key);
          const cur = typeof e.completions[r.id] === "number" ? e.completions[r.id] : 0;
          setRoutineCompletion(r, e, cur + 1);
          saveState(); renderToday(); updateProgressOnly();
        });
      } else {
        const checked = entry.completions[r.id] === true;
        row.innerHTML = `
          <button class="checkbox ${checked ? "checked" : ""}" aria-label="Abhaken"></button>
          <div class="name">${escapeHtml(r.name)}</div>`;
        row.querySelector(".checkbox").addEventListener("click", () => {
          const e = getEntry(key);
          setRoutineCompletion(r, e, !checked);
          saveState(); renderToday();
        });
      }

      groupEl.appendChild(row);
    }
    container.appendChild(groupEl);
  }

  // Progress
  const total = routines.length;
  const done = routines.filter(r => isRoutineDone(r, entry)).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  document.getElementById("progressText").textContent = `${done} / ${total} erledigt`;
  document.getElementById("progressPercent").textContent = `${pct}%`;
  document.getElementById("progressFill").style.width = pct + "%";

  // Notiz
  document.getElementById("dayNote").value = entry.note || "";
}

function updateProgressOnly() {
  const key = toKey(currentDate);
  const entry = getEntry(key);
  const routines = routinesForDate(currentDate);
  const total = routines.length;
  const done = routines.filter(r => isRoutineDone(r, entry)).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  document.getElementById("progressText").textContent = `${done} / ${total} erledigt`;
  document.getElementById("progressPercent").textContent = `${pct}%`;
  document.getElementById("progressFill").style.width = pct + "%";
}

/* ===================== Rendering: Woche ===================== */
function renderWeek() {
  // Wochenstreifen: Mo - So um currentDate herum (Montag = Wochenstart)
  const strip = document.getElementById("weekStrip");
  strip.innerHTML = "";
  const now = new Date();
  const day = currentDate.getDay(); // 0=So..6=Sa
  const offsetToMonday = day === 0 ? -6 : 1 - day;
  const monday = addDays(currentDate, offsetToMonday);
  monday.setHours(0,0,0,0);

  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    const k = toKey(d);
    const routines = routinesForDate(d);
    const e = state.entries[k] || { completions: {} };
    const total = routines.length;
    const done = routines.filter(r => isRoutineDone(r, e)).length;
    const cell = document.createElement("div");
    cell.className = "week-day";
    if (total > 0 && done === total) cell.classList.add("full");
    else if (done > 0) cell.classList.add("partial");
    if (isSameDay(d, now)) cell.classList.add("today");
    cell.innerHTML = `
      <div class="dow">${WEEKDAY_LABELS[d.getDay()]}</div>
      <div class="dnum">${d.getDate()}</div>
      <div class="frac">${total === 0 ? "–" : done + "/" + total}</div>`;
    cell.addEventListener("click", () => {
      currentDate = d;
      switchTab("today");
    });
    strip.appendChild(cell);
  }

  renderHeatmap();
}

function renderHeatmap() {
  const grid = document.getElementById("heatmap");
  grid.innerHTML = "";
  // 12 Wochen, jeweils 7 Tage. Ende = diese Woche (Sonntag).
  const now = new Date(); now.setHours(0,0,0,0);
  const day = now.getDay();
  const offsetToSunday = day === 0 ? 0 : 7 - day;
  const endSunday = addDays(now, offsetToSunday);

  for (let wIdx = 11; wIdx >= 0; wIdx--) {
    const col = document.createElement("div");
    col.className = "heatmap-col";
    // Woche: Mo..So, 7 Zellen
    const weekEnd = addDays(endSunday, -wIdx * 7);
    const weekStart = addDays(weekEnd, -6);
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const k = toKey(d);
      const cell = document.createElement("div");
      const routines = routinesForDate(d);
      const e = state.entries[k] || { completions: {} };
      const total = routines.length;
      const done = routines.filter(r => isRoutineDone(r, e)).length;
      let bucket = 0;
      if (total > 0) {
        const frac = done / total;
        if (frac >= 1) bucket = 4;
        else if (frac >= 0.66) bucket = 3;
        else if (frac >= 0.33) bucket = 2;
        else if (frac > 0) bucket = 1;
      }
      cell.className = `hm-cell hm-${bucket}`;
      cell.title = `${k}: ${done}/${total}`;
      cell.addEventListener("click", () => {
        currentDate = d;
        switchTab("today");
      });
      col.appendChild(cell);
    }
    grid.appendChild(col);
  }
}

/* ===================== Rendering: Statistik ===================== */
function renderStats() {
  document.getElementById("statTotalRoutines").textContent = state.routines.length;

  let totalDone = 0;
  let perfectDays = 0;
  // Perfekte Tage: durchgehe alle Eintr&auml;ge
  for (const k of Object.keys(state.entries)) {
    const d = parseKey(k);
    const routines = routinesForDate(d);
    if (routines.length === 0) continue;
    const e = state.entries[k];
    const done = routines.filter(r => isRoutineDone(r, e)).length;
    totalDone += done;
    if (done === routines.length) perfectDays++;
  }
  document.getElementById("statPerfectDays").textContent = perfectDays;
  document.getElementById("statTotalDone").textContent = totalDone;

  // Streaks
  const list = document.getElementById("streakList");
  list.innerHTML = "";
  let longest = 0;
  if (state.routines.length === 0) {
    list.innerHTML = `<div class="muted" style="padding:6px 0">Noch keine Routinen.</div>`;
  }
  for (const r of state.routines) {
    const s = calcStreak(r);
    if (s > longest) longest = s;
    const row = document.createElement("div");
    row.className = "streak-row";
    const cls = s === 0 ? "zero" : (s >= 7 ? "fire" : "");
    row.innerHTML = `
      <div class="left">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="sub">${routineSubtitle(r)}</div>
      </div>
      <div class="streak-badge ${cls}">${s === 0 ? "–" : (s >= 7 ? "&#128293; " : "") + s + " Tage"}</div>`;
    list.appendChild(row);
  }
  document.getElementById("statLongestStreak").textContent = longest;
}

function routineSubtitle(r) {
  const timeLabel = TIME_GROUPS.find(g => g.id === (r.timeOfDay || "anytime"))?.label || "Jederzeit";
  const wd = (r.weekdays || []).slice().sort();
  let wdLabel;
  if (wd.length === 7) wdLabel = "T&auml;glich";
  else if (wd.length === 5 && [1,2,3,4,5].every(x => wd.includes(x))) wdLabel = "Werktags";
  else if (wd.length === 2 && [0,6].every(x => wd.includes(x))) wdLabel = "Wochenende";
  else wdLabel = wd.map(d => WEEKDAY_LABELS[d]).join(", ");
  const typeLabel = r.type === "counter" ? ` &middot; ${r.target}x` : "";
  return `${wdLabel} &middot; ${timeLabel}${typeLabel}`;
}

/* ===================== Rendering: Manage ===================== */
function renderManage() {
  const list = document.getElementById("routineList");
  list.innerHTML = "";
  if (state.routines.length === 0) {
    list.innerHTML = `<div class="empty"><p>Noch keine Routinen angelegt. Tippe oben auf <em>+ Neue Routine</em>.</p></div>`;
    return;
  }
  for (const r of state.routines) {
    const row = document.createElement("div");
    row.className = "routine-row";
    row.innerHTML = `
      <div style="flex:1">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="meta">${routineSubtitle(r)}</div>
      </div>
      <div class="chevron">›</div>`;
    row.addEventListener("click", () => openRoutineModal(r));
    list.appendChild(row);
  }
}

/* ===================== Modal ===================== */
let editingRoutineId = null;

function openRoutineModal(routine) {
  editingRoutineId = routine ? routine.id : null;
  document.getElementById("modalTitle").textContent = routine ? "Routine bearbeiten" : "Neue Routine";
  document.getElementById("fName").value = routine ? routine.name : "";
  document.getElementById("fType").value = routine ? routine.type : "checkbox";
  document.getElementById("fTarget").value = routine && routine.target ? routine.target : 8;
  document.getElementById("fTime").value = routine ? (routine.timeOfDay || "anytime") : "morning";
  toggleTargetField();

  const wdButtons = document.querySelectorAll("#fWeekdays button");
  const wds = routine ? new Set(routine.weekdays) : new Set([0,1,2,3,4,5,6]);
  wdButtons.forEach(b => {
    const wd = Number(b.dataset.wd);
    if (wds.has(wd)) b.classList.add("on"); else b.classList.remove("on");
  });

  document.getElementById("btnDeleteRoutine").classList.toggle("hidden", !routine);
  document.getElementById("routineModal").classList.remove("hidden");
  setTimeout(() => document.getElementById("fName").focus(), 100);
}

function closeRoutineModal() {
  document.getElementById("routineModal").classList.add("hidden");
  editingRoutineId = null;
}

function toggleTargetField() {
  const type = document.getElementById("fType").value;
  document.getElementById("fTargetWrap").classList.toggle("hidden", type !== "counter");
}

function readModalForm() {
  const name = document.getElementById("fName").value.trim();
  if (!name) return null;
  const type = document.getElementById("fType").value;
  const target = Math.max(1, Math.min(99, parseInt(document.getElementById("fTarget").value, 10) || 1));
  const timeOfDay = document.getElementById("fTime").value;
  const weekdays = [...document.querySelectorAll("#fWeekdays button.on")].map(b => Number(b.dataset.wd));
  if (weekdays.length === 0) return null;
  return { name, type, target: type === "counter" ? target : undefined, timeOfDay, weekdays };
}

function saveModalForm() {
  const data = readModalForm();
  if (!data) {
    alert("Bitte einen Namen eingeben und mindestens einen Wochentag w&auml;hlen.");
    return;
  }
  if (editingRoutineId) {
    const r = state.routines.find(x => x.id === editingRoutineId);
    Object.assign(r, data);
  } else {
    state.routines.push({ id: genId(), createdAt: Date.now(), ...data });
  }
  saveState();
  closeRoutineModal();
  renderAll();
}

function deleteCurrentRoutine() {
  if (!editingRoutineId) return;
  if (!confirm("Diese Routine wirklich l&ouml;schen? Der bisherige Verlauf bleibt erhalten.")) return;
  state.routines = state.routines.filter(r => r.id !== editingRoutineId);
  saveState();
  closeRoutineModal();
  renderAll();
}

/* ===================== Tabs ===================== */
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === tab));
  renderAll();
}

function renderAll() {
  if (currentTab === "today") renderToday();
  else if (currentTab === "week") { renderTopbar(); renderWeek(); }
  else if (currentTab === "stats") { renderTopbar(); renderStats(); }
  else if (currentTab === "manage") { renderTopbar(); renderManage(); }
}

/* ===================== Utils ===================== */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

/* ===================== Daten Import/Export ===================== */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `routinen-export-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.routines || !parsed.entries) throw new Error("Ung&uuml;ltiges Format");
      if (!confirm("Bestehende Daten werden ersetzt. Fortfahren?")) return;
      state = parsed;
      saveState();
      renderAll();
    } catch (e) {
      alert("Import fehlgeschlagen: " + e.message);
    }
  };
  reader.readAsText(file);
}

function resetAll() {
  if (!confirm("Wirklich ALLE Daten l&ouml;schen? Das kann nicht r&uuml;ckg&auml;ngig gemacht werden.")) return;
  state = DEFAULT_STATE();
  saveState();
  renderAll();
}

/* ===================== Init / Events ===================== */
function init() {
  // Tabs
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  });
  document.querySelectorAll("[data-goto-tab]").forEach(el => {
    el.addEventListener("click", () => switchTab(el.dataset.gotoTab));
  });

  // Tagesnavigation
  document.getElementById("navPrevDay").addEventListener("click", () => {
    currentDate = addDays(currentDate, -1); renderAll();
  });
  document.getElementById("navNextDay").addEventListener("click", () => {
    currentDate = addDays(currentDate, 1); renderAll();
  });
  document.getElementById("navToday").addEventListener("click", () => {
    currentDate = new Date(); renderAll();
  });

  // Notiz speichern
  document.getElementById("dayNote").addEventListener("input", (e) => {
    const key = toKey(currentDate);
    const entry = getEntry(key);
    entry.note = e.target.value;
    saveState();
  });

  // Routine anlegen
  document.getElementById("btnAddRoutine").addEventListener("click", () => openRoutineModal(null));
  document.getElementById("btnSaveRoutine").addEventListener("click", saveModalForm);
  document.getElementById("btnDeleteRoutine").addEventListener("click", deleteCurrentRoutine);
  document.querySelectorAll("[data-close-modal]").forEach(el => el.addEventListener("click", closeRoutineModal));

  document.getElementById("fType").addEventListener("change", toggleTargetField);
  document.querySelectorAll("#fWeekdays button").forEach(b => {
    b.addEventListener("click", () => b.classList.toggle("on"));
  });

  // Daten
  document.getElementById("btnExport").addEventListener("click", exportData);
  document.getElementById("btnImport").addEventListener("click", () => document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change", (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
  });
  document.getElementById("btnReset").addEventListener("click", resetAll);

  // Swipe-Geste links/rechts f&uuml;r Tageswechsel (nur im Heute-Tab)
  let touchStartX = null;
  let touchStartY = null;
  document.querySelector(".content").addEventListener("touchstart", (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  document.querySelector(".content").addEventListener("touchend", (e) => {
    if (touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (currentTab === "today" && Math.abs(dx) > 60 && Math.abs(dy) < 40) {
      currentDate = addDays(currentDate, dx < 0 ? 1 : -1);
      renderAll();
    }
    touchStartX = null;
  }, { passive: true });

  // Install-Hint f&uuml;r iOS Safari (nur wenn nicht schon installiert)
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const dismissed = localStorage.getItem("install-hint-dismissed") === "1";
  if (isIOS && !isStandalone && !dismissed) {
    setTimeout(() => document.getElementById("installHint").classList.remove("hidden"), 1500);
  }
  document.getElementById("dismissInstall").addEventListener("click", () => {
    document.getElementById("installHint").classList.add("hidden");
    localStorage.setItem("install-hint-dismissed", "1");
  });

  // Service Worker registrieren (offline-f&auml;hig)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* egal */ });
  }

  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
