
// src/pages/AdminCalendar.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { db } from "../firebase";
import { useNavigate, useLocation } from "react-router-dom";
import {
  collection,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  deleteField,
} from "firebase/firestore";
import { runTransaction, writeBatch, increment, getDocs } from "firebase/firestore";

import {
  FiCalendar,
  FiUser,
  FiClock,
  FiAlertTriangle,
  FiSlash,
  FiTrash2,
  FiPlus,
  FiEdit3,
  FiSave,
  FiX,
  FiInfo,
} from "react-icons/fi";

/* -------------------- helpers -------------------- */

const DEFAULT_SALON_HOURS = {
  mon: { open: "08:00", close: "22:00" },
  tue: { open: "08:00", close: "22:00" },
  wed: { open: "08:00", close: "22:00" },
  thu: { open: "08:00", close: "22:00" },
  fri: { open: "08:00", close: "22:00" },
  sat: { open: "08:00", close: "20:00" },
  sun: { open: "09:00", close: "17:00" },
};

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DOW_SR = ["Ned", "Pon", "Uto", "Sre", "Čet", "Pet", "Sub"];

const pad2 = (n) => String(n).padStart(2, "0");
const dateKey = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const ymKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const timeToMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x || 0, 10));
  return (h || 0) * 60 + (m || 0);
};
const minToTime = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const overlaps = (aStart, aEnd, bStart, bEnd) =>
  Math.max(aStart, bStart) < Math.min(aEnd, bEnd);

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (0 <= h && h < 60) [r, g, b] = [c, x, 0];
  else if (60 <= h && h < 120) [r, g, b] = [x, c, 0];
  else if (120 <= h && h < 180) [r, g, b] = [0, c, x];
  else if (180 <= h && h < 240) [r, g, b] = [0, x, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v) => pad2(Math.round((v + m) * 255).toString(16));
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function hashToColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return hslToHex(hue, 65, 72);
}
function getServicePrice(srv) {
  const base = Number(srv?.price ?? srv?.basePrice ?? 0);
  const disc = Number(srv?.discountPercent ?? 0);
  const final = base * (1 - disc / 100);
  return Math.round(final);
}


/* -------------------- component -------------------- */
// --- helpers (ostaje gde jeste) ---
async function applyPendingToEarliestAppt(db, phone, amount) {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

  const qAppt = query(
    collection(db, "appointments"),
    where("clientPhone", "==", phone),
    where("status", "==", "booked"),
    where("dateKey", ">=", todayKey),
    orderBy("dateKey", "asc"),
    orderBy("startMin", "asc")
  );

  const snap = await getDocs(qAppt);
  const first = snap.docs[0];
  if (!first) return; // nema budućih termina – pending ostaje kod klijenta, primeniće se pri sledećem zakazivanju

  const apptRef = first.ref;
  const clientRef = doc(db, "clients", phone);

  await runTransaction(db, async (tx) => {
    const cSnap = await tx.get(clientRef);
    const cData = cSnap.exists() ? cSnap.data() : {};
    const pen = cData.pendingPenalty;
    if (!pen || Number(pen.amount || 0) <= 0) return;

    const aSnap = await tx.get(apptRef);
    if (!aSnap.exists()) return;
    if (aSnap.data()?.penaltyApplied?.amount > 0) return; // već primenjeno

    tx.update(apptRef, {
      penaltyApplied: {
        amount: Number(pen.amount || amount || 0),
        sourceApptId: pen.sourceApptId || "",
        appliedAt: serverTimestamp(),
      },
      updatedAt: serverTimestamp(),
    });

    tx.set(
      clientRef,
      { pendingPenalty: deleteField(), updatedAt: serverTimestamp() },
      { merge: true }
    );
  });
}

// ⬇⬇⬇ DODAJ OVDE, van komponente
const apptBgFor = (a, colorForServiceId) => {
  return a.type === "vacation"
    ? "repeating-linear-gradient(-45deg,#ffc6cf 0 10px,#ffadb9 10px 20px)"
    : a.type === "break"
    ? "repeating-linear-gradient(-45deg,#ffd88a 0 10px,#ffcb66 10px 20px)"
    : a.type === "block"
    ? "repeating-linear-gradient(-45deg,#cfcfcf 0 8px,#bdbdbd 8px 16px)"
    : colorForServiceId(a.serviceId) || "#ffffff";
};
// --- UI za izbor opsega dana (Pon..Ned) ---
const DOW_SR_SHORT = ["Pon", "Uto", "Sre", "Čet", "Pet", "Sub", "Ned"];

function BlockDaysBar({ visible, anchorDate, onCancel, onConfirm, isMobile }) {
  // ako nije vidljivo — ne renderuj NIŠTA
  if (!visible) return null;

  const [selected, setSelected] = React.useState(new Set());

  // pomoćne
  const dayNames = ["Pon", "Uto", "Sre", "Čet", "Pet", "Sub", "Ned"];
  const startOfWeek = (d) => {
    const dd = new Date(d);
    const isoDow = (dd.getDay() + 6) % 7; // 0 = pon
    dd.setDate(dd.getDate() - isoDow);
    dd.setHours(0, 0, 0, 0);
    return dd;
  };
  const addDays = (d, i) => {
    const x = new Date(d);
    x.setDate(x.getDate() + i);
    return x;
  };
  const fmtDot = (d) =>
    `${String(d.getDate()).padStart(2, "0")}. ${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}. ${d.getFullYear()}.`;
  const fmtKey = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD

  // koristimo *anchorDate* (tvoj dayDate), ne neki "currentDate"
  const weekDays = React.useMemo(() => {
    const base = anchorDate instanceof Date ? anchorDate : new Date(anchorDate);
    const start = startOfWeek(base);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [anchorDate]);

  const toggleDate = (d) => {
    const key = fmtKey(d);
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const handleCancel = () => {
    setSelected(new Set());
    onCancel?.();
  };

  const handleConfirm = async () => {
    if (selected.size === 0) return;
    // pozovi onConfirm za SVAKI izabrani dan (from=to=isti dan)
    for (const key of selected) {
      await onConfirm?.(key, key);
    }
    setSelected(new Set());
  };

  // stilovi
    const stripWrap = {
    display: "flex",
    flexDirection: isMobile ? "column" : "row",
    alignItems: isMobile ? "stretch" : "center",
    gap: isMobile ? 8 : 12,
    padding: isMobile ? "8px" : "12px",
  };

  const dayBtn = (active) => ({
    display: "block",
    width: isMobile ? "100%" : undefined,   // ⬅ FULL WIDTH na telefonu
    boxSizing: "border-box",
    padding: isMobile ? "12px 14px" : "14px 16px",
    minWidth: isMobile ? "auto" : 120,
    borderRadius: 16,
    fontWeight: 800,
    lineHeight: 1.1,
    border: active
      ? "2px solid rgba(255,105,180,.9)"
      : "1px solid rgba(255,255,255,.28)",
    background: active
      ? "linear-gradient(180deg,rgba(255,105,180,.28),rgba(255,105,180,.18))"
      : "linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,.08))",
    color: "#fff",
    boxShadow: active
      ? "0 0 0 2px rgba(255,105,180,.15) inset"
      : "0 2px 6px rgba(0,0,0,.15)",
    textAlign: "left",
  });

  const actionsWrap = {
    display: "flex",
    gap: 12,
    marginLeft: isMobile ? 0 : "auto",
    flexWrap: "wrap",
    width: isMobile ? "100%" : "auto",
    justifyContent: isMobile ? "space-between" : "flex-start",
    marginTop: isMobile ? 8 : 0,
  };
  const ghostBtn = {
    padding: "10px 14px",
    borderRadius: 12,
    fontWeight: 800,
    border: "1px solid rgba(255,255,255,.35)",
    background: "transparent",
    color: "#fff",
  };
  const primaryBtn = (enabled) => ({
    padding: "10px 14px",
    borderRadius: 12,
    fontWeight: 800,
    border: "none",
    background: "linear-gradient(180deg, #ff5fa2, #ff4a90)",
    color: "#fff",
    opacity: enabled ? 1 : 0.6,
  });

  return (
    <div style={{ borderTop: "1px solid rgba(255,255,255,.15)", marginTop: 10 }}>
      <div style={stripWrap}>
        {weekDays.map((d, i) => {
          const key = fmtKey(d);
          const active = selected.has(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggleDate(d)}
              style={dayBtn(active)}
            >
              <div style={{ opacity: 0.9, fontSize: 14 }}>{dayNames[i]}</div>
              <div style={{ fontSize: 16 }}>{fmtDot(d)}</div>
            </button>
          );
        })}
        <div style={actionsWrap}>
          <button type="button" onClick={handleCancel} style={ghostBtn}>
            Otkaži
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            style={primaryBtn(selected.size > 0)}
            disabled={selected.size === 0}
          >
            Blokiraj izabrane dane
          </button>
        </div>
      </div>
    </div>
  );
}

function WeekStrip({ anchorDate, onPick, isMobile }) {
  const dayNames = ["Pon", "Uto", "Sre", "Čet", "Pet", "Sub", "Ned"];

  // helperi
  const startOfWeek = (d) => {
    const dd = new Date(d);
    const iso = (dd.getDay() + 6) % 7; // 0 = Pon
    dd.setDate(dd.getDate() - iso);
    dd.setHours(0, 0, 0, 0);
    return dd;
  };
  const addDays = (d, i) => {
    const x = new Date(d);
    x.setDate(x.getDate() + i);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const fmtDot = (d) =>
    `${String(d.getDate()).padStart(2, "0")}. ${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}. ${d.getFullYear()}.`;
  const key = (d) => d.toISOString().slice(0, 10);

  // bazna nedelja i navigacija
  const [weekBase, setWeekBase] = React.useState(startOfWeek(anchorDate));
  React.useEffect(() => setWeekBase(startOfWeek(anchorDate)), [anchorDate]);

  const days = React.useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekBase, i)),
    [weekBase]
  );

  const goPrev = () => setWeekBase(addDays(weekBase, -7));
  const goNext = () => setWeekBase(addDays(weekBase, +7));

  // stilovi (kompaktno, lepo i na tel)
  const barWrap = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 8,
  };
  const stripWrap = {
    display: "flex",
    gap: 12,
    alignItems: "center",
    flexWrap: isMobile ? "nowrap" : "wrap",
    overflowX: isMobile ? "auto" : "visible",
    padding: "4px 6px",
    WebkitOverflowScrolling: "touch",
    scrollbarWidth: "none",
  };
  const arrowBtn = {
    height: 36,
    minWidth: 36,
    borderRadius: 10,
    border: "0.5px solid rgba(255,255,255,.35)",
    background: "linear-gradient(135deg,#ffffff,#eaf5ff)",
    color: "#000",
    fontWeight: 900,
    cursor: "pointer",
  };
  const dayBtn = (active) => ({
    flex: "0 0 auto",
    padding: "12px 14px",
    minWidth: isMobile ? 120 : 140,
    borderRadius: 14,
    fontWeight: 800,
    lineHeight: 1.1,
    border: active
      ? "2px solid rgba(255,105,180,.9)"
      : "1px solid rgba(255,255,255,.28)",
    background: active
      ? "linear-gradient(180deg,rgba(255,105,180,.28),rgba(255,105,180,.18))"
      : "linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,.08))",
    color: "#fff",
    boxShadow: active
      ? "0 0 0 2px rgba(255,105,180,.15) inset"
      : "0 2px 6px rgba(0,0,0,.15)",
  });

  return (
    <div style={barWrap}>
      <button type="button" onClick={goPrev} style={arrowBtn} aria-label="Prethodna nedelja">
        ◀
      </button>

      <div style={stripWrap}>
        {days.map((d, i) => {
          const active = key(d) === key(anchorDate);
          return (
            <button
              key={key(d)}
              type="button"
              onClick={() => onPick(new Date(d))}
              style={dayBtn(active)}
              title={fmtDot(d)}
            >
              <div style={{ opacity: 0.9, fontSize: 12 }}>{dayNames[i]}</div>
              <div style={{ fontSize: 16 }}>{fmtDot(d)}</div>
            </button>
          );
        })}
      </div>

      <button type="button" onClick={goNext} style={arrowBtn} aria-label="Sledeća nedelja">
        ▶
      </button>
    </div>
  );
}

export default function AdminCalendar() {
  
  const nav = useNavigate();
   const location = useLocation();
   // odmah posle useLocation() i deklaracije state-ova
    const [pendingDeepLink, setPendingDeepLink] = useState(null); // {date,emp,at,aid}
 const [pendingApptId, setPendingApptId] = useState(null);     // čeka da se termini učitaju
 const [initialScrollMin, setInitialScrollMin] = useState(null);
  const [tab, setTab] = useState("day"); // 'day' | 'month' | 'schedule'
  
  
  const [clientsAll, setClientsAll] = useState([]);

  
useEffect(() => {
  const sp = new URLSearchParams(location.search || "");
  const date = sp.get("date");   // npr. "2025-08-24"
  const emp  = sp.get("emp");    // employeeId
  const at   = sp.get("at");     // minuti u danu (string -> broj)
  const aid  = sp.get("aid");    // appointment id
  if (date || emp || at || aid) {
    setPendingDeepLink({
      date,
      emp,
      at: at != null ? Number(at) : null,
      aid
    });
  }
}, [location.search]);
useEffect(() => {
  if (!pendingDeepLink) return;

  if (typeof setTab === "function") setTab("schedule");
  if (pendingDeepLink.date) {
    const d = new Date(pendingDeepLink.date + "T00:00:00");
    setSchedDate(d);
  }

  if (pendingDeepLink.emp) setSelEmpId?.(pendingDeepLink.emp);
  if (pendingDeepLink.at != null) setInitialScrollMin?.(pendingDeepLink.at);

  if (pendingDeepLink.aid) setPendingApptId(pendingDeepLink.aid);

  setPendingDeepLink(null);

  // nav("/admin/kalendar", { replace: true });
}, [pendingDeepLink]);
// 1. useEffect koji parsira URL (location.search) i puni pendingDeepLink

// 2. useEffect koji reaguje na pendingDeepLink i postavlja schedDate, selEmpId, initialScrollMin i pendingApptId

// 3. ⬇️ OVAJ useEffect koji ti je bitan
const openApptModal = (a) => {
  setActiveAppt(a);
  setEditPrice(a?.price ?? "");
};
const closeApptModal = () => setActiveAppt(null);




// --- mobile detect (≤640px) — MORA biti pre prve upotrebe `isMobile`
// --- mobile detect (≤640px) — inicijalno tačno stanje
const [isMobile, setIsMobile] = useState(() => {
  try {
    return window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
  } catch {
    return false;
  }
});

// listen za promene širine
useEffect(() => {
  let mq;
  try {
    mq = window.matchMedia("(max-width: 640px)");
  } catch {
    return;
  }
  const handler = (e) => setIsMobile(e.matches);
  // modern + Safari fallback
  if (mq.addEventListener) mq.addEventListener("change", handler);
  else mq.addListener(handler);
  return () => {
    if (mq.removeEventListener) mq.removeEventListener("change", handler);
    else mq.removeListener(handler);
  };
}, []);

// create (day): 'booking' | 'block'
const [mode, setMode] = useState(null);

// (OPCIJA A – preporučeno) ne forsiraj desktop default uopšte
//   → obriši ceo efekat ispod
// (OPCIJA B) ostavi ga ali tek kad je isMobile pouzdano poznat:
useEffect(() => {
  if (mode === null && isMobile === false) setMode("booking");
  // napomena: izvršiće se samo na desktopu
}, [isMobile]); // nema potrebe da zavisi od mode


// Pomoćni flagovi za čitljiv JSX
const isBooking = mode === "booking";
const isBlock   = mode === "block";
// Polja prikazujemo kad: nismo na telefonu ILI je izabran neki režim
const showModeFields = !isMobile || !!mode;

const [showBlockDaysUI, setShowBlockDaysUI] = useState(false);


  // meta
  const [salonHours, setSalonHours] = useState(DEFAULT_SALON_HOURS);

  // collections
  const [employees, setEmployees] = useState([]);
  const [empOrder, setEmpOrder] = useState([]);

  const [services, setServices] = useState([]);
  // DESKTOP multi-select
const [selectedEmpIds, setSelectedEmpIds] = useState([]);
const toggleEmp = (id) =>
  setSelectedEmpIds(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
  );

// ako lista radnica stigne/menja se, očisti nevažeće ID-jeve iz selekcije
useEffect(() => {
  const valid = new Set(employees.map(e => e.id));
  setSelectedEmpIds(prev => prev.filter(id => valid.has(id)));
}, [employees]);
  const manyEmployees = employees.length > 10

  // day view
  const [dayDate, setDayDate] = useState(() => new Date());
  const [onlyWorking, setOnlyWorking] = useState(true);
  const [appointments, setAppointments] = useState([]);
  const [dayShifts, setDayShifts] = useState([]);

  // create (day): 'booking' | 'block'
      // "booking" | "block"


const [selEmpId, setSelEmpId] = useState(null);
// --- mobile reordering state ---
const [empSelectMode, setEmpSelectMode] = useState(false);
const [empSelectedId, setEmpSelectedId] = useState(null);
const [empSelectedIndex, setEmpSelectedIndex] = useState(-1);

const empHoldTimerRef = useRef(null);
const empTouchStartRef = useRef({ x: 0, y: 0 });

const autoPickedRef = useRef(false);
  const [selSrvId, setSelSrvId] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");

  // month view (shifts)
  const [monthAnchor, setMonthAnchor] = useState(() => ymKey(new Date()));
  const [monthEmpId, setMonthEmpId] = useState("");
  const [templateDays, setTemplateDays] = useState(new Set([1, 2, 3, 4, 5]));
  const [tplStart, setTplStart] = useState("09:00");
  const [tplEnd, setTplEnd] = useState("17:00");

  // single-day shift (u tab "month")
  const [oneDay, setOneDay] = useState(() => `${monthAnchor}-01`);
  const [oneStart, setOneStart] = useState("09:00");
  const [oneEnd, setOneEnd] = useState("17:00");

  const [busy, setBusy] = useState(false);

  // Vacation entry
  const [vacStart, setVacStart] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
  });
  const [vacDays, setVacDays] = useState(1);
  const [busyVac, setBusyVac] = useState(false);

  // live month data to render roster
  const [monthShifts, setMonthShifts] = useState([]);
  const [monthBreaksB, setMonthBreaksB] = useState([]); // type === "break"
  const [monthVacations, setMonthVacations] = useState([]); // type === "vacation"
  const timeOffs = useMemo(
    () => [...monthBreaksB, ...monthVacations],
    [monthBreaksB, monthVacations]
  );

  // schedule tab
  const [schedDate, setSchedDate] = useState(() => new Date());
  const [schedAppts, setSchedAppts] = useState([]);

  // clients with no-show history (by phone)
  const [noShowByPhone, setNoShowByPhone] = useState(new Map());

  // UI state
  const [hoverApptId, setHoverApptId] = useState(null);
  const [activeAppt, setActiveAppt] = useState(null); 
  const [editPrice, setEditPrice] = useState("");
const topScrollRef = useRef(null);
const topSpacerRef = useRef(null);
const colsWrapRef  = useRef(null);
const innerRef      = useRef(null); // gornji "fake" skrol
useEffect(() => {
  const top = topScrollRef.current;
  const spacer = topSpacerRef.current;
  const cols = colsWrapRef.current;
  if (!top || !spacer || !cols) return;

  // postavi širinu "spacer"-a na punu širinu sadržaja kolona
const setSpacerWidth = () => {
  const inner = cols.firstElementChild; // npr. DayGrid-ov unutrašnji wrap
  const W = (inner && inner.scrollWidth) || cols.scrollWidth || cols.clientWidth;
  spacer.style.width = W + "px";
};

  setSpacerWidth();

  // međusobna sinhronizacija scroll-a
  let syncing = false;
  const onTopScroll = () => {
    if (syncing) return;
    syncing = true;
    cols.scrollLeft = top.scrollLeft;
    syncing = false;
  };
  const onColsScroll = () => {
    if (syncing) return;
    syncing = true;
    top.scrollLeft = cols.scrollLeft;
    syncing = false;
  };

  top.addEventListener("scroll", onTopScroll, { passive: true });
  cols.addEventListener("scroll", onColsScroll, { passive: true });

  // reaguj na promenu veličine — da spacer ostane tačne širine
const ro = new ResizeObserver(() => setSpacerWidth());
ro.observe(cols);
if (cols.firstElementChild) ro.observe(cols.firstElementChild);


  // inicijalno poravnanje scrollLeft
  top.scrollLeft = cols.scrollLeft;

  return () => {
    top.removeEventListener("scroll", onTopScroll);
    cols.removeEventListener("scroll", onColsScroll);
    ro.disconnect();
  };
}, []);

// opens modal
  // clients with pending penalty (by phone)
const [pendingPenaltyByPhone, setPendingPenaltyByPhone] = useState(new Map());

  // Map telefona -> ID najranijeg budućeg termina (status 'booked')
  const [firstUpcomingApptIdByPhone, setFirstUpcomingApptIdByPhone] = useState(new Map());


  // --- mobile detect (≤640px) ---


  /* ------------ dodatni HELPERI za mesečni šablon (izbor dana) ------------ */
  const toggleTplDay = (idx) => {
    setTemplateDays((prev) => {
      const s = new Set(prev);
      if (s.has(idx)) s.delete(idx);
      else s.add(idx);
      return s;
    });
  };
  const pickWorkdays = () => setTemplateDays(new Set([1, 2, 3, 4, 5])); // Pon–Pet
  const pickAllDays = () => setTemplateDays(new Set([0, 1, 2, 3, 4, 5, 6])); // Ned–Sub
  const clearTplDays = () => setTemplateDays(new Set());

  /* ------------ effects ------------ */

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, "settings", "salonHours"));
        if (snap.exists())
          setSalonHours({ ...DEFAULT_SALON_HOURS, ...(snap.data() || {}) });
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const offEmp = onSnapshot(
      query(collection(db, "employees"), orderBy("name", "asc")),
     (s) => {
  const arr = s.docs.map((d) => ({ id: d.id, ...d.data() }));
  setEmployees(arr);
  setEmpOrder(arr.map(e => e.id)); // inicijalni redosled
}

    );
    const offSrv = onSnapshot(collection(db, "services"), (s) => {
      const arr = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      arr.sort(
        (a, b) =>
          (a.order ?? 0) - (b.order ?? 0) ||
          (a.name || "").localeCompare(b.name || "")
      );
      setServices(arr);
    });
    // clients with no-show history
    const offClients = onSnapshot(
      query(collection(db, "clients"), where("noShowCount", ">", 0)),
      (s) => {
        const m = new Map();
        s.docs.forEach((d) => {
          const data = d.data();
          if (data.phone) m.set(normPhone(data.phone), data.noShowCount || 1);
        });
        setNoShowByPhone(m);
      }
    );
    // clients with pending penalty (by phone)

const offClientsPenalty = onSnapshot(
  query(collection(db, "clients"), where("pendingPenalty.amount", ">", 0)),
  (s) => {
    const m = new Map();
    s.docs.forEach((d) => {
      const data = d.data();
      if (data.phone && data.pendingPenalty?.amount > 0) {
        m.set(normPhone(data.phone), {
          amount: Number(data.pendingPenalty.amount || 0),
          sourceApptId: data.pendingPenalty.sourceApptId || "",
          createdAt: data.pendingPenalty.createdAt || null,
        });
      }
    });
    setPendingPenaltyByPhone(m);
  }
);


    return () => {
      offEmp();
      offSrv();
      offClients();
        offClientsPenalty(); // <— novo
    };
  }, []);

  useEffect(() => setVacStart(`${monthAnchor}-01`), [monthAnchor]);

  // daily listeners (day tab)
  // 1) ostaje tvoj "daily listeners" efekat – BEZ unutrašnjeg useEffect-a:
useEffect(() => {
  const dk = dateKey(dayDate);
  const qShifts = query(collection(db, "shifts"), where("dateKey", "==", dk));
  const qAppts  = query(collection(db, "appointments"), where("dateKey", "==", dk));

  const offA = onSnapshot(qAppts, (s) => {
    const all = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    const visible = all.filter(a => a.type !== "booking" || a.status === "booked");
    setAppointments(visible);
  });

  const offS = onSnapshot(qShifts, (s) =>
    setDayShifts(s.docs.map((d) => ({ id: d.id, ...d.data() })))
  );

  return () => { offA(); offS(); };
}, [dayDate]);

// 2) NOV, samostalan useEffect za listu klijenata (globalni, ne zavisi od dayDate):
useEffect(() => {
  const offAllClients = onSnapshot(
    query(collection(db, "clients"), orderBy("name", "asc")),
    (s) => {
      const arr = s.docs.map((d) => {
        const data = d.data() || {};
        return {
          name:  data.name  || "",
          phone: data.phone || "",
          id:    d.id,
        };
      });
      setClientsAll(arr);
    }
  );
  return () => offAllClients();
}, []);

  // month snapshots (shifts + timeOff)
  useEffect(() => {
    const base = new Date(monthAnchor + "-01T00:00:00");
    const start = dateKey(new Date(base.getFullYear(), base.getMonth(), 1));
    const end = dateKey(new Date(base.getFullYear(), base.getMonth() + 1, 0));

    const qShifts = query(
      collection(db, "shifts"),
      where("dateKey", ">=", start),
      where("dateKey", "<=", end)
    );
    const qBreaks = query(
      collection(db, "appointments"),
      where("dateKey", ">=", start),
      where("dateKey", "<=", end),
      where("type", "==", "break")
    );
    const qVac = query(
      collection(db, "appointments"),
      where("dateKey", ">=", start),
      where("dateKey", "<=", end),
      where("type", "==", "vacation")
    );

    const offS = onSnapshot(qShifts, (s) =>
      setMonthShifts(s.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    const offB = onSnapshot(qBreaks, (s) =>
      setMonthBreaksB(s.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    const offV = onSnapshot(qVac, (s) =>
      setMonthVacations(s.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    return () => {
      offS();
      offB();
      offV();
    };
  }, [monthAnchor]);

  // schedule tab: bookings for selected day
  useEffect(() => {
    const dk = dateKey(schedDate);
const q = query(
  collection(db, "appointments"),
  where("dateKey", "==", dk),
  where("type", "==", "booking"),
  where("status", "==", "booked")
);

    const off = onSnapshot(q, (s) =>
      setSchedAppts(
        s
          .docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.startMin || 0) - (b.startMin || 0))
      )
    );
    return () => off();
  }, [schedDate]);
useEffect(() => {
  if (!pendingApptId || !Array.isArray(schedAppts) || !schedAppts.length) return;
  const appt = schedAppts.find(a => a.id === pendingApptId);
  if (appt) {
    openApptModal(appt);     // otvara modal baš za taj termin
    setPendingApptId(null);  // očisti da se ne ponavlja
  }
}, [pendingApptId, schedAppts]);

  // Najraniji budući termini po klijentu (globalno preko svih dana)
  useEffect(() => {
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
    const q = query(
      collection(db, "appointments"),
      where("status", "==", "booked"),
      where("dateKey", ">=", todayKey),
      orderBy("dateKey", "asc"),
      orderBy("startMin", "asc")
    );
    const off = onSnapshot(q, (s) => {
      const m = new Map();
      s.docs.forEach((d) => {
        const a = d.data();
        const phone = normPhone(a.clientPhone);
        if (!phone) return;
        if (!m.has(phone)) m.set(phone, d.id);
      });
      setFirstUpcomingApptIdByPhone(m);
    });
    return () => off();
  }, []);

  // defaults
 useEffect(() => {
  if (!autoPickedRef.current && selEmpId == null && employees.length && !isMobile) {
  setSelEmpId(employees[0].id);
     autoPickedRef.current = true; // auto-pick samo prvi put
   }
 }, [employees, isMobile, selEmpId]);

  useEffect(() => setSelSrvId(""), [selEmpId]);

  /* ------------ derived ------------ */

  const employeesById = useMemo(() => {
    const m = new Map();
    employees.forEach((e) => m.set(e.id, e));
    return m;
  }, [employees]);

  const servicesById = useMemo(() => {
    const m = new Map();
    services.forEach((s) => m.set(s.id, s));
    return m;
  }, [services]);

  // jedinstvena boja po kategoriji (stabilna po ID-u)
  const categoryColors = useMemo(() => {
    const m = new Map();
    const catIds = Array.from(new Set(services.map(s => s.categoryId).filter(Boolean)));
    for (const cid of catIds) m.set(cid, hashToColor(`cat:${cid}`));
    return m;
  }, [services]);

  const colorForCategoryId = (cid) =>
    categoryColors.get(cid) || hashToColor(`cat:${cid || "misc"}`);

  const dayDow = DOW[dayDate.getDay()];
  const dayHours = salonHours[dayDow] || DEFAULT_SALON_HOURS[dayDow];
  const openMin = timeToMin(dayHours.open);
  const closeMin = timeToMin(dayHours.close);

  const allowedServicesForSelectedEmp = useMemo(() => {
    const emp = employeesById.get(selEmpId);
    if (!emp) return [];
    const catSet = new Set(emp.categories || []);
    const srvSet = new Set(emp.services || []);
    return services.filter((s) => catSet.has(s.categoryId) || srvSet.has(s.id));
  }, [selEmpId, employeesById, services]);

  // Ko radi danas (za highlight dugmića)
// Ko radi danas (ima smenu i nije blokiran ceo dan)
const workingTodayIds = useMemo(() => {
  const ids = new Set();

  for (const e of employees) {
    const hasShift = dayShifts.some(s => s.employeeId === e.id);

    if (!hasShift) continue;

    // Ima li blokadu celog dana?
    const fullDayBlocked = appointments.some(
      a =>
        a.employeeId === e.id &&
        a.type === "block" &&
        a.startMin <= openMin &&
        a.endMin >= closeMin
    );

    if (!fullDayBlocked) ids.add(e.id);
  }

  return Array.from(ids);
}, [employees, dayShifts, appointments, openMin, closeMin]);


  // Koje kolone da prikažemo u gridu
const idsToRender = useMemo(() => {
  // MOBILNI: jedna izabrana ili ništa dok ne izabereš
  if (isMobile) return selEmpId ? [selEmpId] : [];

  // DESKTOP: ako je nešto ručno izabrano — prikaži baš to
  if (selectedEmpIds.length) return selectedEmpIds;

  // Fallback ponašanje kao ranije
  if (onlyWorking) return workingTodayIds;
  return employees.map(e => e.id);
}, [isMobile, selEmpId, selectedEmpIds, onlyWorking, workingTodayIds, employees]);



  const shiftsByEmp = useMemo(() => {
    const m = new Map();
    for (const s of dayShifts) {
      if (!m.has(s.employeeId)) m.set(s.employeeId, []);
      m.get(s.employeeId).push(...(s.segments || []));
    }
    for (const [k, arr] of m) {
      const norm = arr
        .map((seg) => ({
          start: clamp(timeToMin(seg.start), openMin, closeMin),
          end: clamp(timeToMin(seg.end), openMin, closeMin),
        }))
        .filter((x) => x.end > x.start)
        .sort((a, b) => a.start - b.start);
      m.set(k, mergeSegments(norm));
    }
    return m;
  }, [dayShifts, openMin, closeMin]);

  function mergeSegments(arr) {
    if (!arr.length) return [];
    const res = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      const a = res[res.length - 1];
      const b = arr[i];
      if (b.start <= a.end) a.end = Math.max(a.end, b.end);
      else res.push({ ...b });
    }
    return res;
  }
  function onEmpTouchStart(e, id) {
  const t = e.touches?.[0];
  empTouchStartRef.current.x = t?.clientX ?? 0;
  empTouchStartRef.current.y = t?.clientY ?? 0;
  clearTimeout(empHoldTimerRef.current);
  empHoldTimerRef.current = setTimeout(() => {
    const idx = employees.findIndex(x => x.id === id);
    setEmpSelectMode(true);
    setEmpSelectedId(id);
    setEmpSelectedIndex(idx);
    if (navigator.vibrate) navigator.vibrate(40);
  }, 300); // long press threshold
}
function onEmpTouchMove(e) {
  const t = e.touches?.[0];
  if (!t) return;
  const dx = Math.abs(t.clientX - empTouchStartRef.current.x);
  const dy = Math.abs(t.clientY - empTouchStartRef.current.y);
  if (dx > 12 || dy > 12) clearTimeout(empHoldTimerRef.current);
}
function onEmpTouchEnd() {
  clearTimeout(empHoldTimerRef.current);
}
async function onEmpMobileClick(targetId) {
  if (empSelectMode && empSelectedId && empSelectedId !== targetId) {
    // promeni redosled tako da selektovana ide DESNO od targeta
    const arr = employees.map(e => e.id);
    const moving = empSelectedId;
    const from = arr.indexOf(moving);
    arr.splice(from, 1);
    const to = arr.indexOf(targetId) + 1;
    arr.splice(to, 0, moving);
    // ovde možeš sačuvati u bazu ako želiš (setDoc u settings/employeeOrder)
    setEmpSelectMode(false);
    setEmpSelectedId(null);
    setEmpSelectedIndex(-1);
    return;
  }
  // običan tap → otvori raspored
  setSelEmpId(targetId);
}


  const apptsByEmp = useMemo(() => {
    const m = new Map();
    for (const a of appointments) {
      if (!m.has(a.employeeId)) m.set(a.employeeId, []);
      m.get(a.employeeId).push(a);
    }
    for (const [, arr] of m)
      arr.sort((a, b) => (a.startMin || 0) - (b.startMin || 0));
    return m;
  }, [appointments]);

  /* ------------ validations & actions (day) ------------ */

  const withinSalon = (s, e) => s >= openMin && e <= closeMin && e > s;
  const withinShift = (empId, s, e) => {
    const segs = shiftsByEmp.get(empId) || [];
    if (segs.length === 0) {
      return s >= openMin && e <= closeMin;
    }
    return segs.some((seg) => s >= seg.start && e <= seg.end);
  };
  const noOverlap = (empId, s, e, ignoreId) =>
    !(apptsByEmp.get(empId) || []).some(
      (a) => a.id !== ignoreId && overlaps(s, e, a.startMin, a.endMin)
    );

  const colorForServiceId = (id) => {
    const srv = servicesById.get(id);
    const catId = srv?.categoryId;
    return colorForCategoryId(catId);
  };


// jedinstvena pozadina za sve vrste "termina"

function apptStartDate(appt) {
  // lokalno vreme browsera (koristi Europe/Belgrade kod tebe)
  return new Date(`${appt.dateKey}T${appt.startHHMM || "00:00"}:00`);
}
async function blockWholeDaysRange({ employeeId, fromDate, toDate }) {
  if (!employeeId) return alert("Odaberi radnicu.");

  // normalizuj na ponoć
  const at0 = (d) => { const x=new Date(d); x.setHours(0,0,0,0); return x; };
  const add = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
  const S = at0(fromDate), E = at0(toDate);

  for (let d = new Date(S); d <= E; d = add(d, 1)) {
    const dowKey = DOW[d.getDay()]; // "sun"..."sat"
    const hours = (salonHours[dowKey] || DEFAULT_SALON_HOURS[dowKey]);
    const openMinLocal  = timeToMin(hours.open);
    const closeMinLocal = timeToMin(hours.close);
    if (!(closeMinLocal > openMinLocal)) continue;

    await addDoc(collection(db, "appointments"), {
      type: "block",
      status: "blocked",
      employeeId,
      employeeName: (employeesById.get(employeeId)?.name || ""),
      dateKey: `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`,
      startHHMM: minToTime(openMinLocal),
      endHHMM:   minToTime(closeMinLocal),
      startMin:  openMinLocal,
      endMin:    closeMinLocal,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  alert("Blokada je upisana za izabrane dane.");
}

  async function addItem() {
  const dk = dateKey(dayDate);
  const empId = selEmpId;
  if (!empId) return alert("Odaberi radnicu.");

  // --- BOOKING ---
  if (mode === "booking") {
    const srv = servicesById.get(selSrvId);
    if (!srv) return alert("Odaberi uslugu.");

    const start = timeToMin(startTime);
    const end   = start + Number(srv.durationMin || 0);

    // Validacije
    if (!withinSalon(start, end)) return alert("Van radnog vremena salona.");
    if (!withinShift(empId, start, end)) return alert("Van smene radnice.");
    if (!noOverlap(empId, start, end)) return alert("Preklapanje sa postojećim.");

    const phoneN = normPhone(clientPhone);
    const newRef = doc(collection(db, "appointments"));

    await runTransaction(db, async (tx) => {
      let penaltyApplied = null;

      if (phoneN) {
        const cRef = doc(db, "clients", phoneN);
        const cSnap = await tx.get(cRef);
        const pen = cSnap.exists() ? cSnap.data()?.pendingPenalty : null;

        if (pen?.amount > 0) {
          // Ako želiš UI potvrdu, uradi je PRE transakcije.
          penaltyApplied = {
            amount: Number(pen.amount || 0),
            sourceApptId: pen.sourceApptId || "",
            appliedAt: serverTimestamp(),
          };
          tx.set(
            cRef,
            { pendingPenalty: deleteField(), updatedAt: serverTimestamp() },
            { merge: true }
          );
        } else if (!cSnap.exists()) {
          // Kreiraj “kostur” klijenta
          tx.set(
            cRef,
            {
              phone: phoneN,
              name: clientName || "",
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        }
      }

      const apptDoc = {
        type: "booking",
        status: "booked",
        employeeId: empId,
        employeeName: employeesById.get(empId)?.name || "",
        dateKey: dk,
        startHHMM: minToTime(start),
        endHHMM: minToTime(end),
        startMin: start,
        endMin: end,
        serviceId: srv.id,
        serviceName: srv.name,
        durationMin: Number(srv.durationMin || 0),
        color: colorForCategoryId(srv.categoryId),
        clientName: clientName.trim(),
        clientPhone: clientPhone.trim(),
        price: getServicePrice(srv),
        penaltyApplied, // null ili objekat
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      tx.set(newRef, apptDoc);
    });

    setClientName("");
    setClientPhone("");
    return;
  }

  // --- BLOCK ---
  const start = timeToMin(startTime);
  const end   = timeToMin(endTime);

  if (!withinSalon(start, end)) return alert("Van radnog vremena salona.");
  if (!withinShift(empId, start, end)) return alert("Van smene radnice.");
  if (!noOverlap(empId, start, end)) return alert("Preklapanje sa postojećim.");

  await addDoc(collection(db, "appointments"), {
    type: "block",
    status: "blocked",
    employeeId: empId,
    employeeName: employeesById.get(empId)?.name || "",
    dateKey: dk,
    startHHMM: minToTime(start),
    endHHMM: minToTime(end),
    startMin: start,
    endMin: end,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}


  async function markAppt(id, patch) {
    await updateDoc(doc(db, "appointments", id), {
      ...patch,
      updatedAt: serverTimestamp(),
    });
  }
  async function deleteAppt(id) {
    if (!confirm("Obrisati stavku?")) return;
    await deleteDoc(doc(db, "appointments", id));
  }

  // mark no-show + increment client counter by phone
  async function markNoShowWithClient(appt) {
    if (!appt?.id) return;

    // status -> no-show
    await updateDoc(doc(db, "appointments", appt.id), {
      status: "no-show",
      noShowAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // razlika u satima do termina (lokalno)
    const apptDate = new Date(`${appt.dateKey}T${appt.startHHMM || "00:00"}`);
    const diffHours = (apptDate.getTime() - Date.now()) / 36e5;

    const phone = normPhone(appt.clientPhone);
    if (phone) {
      const cRef = doc(db, "clients", phone);

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(cRef);
        const data = snap.exists() ? snap.data() : {};

        tx.set(
          cRef,
          {
            phone,
            name: appt.clientName || "",
            noShowCount: increment(1),
            updatedAt: serverTimestamp(),
            createdAt: snap.exists()
              ? (data.createdAt || serverTimestamp())
              : serverTimestamp(),
          },
          { merge: true }
        );

        // < 6h => pending kazna ako je još nema
        if (appt.type === "booking" && diffHours < 6) {
          const hasActivePenalty =
            data.pendingPenalty && Number(data.pendingPenalty.amount || 0) > 0;
          if (hasActivePenalty) return;

          const penaltyAmount = computePenaltyAmountFromAppt(appt, servicesById);

          tx.set(
            cRef,
            {
              pendingPenalty: {
                amount: penaltyAmount,
                sourceApptId: appt.id,
                sourceService: appt.serviceName || "",
                createdAt: serverTimestamp(),
              },
            },
            { merge: true }
          );
        }
      });

      await applyPendingToEarliestAppt(db, phone);
    }
  }

  async function cancelApptWithRule(appt) {
  if (!appt?.id) return;

  // status -> cancelled
  await updateDoc(doc(db, "appointments", appt.id), {
    status: "cancelled",
    cancelledAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // razlika u satima do termina (lokalno)
  const apptDate = new Date(`${appt.dateKey}T${appt.startHHMM || "00:00"}`);
  const diffHours = (apptDate.getTime() - Date.now()) / 36e5;

  // < 6h => pending kazna ako je još nema, pa pokušaj odmah da je “zalepiš” na najraniji budući
  if (appt.type === "booking" && diffHours < 6) {
    const phone = normPhone(appt.clientPhone);
    if (phone) {
      const cRef = doc(db, "clients", phone);

      const created = await runTransaction(db, async (tx) => {
        const snap = await tx.get(cRef);
        const data = snap.exists() ? snap.data() : {};

        const hasActivePenalty =
          data.pendingPenalty && Number(data.pendingPenalty.amount || 0) > 0;
        if (hasActivePenalty) return 0;

        const penaltyAmount = computePenaltyAmountFromAppt(appt, servicesById);

        tx.set(
          cRef,
          {
            phone,
            name: appt.clientName || "",
            pendingPenalty: {
              amount: penaltyAmount,
              sourceApptId: appt.id,
              sourceService: appt.serviceName || "",
              createdAt: serverTimestamp(),
            },
            updatedAt: serverTimestamp(),
            createdAt: snap.exists()
              ? (data.createdAt || serverTimestamp())
              : serverTimestamp(),
          },
          { merge: true }
        );
        return penaltyAmount;
      });

      if (created > 0) {
        await applyPendingToEarliestAppt(db, phone, created);
      }
    }
  }
}


  /* ------------ month helpers ------------ */

  function firstDayOfMonth(monthStr) {
    const [y, m] = monthStr.split("-").map((n) => parseInt(n, 10));
    return new Date(y, m - 1, 1);
  }
  function daysInMonth(monthStr) {
    const d = firstDayOfMonth(monthStr);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  }
function computePenaltyAmountFromAppt(appt, servicesById) {
  const srv = servicesById.get(appt.serviceId);
  const fallback = getServicePrice(srv);
  const basePrice = Number(appt.price ?? fallback ?? 0);
  return Math.round(basePrice * 0.5);
}
  async function applyMonthTemplate() {
    const empId = monthEmpId;
    if (!empId) return alert("Odaberi radnicu.");
    if (!templateDays.size) return alert("Odaberi dane u nedelji.");
    const startM = timeToMin(tplStart);
    const endM = timeToMin(tplEnd);
    if (!(endM > startM)) return alert("Vreme šablona nije validno.");

    setBusy(true);
    try {
      const total = daysInMonth(monthAnchor);
      const base = firstDayOfMonth(monthAnchor);
      for (let day = 1; day <= total; day++) {
        const d = new Date(base.getFullYear(), base.getMonth(), day);
        const dowIdx = d.getDay();
        if (!templateDays.has(dowIdx)) continue;

        const sh =
          salonHours[DOW[dowIdx]] || DEFAULT_SALON_HOURS[DOW[dowIdx]];
        const open = timeToMin(sh.open);
        const close = timeToMin(sh.close);
        const S = clamp(startM, open, close);
        const E = clamp(endM, open, close);
        if (!(E > S)) continue;

        const key = dateKey(d);
        const id = `${empId}_${key}`;
        await setDoc(doc(db, "shifts", id), {
          employeeId: empId,
          dateKey: key,
          segments: [{ start: minToTime(S), end: minToTime(E) }],
          updatedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
        });
      }
      alert("Smena postavljena za odabrani mesec.");
    } finally {
      setBusy(false);
    }
  }

  async function applySingleDayShift() {
    const empId = monthEmpId;
    if (!empId) return alert("Odaberi radnicu.");
    if (!oneDay) return alert("Odaberi datum.");

    const base = new Date(oneDay + "T00:00:00");
    const key = dateKey(base);

    const dow = DOW[base.getDay()];
    const sh = salonHours[dow] || DEFAULT_SALON_HOURS[dow];
    const open = timeToMin(sh.open);
    const close = timeToMin(sh.close);
    const S = clamp(timeToMin(oneStart), open, close);
    const E = clamp(timeToMin(oneEnd), open, close);
    if (!(E > S)) return alert("Vreme smene nije validno.");

    const existing = monthShifts.find(
      (s) => s.employeeId === empId && s.dateKey === key
    );
    if (existing) {
      const ok = confirm("Za taj dan već postoji smena. Zameniti je novom?");
      if (!ok) return;
    }

    const id = `${empId}_${key}`;
    await setDoc(doc(db, "shifts", id), {
      employeeId: empId,
      dateKey: key,
      segments: [{ start: minToTime(S), end: minToTime(E) }],
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    });

    alert("Smena upisana za izabrani dan.");
  }

  // Vacation: blocks the whole existing shift per day
  async function applyVacationRange() {
    const empId = monthEmpId;
    if (!empId) return alert("Odaberi radnicu.");
    if (!vacStart) return alert("Odaberi datum početka odmora.");
    const daysCount = Math.max(1, Number(vacDays || 0));

    const base = new Date(vacStart + "T00:00:00");
    const monthOfAnchor = firstDayOfMonth(monthAnchor).getMonth();

    setBusyVac(true);
    try {
      for (let i = 0; i < daysCount; i++) {
        const d = new Date(
          base.getFullYear(),
          base.getMonth(),
          base.getDate() + i
        );
        if (d.getMonth() !== monthOfAnchor) continue;

        const key = dateKey(d);
        const segs = monthShifts
          .filter((s) => s.employeeId === monthEmpId && s.dateKey === key)
          .flatMap((s) => s.segments || []);
        if (!segs.length) continue;

        for (const s of segs) {
          const startMin = timeToMin(s.start);
          const endMin = timeToMin(s.end);
          if (!(endMin > startMin)) continue;

          const id = `vac_${monthEmpId}_${key}_${s.start.replace(":", "")}`;
          await setDoc(doc(db, "appointments", id), {
            type: "vacation",
            status: "vacation",
            employeeId: monthEmpId,
            employeeName: employeesById.get(monthEmpId)?.name || "",
            dateKey: key,
            startHHMM: minToTime(startMin),
            endHHMM: minToTime(endMin),
            startMin,
            endMin,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }
      alert("Odmor je upisan.");
    } finally {
      setBusyVac(false);
    }
  }

  /* ------------ drag & drop (kolona→kolona) ------------ */

  const onApptDragStart = (a) => (e) => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ id: a.id }));
    e.dataTransfer.effectAllowed = "move";
  };
  const onColDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onColDrop = (empIdTarget) => async (e) => {
    e.preventDefault();
    const data = e.dataTransfer.getData("text/plain");
    if (!data) return;
    const { id } = JSON.parse(data);
    const a = appointments.find((x) => x.id === id);
    if (!a) return;
    if (a.employeeId === empIdTarget) return;
    const segs = shiftsByEmp.get(empIdTarget) || [];
    a.startMin = a.startMin ?? timeToMin(a.startHHMM);
    a.endMin = a.endMin ?? timeToMin(a.endHHMM);
    const okShift = segs.length === 0 ? (a.startMin >= openMin && a.endMin <= closeMin) : segs.some(
      (seg) => a.startMin >= seg.start && a.endMin <= seg.end
    );
    if (!okShift) {
      alert("Termin je van smene ciljane radnice.");
      return;
    }
    if (!noOverlap(empIdTarget, a.startMin, a.endMin, a.id)) {
      alert("Termin se preklapa kod ciljane radnice.");
      return;
    }
    await updateDoc(doc(db, "appointments", id), {
      employeeId: empIdTarget,
      employeeName: employeesById.get(empIdTarget)?.name || "",
      updatedAt: serverTimestamp(),
    });
  };

  /* ------------ modal open on click ------------ */

 

  /* ------------ create block from drag ------------ */

  const handleCreateBlock = async (empId, startMin, endMin) => {
    const dk = dateKey(dayDate);
    const start = startMin;
    const end = endMin;

    if (!withinSalon(start, end)) return alert("Van radnog vremena salona.");
    if (!withinShift(empId, start, end)) return alert("Van smene radnice.");
    if (!noOverlap(empId, start, end)) return alert("Preklapanje sa postojećim.");

    await addDoc(collection(db, "appointments"), {
      type: "block",
      status: "blocked",
      employeeId: empId,
      employeeName: employeesById.get(empId)?.name || "",
      dateKey: dk,
      startHHMM: minToTime(start),
      endHHMM: minToTime(end),
      startMin: start,
      endMin: end,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  };

  /* ------------ render ------------ */

  return (
    <div style={wrap}>
      <div style={panel} className="admincal">
        <style>{responsiveCSS}</style>
        {/* Dugme nazad */}
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={() => nav(-1)}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,.35)",
              background: "linear-gradient(135deg,#ffffff,#ffe3ef)",
              fontWeight: 700,
              cursor: "pointer",
              fontSize: isMobile ? 14 : 16,
              color: "#000",      
            }}
          >
            ← Nazad
          </button>
        </div>
        <div style={tabbar}>
          <button
            style={tab === "day" ? tabBtnActive : tabBtn}
            onClick={() => setTab("day")}
          >
            Kalendar
          </button>
          <button
            style={tab === "month" ? tabBtnActive : tabBtn}
            onClick={() => setTab("month")}
          >
            Raspored smena
          </button>
          <button
            style={tab === "schedule" ? tabBtnActive : tabBtn}
            onClick={() => setTab("schedule")}
          >
            Raspored
          </button>
        </div>

        {tab === "day" ? (
          <>
            {/* CONTROLS */}
            <div style={ctlWrap} className="ctl">
              
              
             <div style={ctlRowA} className="ctl-row-a">
  <div style={ctlItem}>
    <label style={lbl}>
      <FiCalendar /> Datum
    </label>
    <input
      type="date"
      value={dateKey(dayDate)}
      onChange={(e) => setDayDate(new Date(e.target.value + "T00:00:00"))}
      style={inp}
    />
  </div>
  

  <div style={ctlItem}>
    <label style={lbl}>
      <FiUser /> Radnica
    </label>
    <select
      value={selEmpId}
      onChange={(e) => setSelEmpId(e.target.value)}
      style={inp}
    >
      {employees.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name}
        </option>
      ))}
    </select>
  </div>

  {/* Početak — SAKRIJ kad je block + panel sa danima */}
 {showModeFields && !(mode === "block" && showBlockDaysUI) && (
    <div style={ctlItem}>
      <label style={lbl}>
        <FiClock /> Početak
      </label>
      <input
        type="time"
        step="300"
        lang="sr-RS"
        value={startTime}
        onChange={(e) => setStartTime(e.target.value)}
        style={inp}
        min={dayHours.open}
        max={dayHours.close}
      />
    </div>
  )}

  {/* Termin / Blokada */}
  <div style={ctlItem}>
    <label style={lbl}>Režim</label>
    <div style={segWrap}>
      {["booking", "block"].map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => {
            setMode(m);
            // ako je blokada → otvori panel sa danima; termin → zatvori
            setShowBlockDaysUI(m === "block");
          }}
          style={segBtn(mode === m)}
        >
          {m === "booking" ? "Termin" : "Blokada"}
        </button>
      ))}
    </div>
  </div>

 {mode === "booking" ? (
   showModeFields && <div style={ctlItem}>
      <label style={lbl}>Usluga</label>
      <select
        value={selSrvId}
        onChange={(e) => setSelSrvId(e.target.value)}
        style={inp}
      >
        <option value="">— Odaberi —</option>
        {allowedServicesForSelectedEmp.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({s.durationMin} min)
          </option>
        ))}
      </select>
    </div>
  ) : (
    // Kraj — SAKRIJ kad je block + panel sa danima
    showModeFields && !(mode === "block" && showBlockDaysUI) && (
      <div style={ctlItem}>
        <label style={lbl}>Kraj</label>
        <input
          type="time"
          step="300"
          lang="sr-RS"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
          style={inp}
          min={dayHours.open}
          max={dayHours.close}
        />
      </div>
    )
  )}

  {mode === "booking" && (
    <>
<div style={ctlItem}>
  <label style={lbl}>Klijent</label>
  <input
    list="client-options"
    value={clientName}
    onChange={(e) => {
      const v = e.target.value;
      setClientName(v);

      let hit = clientsAll.find(c => (c.name || "").toLowerCase() === v.toLowerCase());
      if (!hit && v.includes("•")) {
        const maybePhone = v.split("•").pop().trim();
        hit = clientsAll.find(c => c.phone === maybePhone);
      }
      if (hit) {
        setClientName(hit.name || "");
        setClientPhone(hit.phone || "");
      }
    }}
    style={inp}
    placeholder="Ime klijenta"
  />
  <datalist id="client-options">
    {clientsAll.map((c, i) => (
      <option key={i} value={`${c.name} • ${c.phone}`} />
    ))}
  </datalist>
</div>

    </>
  )}

  {/* Glavno dugme — SAKRIJ kad je block + panel sa danima */}
  {showModeFields && !(mode === "block" && showBlockDaysUI) && (
    <div style={{ ...ctlItem, alignSelf: "flex-end" }}>
      <button style={primaryBtn} onClick={addItem}>
        <FiPlus style={{ marginRight: 6 }} />
        {mode === "booking" ? "Dodaj termin" : "Blokiraj period"}
      </button>
    </div>
  )}
</div>

{/* Panel za izbor dana — prikazuje se ispod kontrola */}
<BlockDaysBar
  visible={mode === "block" && showBlockDaysUI}
  anchorDate={dayDate}
  isMobile={isMobile}               // ⬅ DODAJ OVO
  onCancel={() => setShowBlockDaysUI(false)}
  onConfirm={async (dStart, dEnd) => {
    await blockWholeDaysRange({
      employeeId: selEmpId,
      fromDate: dStart,
      toDate: dEnd,
    });
    setShowBlockDaysUI(false);
  }}
/>



              {/* MOBILNA TRAKA RADNICA */}
              {isMobile && (
                <div
                  className="emp-strip-mobile"
                  style={{
                    display: "flex",
                    flexWrap: "nowrap",
                    overflowX: "auto",
                    touchAction: "pan-x",
                    gap: 8,
                    padding: "6px 0",
                    WebkitOverflowScrolling: "touch",
                    scrollbarWidth: "none",
                  }}
                >
                 {empOrder.map((id) => {
  const e = employees.find(x => x.id === id);
  if (!e) return null;
  const isWorking = workingTodayIds.includes(e.id);
  const isSelected = selectedEmpIds.includes(e.id);
  return (
    <button
      key={e.id}
      onClick={() => { toggleEmp(e.id); setSelEmpId(e.id); }}
      draggable
      onDragStart={(ev) => {
        ev.dataTransfer.setData("text/plain", e.id);
        ev.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(ev) => ev.preventDefault()}
      onDrop={(ev) => {
        ev.preventDefault();
        const movingId = ev.dataTransfer.getData("text/plain");
        if (!movingId || movingId === e.id) return;

        const arr = empOrder.slice();
        const from = arr.indexOf(movingId);
        arr.splice(from, 1);
        const to = arr.indexOf(e.id);
        arr.splice(to, 0, movingId);

        setEmpOrder(arr); // ⇐ ovde menja redosled u UI
      }}
      onContextMenu={(e) => e.preventDefault()}
  style={{
    outline: empSelectMode && empSelectedId === e.id ? "2px solid hotpink" : "none",
                          flex: "0 0 auto",
                          padding: "8px 14px",
                          borderRadius: 999,
                          border: "1px solid rgba(255,255,255,.35)",
                          background: isSelected
                            ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)"
                            : isWorking
                            ? "linear-gradient(135deg,#ffffff,#ffe3ef)"
                            : "rgba(255,255,255,.12)",
                          color: isSelected ? "#fff" : "#000",
                          fontWeight: 800,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                            userSelect: "none",
  WebkitUserSelect: "none",

                        }}
                      >
                        {e.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {/* DESKTOP TRAKA RADNICA */}
{!isMobile && (
 <div
   className="emp-strip-desktop"
  style={{
     display: "flex",
     flexWrap: "wrap",        // ⇐ dozvoli prelamanje u više redova
    overflowX: "visible",    // ⇐ bez horizontalnog skrola
    gap: 8,
     rowGap: 6,               // ⇐ malo vertikalnog razmaka između redova
     padding: "6px 0",
     marginTop: 6,
     alignItems: "center",
   }}
  >
    {/* Pomoćna dugmad levo */}
    <button
      onClick={() => { setSelEmpId(null); setOnlyWorking(true); setSelectedEmpIds(workingTodayIds); }}


      style={{
        flex: "0 0 auto",
 padding: manyEmployees ? "6px 10px" : "8px 14px",
     marginBottom: 6,
        borderRadius: 999,
        border: "1px solid rgba(255,255,255,.35)",
        background: "linear-gradient(135deg,#ffffff,#eaf5ff)",
        color: "#000",
        fontWeight: 800,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
      title="Prikaži samo radnice koje danas imaju smenu"
    >
      Ko radi danas
    </button>
    <button
   onClick={() => { setSelEmpId(null); setOnlyWorking(false); setSelectedEmpIds(employees.map(e => e.id)); }}

      style={{
        flex: "0 0 auto",
           padding: manyEmployees ? "6px 10px" : "8px 14px",
    marginBottom: 6,
        borderRadius: 999,
        border: "1px solid rgba(255,255,255,.35)",
        background: "linear-gradient(135deg,#ffffff,#ffe3ef)",
        color: "#000",
        fontWeight: 800,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
      title="Prikaži sve radnice"
    >
      Sve radnice
    </button>

    {/* Lista radnica desno */}
   {empOrder.map((id) => {
  const e = employees.find(x => x.id === id);
  if (!e) return null;
  const isWorking = workingTodayIds.includes(e.id);
  const isSelected = selectedEmpIds.includes(e.id);
  return (
    <button
      key={e.id}
      onClick={() => { toggleEmp(e.id); setSelEmpId(e.id); }}
      draggable
      onDragStart={(ev) => {
        ev.dataTransfer.setData("text/plain", e.id);
        ev.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(ev) => ev.preventDefault()}
      onDrop={(ev) => {
        ev.preventDefault();
        const movingId = ev.dataTransfer.getData("text/plain");
        if (!movingId || movingId === e.id) return;

        const arr = [...empOrder];
        const from = arr.indexOf(movingId);
        arr.splice(from, 1);
        const to = arr.indexOf(e.id);
        arr.splice(to, 0, movingId);

        setEmpOrder(arr);  // ⬅ sad osvežava redosled
      }}
      style={{
        flex: "0 0 auto",
        padding: manyEmployees ? "6px 10px" : "8px 14px",
        marginBottom: 6,
        borderRadius: 999,
        border: "1px solid rgba(255,255,255,.35)",
        background: isSelected
          ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)"
          : isWorking
          ? "linear-gradient(135deg,#ffffff,#ffe3ef)"
          : "rgba(255,255,255,.12)",
        color: isSelected ? "#fff" : "#000",
        fontWeight: 800,
        fontSize: manyEmployees ? 13 : 16,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
      title={isWorking ? "Radi danas" : "Nije u smeni danas"}
    >
      {e.name}
    </button>
  );
})}
  </div>
)}
{/* GORNJI H-SKROL IZNAD KOLONA */}
{/* GORNJI H-SKROL IZNAD KOLONA (bez CSS fajla) */}
<div
  ref={topScrollRef}
  style={{
    position: "sticky",
    top: 0,
    zIndex: 5,
    height: 18,
    overflowX: "auto",
    overflowY: "hidden",
    margin: "4px 0 8px",
    WebkitOverflowScrolling: "touch",
    background: "rgba(255,255,255,.08)",
  }}
>
  <div ref={topSpacerRef} style={{ height: 1 }} />
</div>

{/* WRAP KOJI “NOSI” GRID I SAKRIVA DONJI SCROLL */}
<div
  ref={colsWrapRef}
  style={{ overflowX: "hidden", overflowY: "hidden" }}
  onWheel={(e) => {
    const sc = topScrollRef.current;
    if (!sc) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    sc.scrollLeft += delta;
  }}
>
  {/* UNUTRAŠNJI KONTEJNER – meri stvarnu širinu grida */}
  <div
    ref={innerRef}
    style={{
      display: "inline-block",
      width: "max-content", // neka širina bude po sadržaju (sve kolone)
    }}
  >
  {/* GRID */}
  <DayGrid
    employees={employees}
    employeesById={employeesById}
    employeeIdsForDay={idsToRender}
    shiftsByEmp={shiftsByEmp}
    appointments={appointments}
    openMin={openMin}
    closeMin={closeMin}
    colorForServiceId={colorForServiceId}
    servicesById={servicesById}
    setHoverApptId={setHoverApptId}
    hoverApptId={hoverApptId}
    onApptClick={openApptModal}
    markAppt={markAppt}
    deleteAppt={deleteAppt}
    onApptDragStart={onApptDragStart}
    onColDragOver={onColDragOver}
    onColDrop={onColDrop}
    noShowByPhone={noShowByPhone}
    pendingPenaltyByPhone={pendingPenaltyByPhone}
    earliestApptIdByPhone={firstUpcomingApptIdByPhone}
    isMobile={isMobile}
    initialScrollMin={initialScrollMin}
    onCreateBlock={handleCreateBlock}
  />
</div>
</div>
          </>
        ) : tab === "month" ? (
          <>
            {/* MONTH PLANNER + DAY STRIP + ROSTER */}
            <div style={monthWrap} className="month-wrap">
              {/* RED 1 */}
              <div style={row} className="month-row">
                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiUser /> Radnica
                  </label>
                  <select
                    value={monthEmpId}
                    onChange={(e) => setMonthEmpId(e.target.value)}
                    style={inp}
                  >
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiCalendar /> Mesec
                  </label>
                  <input
                    type="month"
                    value={monthAnchor}
                    onChange={(e) => setMonthAnchor(e.target.value)}
                    style={inp}
                  />
                </div>

                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiClock /> Početak
                  </label>
                  <input
                    type="time"
                    step="300"
                    lang="sr-RS"
                    value={tplStart}
                    onChange={(e) => setTplStart(e.target.value)}
                    style={inp}
                  />
                </div>

                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiClock /> Kraj
                  </label>
                  <input
                    type="time"
                    step="300"
                    lang="sr-RS"
                    value={tplEnd}
                    onChange={(e) => setTplEnd(e.target.value)}
                    style={inp}
                  />
                </div>

                <div style={ctlItem}>
                  <label style={lbl}>Dani u nedelji</label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {DOW_SR.map((d, i) => (
                      <button
                        key={i}
                        style={dayChip(templateDays.has(i))}
                        onClick={() => toggleTplDay(i)}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={btnRow}>
                  <button onClick={pickWorkdays} style={primaryBtn}>
                    Radni dani
                  </button>
                  <button onClick={pickAllDays} style={primaryBtn}>
                    Cela nedelja
                  </button>
                  <button onClick={clearTplDays} style={primaryBtn}>
                    Očisti
                  </button>
                  <button disabled={busy} onClick={applyMonthTemplate} style={primaryBtn}>
                    {busy ? "..." : "Primeni šablon"}
                  </button>
                </div>
              </div>

              {/* RED 2: single day */}
              <div style={row} className="month-row">
                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiCalendar /> Pojedinačni dan
                  </label>
                  <input
                    type="date"
                    value={oneDay}
                    onChange={(e) => setOneDay(e.target.value)}
                    style={inp}
                  />
                </div>

                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiClock /> Početak
                  </label>
                  <input
                    type="time"
                    step="300"
                    lang="sr-RS"
                    value={oneStart}
                    onChange={(e) => setOneStart(e.target.value)}
                    style={inp}
                  />
                </div>

                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiClock /> Kraj
                  </label>
                  <input
                    type="time"
                    step="300"
                    lang="sr-RS"
                    value={oneEnd}
                    onChange={(e) => setOneEnd(e.target.value)}
                    style={inp}
                  />
                </div>

                <div style={{ ...ctlItem, alignSelf: "flex-end" }}>
                  <button disabled={busy} onClick={applySingleDayShift} style={primaryBtn}>
                    {busy ? "..." : "Postavi smenu"}
                  </button>
                </div>
              </div>

              {/* RED 3: vacation */}
              <div style={row} className="month-row">
                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiCalendar /> Početni dan odmora
                  </label>
                  <input
                    type="date"
                    value={vacStart}
                    onChange={(e) => setVacStart(e.target.value)}
                    style={inp}
                  />
                </div>

                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiClock /> Broj dana
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="31"
                    value={vacDays}
                    onChange={(e) => setVacDays(e.target.value)}
                    style={inp}
                  />
                </div>

                <div style={{ ...ctlItem, alignSelf: "flex-end" }}>
                  <button disabled={busyVac} onClick={applyVacationRange} style={primaryBtn}>
                    {busyVac ? "..." : "Postavi odmor"}
                  </button>
                </div>
              </div>

              {/* ROSTER WINDOW */}
              <MonthRosterWindow
                monthStr={monthAnchor}
                shifts={monthShifts}
                breaks={timeOffs}
                employeesById={employeesById}
                isMobile={isMobile}
              />
            </div>
          </>
        ) : tab === "schedule" ? (
          <>
            {/* SCHEDULE CONTROLS */}
            <div style={ctlWrap} className="ctl">
              <div style={ctlRowA} className="ctl-row-a">
                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiCalendar /> Datum
                  </label>
                  <input
                    type="date"
                    value={dateKey(schedDate)}
                    onChange={(e) =>
                      setSchedDate(new Date(e.target.value + "T00:00:00"))
                    }
                    style={inp}
                  />
                </div>
             

              </div>
                  <WeekStrip
      anchorDate={schedDate}
      onPick={(d) => setSchedDate(d)}
      isMobile={isMobile}
    />
            </div>
   

            {/* SCHEDULE GRID */}
            <ScheduleGrid
              dateObj={schedDate}
              appts={schedAppts}
              salonHours={salonHours}
              employeesById={employeesById}
              servicesById={servicesById}
              colorForServiceId={colorForServiceId}
              onApptClick={openApptModal}
              noShowByPhone={noShowByPhone}
              pendingPenaltyByPhone={pendingPenaltyByPhone}
              earliestApptIdByPhone={firstUpcomingApptIdByPhone}
              isMobile={isMobile}
            />
          </>
        ) : null}

        {/* MODAL */}
        {activeAppt &&
          createPortal(
            <ApptModal
              appt={activeAppt}
              onClose={closeApptModal}
              employees={employees}
              employeesById={employeesById}
              servicesById={servicesById}
              salonHours={salonHours}
              shiftsByEmp={shiftsByEmp}
              pendingPenaltyByPhone={pendingPenaltyByPhone}
              earliestApptIdByPhone={firstUpcomingApptIdByPhone}
              colorForServiceId={colorForServiceId}
              
  initialScrollMin={initialScrollMin}
              onSave={async (patch) => {
                const srv = servicesById.get(activeAppt.serviceId);
                const duration = activeAppt.durationMin || srv?.durationMin || 0;
                const newStart = timeToMin(patch.startHHMM || activeAppt.startHHMM);
                const newEnd = newStart + duration;

                const dow = DOW[new Date(activeAppt.dateKey + "T00:00:00").getDay()];
                const hours = salonHours[dow] || DEFAULT_SALON_HOURS[dow];
                const open = timeToMin(hours.open);
                const close = timeToMin(hours.close);

                if (!(newEnd > newStart && newStart >= open && newEnd <= close)) {
                  alert("Vreme je van radnog vremena salona.");
                  return;
                }
                const emp = patch.employeeId || activeAppt.employeeId;
                const segs = shiftsByEmp.get(emp) || [];
                let okShift;
                if (segs.length === 0) {
                  okShift = newStart >= open && newEnd <= close;
                } else {
                  okShift = segs.some(
                    (seg) => newStart >= seg.start && newEnd <= seg.end
                  );
                }
                if (!okShift) {
                  alert("Vreme je van smene radnice.");
                  return;
                }
                if (!noOverlap(emp, newStart, newEnd, activeAppt.id)) {
                  alert("Preklapanje sa postojećim terminom.");
                  return;
                }

                await updateDoc(doc(db, "appointments", activeAppt.id), {
                  ...patch,
                  employeeId: emp,
                  employeeName: employeesById.get(emp)?.name || "",
                  startHHMM: minToTime(newStart),
                  endHHMM: minToTime(newEnd),
                  startMin: newStart,
                  endMin: newEnd,
                  updatedAt: serverTimestamp(),
                });
                setActiveAppt(null);
              }}
              onNoShow={async () => {
                await markNoShowWithClient(activeAppt);
                setActiveAppt(null);
              }}
             onCancel={async () => {
  await cancelApptWithRule(activeAppt);
  setActiveAppt(null);
}}

              onDelete={async () => {
                await deleteAppt(activeAppt.id);
                setActiveAppt(null);
              }}
              noShowByPhone={noShowByPhone}
            />,
            document.body
          )}
      </div>
    </div>
  );
}

/* -------------------- DayStrip (horizontal days) -------------------- */

function DayStrip({ monthStr, selectedKey, onPickDay, compact = false, chunkSize = 7 }) {
  const base = new Date(monthStr + "-01T00:00:00");
  const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const ref = useRef(null);

  const selDay = selectedKey ? new Date(selectedKey + "T00:00:00").getDate() : 1;
  const [page, setPage] = useState(Math.floor((selDay - 1) / chunkSize));

  useEffect(() => {
    const newPage = Math.floor((selDay - 1) / chunkSize);
    if (newPage !== page) setPage(newPage);
  }, [selDay, chunkSize]);

  const startDay = page * chunkSize + 1;
  const endDay = Math.min(startDay + chunkSize - 1, days);

  return (
    <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>◀</button>
      <div style={stripWrap} ref={ref}>
        {Array.from({ length: endDay - startDay + 1 }, (_, i) => startDay + i).map((d) => {
          const k = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(d)}`;
          const isSel = k === selectedKey;
          return (
            <button
              key={k}
              data-daykey={k}
              className="strip-btn"
              style={stripBtn(isSel, compact)}
              onClick={() => onPickDay(k)}
            >
              <div style={{ fontSize: 12, opacity: 0.85 }}>
                {DOW_SR[new Date(k + "T00:00:00").getDay()]}
              </div>
              <div style={{ fontWeight: 900, fontSize: compact ? 14 : 16 }}>{d}</div>
            </button>
          );
        })}
      </div>
      <button disabled={endDay === days} onClick={() => setPage(page + 1)}>▶</button>
    </div>
  );
}

/* -------------------- Day grid -------------------- */
function DayGrid({
  employees,
  employeesById,
  employeeIdsForDay,
  shiftsByEmp,
  appointments,
  openMin,
  closeMin,
  colorForServiceId,
  servicesById,
  initialScrollMin,
  setHoverApptId,
  hoverApptId,
  onApptClick,
  markAppt,
  deleteAppt,
  onApptDragStart,
  onColDragOver,
  onColDrop,
  noShowByPhone,
  pendingPenaltyByPhone,
  earliestApptIdByPhone,
  isMobile,
  onCreateBlock,
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragEmpId, setDragEmpId] = useState(null);
  const [dragStartMin, setDragStartMin] = useState(0);
  const [previewTop, setPreviewTop] = useState(0);
  const [previewHeight, setPreviewHeight] = useState(0);
  const [dragCurrentMin, setDragCurrentMin] = useState(null);

  // Tap-tap selekcija (telefon)
  const [tapStartMin, setTapStartMin] = useState(null);
  const [tapEmpId, setTapEmpId] = useState(null);

  // Armiranje draga na mobilnom (dozvoli prirodan scroll dok ne pređe prag)
  const [isArming, setIsArming] = useState(false);
  const armStartYRef = useRef(0);
  const armStartMinRef = useRef(0);

  // Ref-ovi na tela kolona da bismo skrolovali najbliži scroll container
  const colRefs = useRef(new Map());

  const DRAG_THRESHOLD_PX = 20;
  const EDGE_PX = 60;
  const AUTOSCROLL_STEP = 16;

  // SNAP: grublje na mobilnom (lakše pogoditi), finije na desktopu
  const SNAP_MIN = isMobile ? 30 : 5;

  // ---------- NOVO: layout kolona (desktop: jedan red + h-scroll) ----------
  const COL_W = isMobile ? "100%" : 220; // po želji spusti na 200/180
  const colsOuter = {
    display: "flex",
    flexDirection: "row",
    flexWrap: "nowrap",
    overflowX: "auto",
    overflowY: "hidden",
    gap: 8,
    paddingBottom: 8,
    WebkitOverflowScrolling: "touch",
    scrollbarWidth: "thin",
  };
  // Ako već imaš colBox definisan globalno, zadrži ga; ovo je kompatibilno:

  // ------------------------------------------------------------------------

  // touch sa unutrašnjih elemenata ne sme da “procure” do kolone
  const stopTouchPropagation = (e) => {
    e.stopPropagation();
  };

  // “×” dugme za brisanje BLOKA
  const blockDeleteBtn = {
    position: "absolute",
    right: 8,
    top: 8,
    width: 22,
    height: 22,
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,.35)",
    background: "rgba(255,255,255,.9)",
    fontWeight: 800,
    lineHeight: "20px",
    textAlign: "center",
    cursor: "pointer",
    zIndex: 5,
  };

  // Mobile header red i dugme
  const mobileHeaderRow = {
    width: "100%",
    boxSizing: "border-box",
    padding: "16px 14px 10px",
    marginTop: -20,
    marginBottom: 10,
    display: "block",
  };
  const blockDayBtn = {
    display: "block",
    width: "100%",
    padding: "12px 16px",
    fontSize: 13,
    fontWeight: 500,
    borderRadius: 1,
    border: "1px solid rgba(255,255,255,.35)",
    background: "rgba(255,95,162,.9)",
    color: "#fff",
    cursor: "pointer",
    lineHeight: 1,
    textAlign: "center",
    boxShadow: "0 2px 6px rgba(0,0,0,.15)",
  };

  const getClientY = (e) => {
    const t = e.touches?.[0] || e.changedTouches?.[0];
    return t ? t.clientY : e.clientY;
  };

  const getMinFromEvent = (e) => {
    const clientY = getClientY(e);
    const rect = e.currentTarget.getBoundingClientRect();
    const y = clientY - rect.top;

    // 1px ≈ 1min * 3.5 (tvoj scale)
    let min = openMin + Math.floor(y / 3.5);

    // SNAP
    min = Math.round(min / SNAP_MIN) * SNAP_MIN;

    return clamp(min, openMin, closeMin);
  };

  const getScrollContainer = (el) => {
    let node = el;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      const oy = style.overflowY;
      if (/(auto|scroll|overlay)/.test(oy) && node.scrollHeight > node.clientHeight) {
        return node;
      }
      node = node.parentElement;
    }
    return window;
  };

  const autoScrollOnEdge = (clientY, anchorEl) => {
    const scroller = getScrollContainer(anchorEl);
    if (scroller === window) {
      if (clientY > window.innerHeight - EDGE_PX) {
        window.scrollBy(0, AUTOSCROLL_STEP);
      } else if (clientY < EDGE_PX) {
        window.scrollBy(0, -AUTOSCROLL_STEP);
      }
    } else {
      const rect = scroller.getBoundingClientRect();
      if (clientY > rect.bottom - EDGE_PX) {
        scroller.scrollTop += AUTOSCROLL_STEP;
      } else if (clientY < rect.top + EDGE_PX) {
        scroller.scrollTop -= AUTOSCROLL_STEP;
      }
    }
  };

  // Blokiraj ceo dan
  const blockWholeDay = (empId, segs) => {
    if (segs && segs.length) {
      segs.forEach((s) => {
        const sMin = timeToMin(s.start);
        const eMin = timeToMin(s.end);
        if (eMin > sMin) onCreateBlock(empId, sMin, eMin);
      });
    } else {
      onCreateBlock(empId, openMin, closeMin);
    }
  };

  /* -------------------- Mouse drag (desktop) -------------------- */
  const handleMouseDown = (e, empId) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startMin = getMinFromEvent(e);
    setIsDragging(true);
    setDragEmpId(empId);
    setDragStartMin(startMin);
    setDragCurrentMin(startMin);
    setPreviewTop(pxFromMin(startMin - openMin));
    setPreviewHeight(0);
  };
  const handleMouseMove = (e, empId) => {
    if (!isDragging || dragEmpId !== empId) return;
    const currentMin = getMinFromEvent(e);
    const clientY = getClientY(e);
    const anchorEl = colRefs.current.get(empId) || e.currentTarget;
    autoScrollOnEdge(clientY, anchorEl);

    setDragCurrentMin(currentMin);
    const min1 = Math.min(dragStartMin, currentMin);
    const min2 = Math.max(dragStartMin, currentMin);
    setPreviewTop(pxFromMin(min1 - openMin));
    setPreviewHeight(pxFromMin(min2 - min1));
  };
  const handleMouseUp = (e, empId) => {
    if (!isDragging || dragEmpId !== empId) return;
    const endMin = getMinFromEvent(e);
    const start = Math.min(dragStartMin, endMin);
    const end = Math.max(dragStartMin, endMin);
    if (end - start >= 5) onCreateBlock(empId, start, end);
    setIsDragging(false);
    setDragEmpId(null);
    setDragCurrentMin(null);
  };
  const handleMouseLeave = () => {
    if (isDragging) {
      setIsDragging(false);
      setDragEmpId(null);
      setDragCurrentMin(null);
    }
  };

  /* -------------------- Tap-tap na telefonu -------------------- */
  const commitTapAt = (empId, minute) => {
    if (tapStartMin == null || tapEmpId !== empId) {
      setTapEmpId(empId);
      setTapStartMin(minute);
      setTimeout(() => {
        setTapEmpId((cur) => (cur === empId ? null : cur));
        setTapStartMin((cur) => (cur === minute ? null : cur));
      }, 30000);
      return;
    }
    const s = Math.min(tapStartMin, minute);
    const e = Math.max(tapStartMin, minute);
    if (e - s >= 5) onCreateBlock(empId, s, e);
    setTapEmpId(null);
    setTapStartMin(null);
  };

  /* -------------------- Touch (telefon) -------------------- */
  const handleTouchStart = (e, empId) => {
    const startMin = getMinFromEvent(e);
    armStartYRef.current = getClientY(e);
    armStartMinRef.current = startMin;
    setIsArming(true);
    setDragEmpId(empId);
  };

  const handleTouchMove = (e, empId) => {
    if (e.touches.length !== 1) return;
    const clientY = getClientY(e);
    const dy = clientY - armStartYRef.current;

    if (isArming && Math.abs(dy) < DRAG_THRESHOLD_PX) {
      return;
    }
    if (isArming && Math.abs(dy) >= DRAG_THRESHOLD_PX) {
      setIsArming(false);
      setDragEmpId(null);
      return;
    }
    const anchorEl = colRefs.current.get(empId) || e.currentTarget;
    autoScrollOnEdge(clientY, anchorEl);
  };

  const handleTouchEnd = (e, empId) => {
    if (isArming && dragEmpId === empId) {
      const minute = getMinFromEvent(e);
      commitTapAt(empId, minute);
      setIsArming(false);
      setDragEmpId(null);
      return;
    }
    setIsArming(false);
    setDragEmpId(null);
  };

  return (
    <div style={{ ...gridWrap, paddingLeft: 0 }} className="grid-day">
      {/* GLOBALNA vremenska traka (skrivena) */}
      {!isMobile ? (
        <div
          className="time-axis"
          style={{
            ...timeAxis,
            width: 0,
            minWidth: 0,
            padding: 0,
            border: "none",
            opacity: 0,
            pointerEvents: "none",
            height: gridHeight(closeMin - openMin),
          }}
        />
      ) : null}

      {/* Kolone radnica: JEDAN RED + HORIZONTALNI SKROL (desktop) */}
      <div style={{ ...colsOuter, flex: 1, minWidth: 0, width: "100%" }}>
        {employeeIdsForDay.map((empId) => {
          const emp = employeesById.get(empId);

          // Fallback: ako nema smene → važi radno vreme salona
          let segs = shiftsByEmp.get(empId) || [];
          if (segs.length === 0) {
            segs = [{ start: minToTime(openMin), end: minToTime(closeMin) }];
          }

          const appts = (appointments || []).filter((a) => a.employeeId === empId);
          const gutterW = isMobile ? 36 : 46;

          const isSingle = employeeIdsForDay.length === 1;
        const colStyle = isSingle
  ? { ...colBox(isMobile), flex: "1 1 100%", width: "100%", maxWidth: "100%", direction: "ltr" }
  : { ...colBox(isMobile), direction: "ltr" };


          return (
            <div key={empId} style={colStyle}>
              {isMobile && (
                <div style={mobileHeaderRow}>
                  <button
                    type="button"
                    onClick={() => {
                      const segs = shiftsByEmp.get(empId) || [];
                      blockWholeDay(empId, segs);
                    }}
                    style={blockDayBtn}
                    title="Blokiraj ceo dan"
                  >
                    Blokiraj ceo dan
                  </button>
                </div>
              )}

              {/* Ime radnice */}
              <div style={colHeader}>{emp?.name || "—"}</div>

              <div
                ref={(el) => {
                  if (el) colRefs.current.set(empId, el);
                  else colRefs.current.delete(empId);
                }}
                style={{
                  ...colBody,
                  touchAction: isMobile ? "pan-y" : isDragging ? "none" : "auto",
                  overscrollBehavior: "contain",
                  WebkitUserSelect: "none",
                  userSelect: "none",
                  height: gridHeight(closeMin - openMin),
                  paddingLeft: gutterW,
                  paddingTop: 8,
                  position: "relative",
                }}
                onMouseDown={(e) => handleMouseDown(e, empId)}
                onMouseMove={(e) => handleMouseMove(e, empId)}
                onMouseUp={(e) => handleMouseUp(e, empId)}
                onMouseLeave={handleMouseLeave}
                onTouchStart={(e) => handleTouchStart(e, empId)}
                onTouchMove={(e) => handleTouchMove(e, empId)}
                onTouchEnd={(e) => handleTouchEnd(e, empId)}
                onDragOver={onColDragOver}
                onDrop={onColDrop(empId)}
              >
                {/* LOKALNA vremenska osa u koloni */}
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: gutterW,
                    pointerEvents: "none",
                    zIndex: 3,
                  }}
                >
                  {timeMarks(openMin, closeMin).map((t) => {
                    const y = pxFromMin(t - openMin);
                    const safeTop = Math.max(10, y);
                    return (
                      <div key={t}>
                        <div
                          style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            top: y,
                            height: 1,
                            transform: "translateY(-0.5px)",
                            borderTop: "1px dashed rgba(255,255,255,.25)",
                          }}
                        />
                        <span
                          style={{
                            position: "absolute",
                            left: 6,
                            top: safeTop,
                            transform: "translateY(-50%)",
                            fontSize: 12,
                            fontWeight: 700,
                            lineHeight: 1,
                            padding: "2px 6px",
                            borderRadius: 6,
                            background: "rgba(0,0,0,.35)",
                            color: "rgba(255,255,255,1)",
                            textShadow: "0 1px 2px rgba(0,0,0,.35)",
                            zIndex: 4,
                          }}
                        >
                          {minToTime(t)}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Smena (ili fallback zona) */}
                {segs.map((s, i) => (
                  <div
                    key={i}
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: pxFromMin(timeToMin(s.start) - openMin),
                      height: pxFromMin(timeToMin(s.end) - timeToMin(s.start)),
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,.08))",
                      border: "0.5px dashed rgba(255,255,255,.25)",
                      borderRadius: 10,
                    }}
                    title={`Smena ${s.start}–${s.end}`}
                  />
                ))}

                {/* Termini / blokade */}
                {appts.map((a) => {
                  const isBlock = a.type === "block";
                  const isBreak = a.type === "break";
                  const isVacation = a.type === "vacation";
                  const top = pxFromMin(a.startMin - openMin);
                  const height = pxFromMin(a.endMin - a.startMin);
                  const bg = apptBgFor(a, colorForServiceId);
                  const srvDef = servicesById.get(a.serviceId);
                  const price = Number(a.price ?? srvDef?.price ?? 0);

                  const phone = normPhone(a.clientPhone);
                  const hasNoShowHistory = !!(phone && noShowByPhone.get(phone));
                  const pendingPen = a.clientPhone
                    ? pendingPenaltyByPhone.get(normPhone(a.clientPhone))
                    : null;
                  const hasPendingPenalty = !!pendingPen;
                  const penaltyApplied = a?.penaltyApplied?.amount > 0;

                  const earliestIdForPhone = phone
                    ? earliestApptIdByPhone.get(phone)
                    : null;
                  const showPendingPenaltyHere =
                    !!(hasPendingPenalty && !penaltyApplied && earliestIdForPhone === a.id);
                  const showNoShowHere =
                    !!(hasNoShowHistory && earliestApptIdByPhone.get(phone) === a.id);

                  return (
                    <button
                      key={a.id}
                      id={`appt-${a.id}`}
                      draggable={!isBreak && !isBlock && !isVacation}
                      onDragStart={onApptDragStart(a)}
                      onMouseEnter={() => setHoverApptId(a.id)}
                      onMouseLeave={() => setHoverApptId(null)}
                      onClick={() =>
                        !isBreak && !isBlock && !isVacation && onApptClick(a)
                      }
                      style={apptCard(top, height, bg, isBreak || isBlock || isVacation)}
                      title={
                        isVacation
                          ? "Odmor"
                          : isBreak
                          ? "Pauza"
                          : isBlock
                          ? "Blokirano"
                          : `${a.serviceName || "Usluga"}${
                              price > 0 ? ` • ${price.toLocaleString("sr-RS")} RSD` : ""
                            }${a.clientName ? " · " + a.clientName : ""}`
                      }
                      onDragOver={(e) => e.preventDefault()}
                      onTouchStart={stopTouchPropagation}
                      onTouchEnd={stopTouchPropagation}
                    >
                      <div style={cardTitle(isMobile)}>
                        {isVacation
                          ? "Odmor"
                          : isBreak
                          ? "Pauza"
                          : isBlock
                          ? "Blokirano"
                          : a.serviceName || "Usluga"}
                      </div>

                      {/* Vreme na BLOKADI */}
                      {isBlock && (
                        <div style={metaRow}>
                          <span style={pill}>
                            <FiClock style={{ marginRight: 6 }} />
                            {minToTime(a.startMin)}–{minToTime(a.endMin)}
                          </span>
                        </div>
                      )}

                      {!isBreak && !isBlock && !isVacation && (
                        <div style={metaRow}>
                          <span style={pill}>
                            <FiClock style={{ marginRight: 6 }} />
                            {minToTime(a.startMin)}–{minToTime(a.endMin)}
                          </span>
                          {a.clientName && (
                            <span style={pillLight(isMobile)}>
                              <FiUser style={{ marginRight: 6 }} />
                              {a.clientName}
                            </span>
                          )}
                        </div>
                      )}

                      {isBreak && (
                        <div style={metaRow}>
                          <span style={pill}>
                            <FiClock style={{ marginRight: 6 }} />
                            {minToTime(a.startMin)}–{minToTime(a.endMin)}
                          </span>
                        </div>
                      )}

                      {!isBreak && !isBlock && !isVacation && showNoShowHere && (
                        <div style={badgeNoShow}>
                          <FiAlertTriangle style={{ marginRight: 6 }} />
                          No-show istorija
                        </div>
                      )}
                      {!isBreak && !isBlock && !isVacation && showPendingPenaltyHere && (
                        <div style={badgePenalty}>
                          <FiInfo style={{ marginRight: 6 }} />
                          Kazna za naplatu
                        </div>
                      )}
                      {!isBreak && !isBlock && !isVacation && penaltyApplied && (
                        <div style={badgePenalty}>
                          <FiInfo style={{ marginRight: 6 }} />
                          Kazna primenjena
                        </div>
                      )}

                      {/* × dugme za brisanje BLOKA — span umesto button da ne bude nesting */}
                      {isBlock && (
                        <span
                          role="button"
                          aria-label="Obriši blokadu"
                          tabIndex={0}
                          style={blockDeleteBtn}
                          onTouchStart={stopTouchPropagation}
                          onTouchEnd={(e) => {
                            stopTouchPropagation(e);
                            try {
                              deleteAppt?.(a.id ?? a);
                            } catch {
                              if (a?.id) deleteAppt?.(a.id);
                            }
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            try {
                              deleteAppt?.(a.id ?? a);
                            } catch {
                              if (a?.id) deleteAppt?.(a.id);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              try {
                                deleteAppt?.(a.id ?? a);
                              } catch {
                                if (a?.id) deleteAppt?.(a.id);
                              }
                            }
                          }}
                        >
                          ×
                        </span>
                      )}

                      {hoverApptId === a.id &&
                        !isBreak &&
                        !isBlock &&
                        !isVacation && (
                          <div style={hoverHint}>
                            <FiEdit3 /> Klikni za detalje
                          </div>
                        )}
                    </button>
                  );
                })}

                {/* PREVIEW selekcije (desktop) */}
                {!isMobile && isDragging && dragEmpId === empId && (() => {
                  const m1 = Math.min(dragStartMin, dragCurrentMin ?? dragStartMin);
                  const m2 = Math.max(dragStartMin, dragCurrentMin ?? dragStartMin);
                  const labelTop = Math.max(0, previewTop - 24);
                  const labelText = `${minToTime(m1)}–${minToTime(m2)}`;
                  return (
                    <>
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          top: previewTop,
                          height: previewHeight,
                          background:
                            "repeating-linear-gradient(-45deg,#cfcfcf 0 8px,#bdbdbd 8px 16px)",
                          opacity: 0.7,
                          borderRadius: 10,
                        }}
                      />
                      <div
                        style={{
                          position: "absolute",
                          left: 8,
                          top: labelTop,
                          padding: "2px 8px",
                          borderRadius: 8,
                          fontSize: 12,
                          fontWeight: 700,
                          background: "rgba(0,0,0,.55)",
                          color: "#fff",
                          pointerEvents: "none",
                          zIndex: 6,
                        }}
                      >
                        {labelText}
                      </div>
                    </>
                  );
                })()}

                {/* TAP START linija (mob) */}
                {isMobile && tapEmpId === empId && tapStartMin != null && (
                  <>
                    <div
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        top: pxFromMin(tapStartMin - openMin),
                        height: 2,
                        background: "rgba(255,95,162,.9)",
                        boxShadow: "0 0 0 1px rgba(255,95,162,.6)",
                        transform: "translateY(-1px)",
                        zIndex: 7,
                        pointerEvents: "none",
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        left: 8,
                        top: Math.max(0, pxFromMin(tapStartMin - openMin) - 22),
                        padding: "2px 6px",
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: 700,
                        background: "rgba(0,0,0,.55)",
                        color: "#fff",
                        pointerEvents: "none",
                        zIndex: 7,
                      }}
                    >
                      {minToTime(tapStartMin)}
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------- Schedule grid (bookings of the day) -------------------- */

function ScheduleGrid({
  dateObj,
  appts,
  salonHours,
  employeesById,
  servicesById,
  colorForServiceId,
  onApptClick,
  noShowByPhone,
  pendingPenaltyByPhone, 
  earliestApptIdByPhone,
  isMobile,
}) {
  const dow = DOW[dateObj.getDay()];
  const hours = salonHours[dow] || DEFAULT_SALON_HOURS[dow];
  const openMin = timeToMin(hours.open);
  const closeMin = timeToMin(hours.close);

  // Levu osu prikazujemo SAMO na desktopu
  const showAxisLeft = !isMobile;
  const axisWidth = 72;
  const timeAxisStyle = {
    ...timeAxis,
    width: axisWidth,
    paddingLeft: 8,
    paddingRight: 4,
    fontSize: 12,
    borderRight: "0.5px solid rgba(255,255,255,.25)",
  };

  // "Sada" linija (samo ako je danas)
  const isToday = dateKey(dateObj) === dateKey(new Date());
  const nowMin = isToday ? (new Date().getHours() * 60 + new Date().getMinutes()) : null;

  const laid = useMemo(() => {
    const items = (appts || []).map((a) => ({ ...a }));
    items.sort((a, b) => (a.startMin || 0) - (b.startMin || 0));
    const res = [];
    let cluster = [];
    let clusterEnd = -1;

    const flush = () => {
      if (!cluster.length) return;
      const lanesEnd = [];
      const laneOf = new Map();
      for (const ev of cluster) {
        let idx = 0;
        while (idx < lanesEnd.length && ev.startMin < lanesEnd[idx]) idx++;
        lanesEnd[idx] = ev.endMin;
        laneOf.set(ev.id, idx);
      }
      const cols = lanesEnd.length || 1;
      for (const ev of cluster) {
        res.push({ ...ev, lane: laneOf.get(ev.id) || 0, cols });
      }
      cluster = [];
      clusterEnd = -1;
    };

    for (const ev of items) {
      if (cluster.length === 0 || ev.startMin < clusterEnd) {
        cluster.push(ev);
        clusterEnd = Math.max(clusterEnd, ev.endMin);
      } else {
        flush();
        cluster.push(ev);
        clusterEnd = ev.endMin;
      }
    }
    flush();
    return res;
  }, [appts]);

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ color: "#fff", fontWeight: 900, marginBottom: 8 }}>
        Raspored za {dateKey(dateObj)} • {hours.open}–{hours.close}
      </div>

      <div style={gridWrap} className="grid-schedule">
        {/* Leva vremenska osa samo na DESKTOPU */}
        {showAxisLeft && (
          <div style={{ ...timeAxisStyle, height: gridHeight(closeMin - openMin) }}>
            {timeMarks(openMin, closeMin).map((t) => (
              <div key={t} style={markRow}>
                <span style={markLbl}>{minToTime(t)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Kolona sa terminima (na MOBILNOM sadrži sve linije/sate unutra) */}
        <div
          style={{
            ...colBody,
            height: gridHeight(closeMin - openMin),
            position: "relative",
            background: "rgba(255,255,255,.12)",
            borderRadius: 16,
            border: "0.5px solid rgba(255,255,255,.25)",
          }}
        >
          {/* Unutrašnje “hour lines” — uvek crtamo unutar kolone (na tel. ovo je jedina osa) */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
            }}
          >
            {timeMarks(openMin, closeMin).map((t) => (
              <div
                key={t}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: pxFromMin(t - openMin),
                  height: 1,
                  background: "rgba(255,255,255,.12)",
                }}
              />
            ))}

            {/* “Sada” linija samo unutar kolone */}
            {isToday && nowMin >= openMin && nowMin <= closeMin && (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: pxFromMin(nowMin - openMin),
                  height: 2,
                  background: "rgba(255,105,180,.95)",
                  boxShadow: "0 0 0 1px rgba(255,105,180,.35)",
                }}
              />
            )}
          </div>

          {laid.map((a) => {
            const top = pxFromMin(a.startMin - openMin);
            const height = pxFromMin(a.endMin - a.startMin);
            const widthPct = 100 / (a.cols || 1);
            const leftPct = (a.lane || 0) * widthPct;

            const empName = employeesById.get(a.employeeId)?.name || "—";
            const srv =
              servicesById.get(a.serviceId)?.name ||
              a.serviceName ||
              "Usluga";
              const srvDef = servicesById.get(a.serviceId);            // NOVO
const price = Number(a.price ?? srvDef?.price ?? 0);     // NOVO

            const phone = normPhone(a.clientPhone);
            const hasNoShowHistory = !!(phone && noShowByPhone.get(phone));
            const pendingPen = a.clientPhone ? pendingPenaltyByPhone.get(normPhone(a.clientPhone)) : null;
            const hasPendingPenalty = !!pendingPen;
            const penaltyApplied = a?.penaltyApplied?.amount > 0;

            const earliestIdForPhone = phone ? earliestApptIdByPhone.get(phone) : null;
            const showPendingPenaltyHere = hasPendingPenalty && !penaltyApplied && earliestIdForPhone === a.id;
            const showNoShowHere = !!(hasNoShowHistory && earliestIdForPhone === a.id);

            return (
              <button
                key={a.id}
                onClick={() => onApptClick(a)}
                style={{
                  ...apptCard(top, height, apptBgFor(a, colorForServiceId)),
                  left: `calc(${leftPct}% + 6px)`,
                  width: `calc(${widthPct}% - 12px)`,
                }}
               title={`${srv} • ${minToTime(a.startMin)}–${minToTime(a.endMin)} • ${empName}${ price > 0 ? ` • ${price.toLocaleString("sr-RS")} RSD` : ""
}`}

              >
                <div style={cardTitle(isMobile)}>{srv}</div>

            <div style={metaRow}>
  <span style={pill}>
    <FiClock style={{ marginRight: 6 }} />
    {minToTime(a.startMin)}–{minToTime(a.endMin)}
  </span>

  {/* NOVO: cena usluge na kartici */}
  {price > 0 && (
    <span style={pillLight(isMobile)}>
      {price.toLocaleString("sr-RS")} RSD
    </span>
  )}

  <span style={pillLight(isMobile)}>
    <FiUser style={{ marginRight: 6 }} />
    {empName}
  </span>

  {a.clientName && (
    <span style={pillLight(isMobile)}>{a.clientName}</span>
  )}
</div>


                {showNoShowHere && (
                  <div style={badgeNoShow}>
                    <FiAlertTriangle style={{ marginRight: 6 }} />
                    No-show istorija
                  </div>
                )}
                {showPendingPenaltyHere && (
                  <div style={badgePenalty}>
                    <FiInfo style={{ marginRight: 6 }} />
                    Kazna za naplatu
                  </div>
                )}
                {penaltyApplied && (
                  <div style={badgePenalty}>
                    <FiInfo style={{ marginRight: 6 }} />
                    Kazna primenjena
                  </div>
                )}
              </button>
            );
          })}

          {!laid.length && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                color: "#fff",
                opacity: 0.8,
              }}
            >
              Nema termina za izabrani dan.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}



/* -------------------- Month Roster (WINDOW: 7 dana desktop / 1 dan mobilni) -------------------- */

function MonthRosterWindow({ monthStr, shifts, breaks, employeesById, isMobile }) {
  async function removeShiftFor(dayKey, empId) {
    try {
      const name = employeesById.get(empId)?.name || "radnica";
      const ok = confirm(`Ukloniti smenu za ${name} na datum ${dayKey}?`);
      if (!ok) return;

      const id = `${empId}_${dayKey}`;
      await deleteDoc(doc(db, "shifts", id));
    } catch (e) {
      console.error(e);
      alert("Nije uspelo uklanjanje smene.");
    }
  }

  const base = new Date(monthStr + "-01T00:00:00");
  const totalDays = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();

  const byDay = new Map();
  for (const s of shifts) {
    if (!byDay.has(s.dateKey)) byDay.set(s.dateKey, new Set());
    byDay.get(s.dateKey).add(s.employeeId);
  }
  const timeOffMap = new Map();
  for (const b of breaks) {
    const k = `${b.dateKey}|${b.employeeId}`;
    if (!timeOffMap.has(k)) timeOffMap.set(k, []);
    timeOffMap.get(k).push(b);
  }

  const chunk = isMobile ? 1 : 7;

  const today = new Date();
  const todayInThisMonth =
    today.getFullYear() === base.getFullYear() && today.getMonth() === base.getMonth()
      ? today.getDate()
      : 1;

  const [page, setPage] = useState(Math.floor((todayInThisMonth - 1) / chunk));

  const start = page * chunk + 1;
  const end = Math.min(start + chunk - 1, totalDays);

  const prevDisabled = page === 0;
  const nextDisabled = end >= totalDays;

  return (
    <div style={{ marginTop: 12 }}>
      {/* Navigacija */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <button onClick={() => !prevDisabled && setPage(page - 1)} disabled={prevDisabled} style={navBtn(prevDisabled)}>◀</button>
        <div style={{ color: "#fff", fontWeight: 900 }}>
          {isMobile
            ? `${DOW_SR[new Date(`${base.getFullYear()}-${pad2(base.getMonth()+1)}-${pad2(start)}`+"T00:00:00").getDay()]} ${pad2(start)}.${pad2(base.getMonth()+1)}.${base.getFullYear()}.`
            : `Dani ${start}–${end} • ${pad2(base.getMonth()+1)}.${base.getFullYear()}.`}
        </div>
        <button onClick={() => !nextDisabled && setPage(page + 1)} disabled={nextDisabled} style={navBtn(nextDisabled)}>▶</button>
      </div>

      {/* 7 kolona (desktop) / 1 kolona (mob) */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${end - start + 1}, minmax(140px, 1fr))`, gap: 10 }}>
        {Array.from({ length: end - start + 1 }, (_, i) => start + i).map((d) => {
          const dayKey = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(d)}`;
          const empIds = Array.from(byDay.get(dayKey) || []);
          const entries = empIds.map((id) => {
            const name = employeesById.get(id)?.name || "—";
            const offs = timeOffMap.get(`${dayKey}|${id}`) || [];
            const firstBreak = offs.find((x) => x.type === "break");
            const hasVacation = offs.some((x) => x.type === "vacation");
            return {
              id,
              name,
              firstTime: firstBreak?.startHHMM,
              hasVacation,
              more: Math.max(0, offs.length - (firstBreak ? 1 : 0) - (hasVacation ? 1 : 0)),
            };
          });

          return (
            <div key={dayKey} style={calCellWindow}>
              {/* header dana */}
              <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                <span style={{ opacity: 0.9, fontWeight: 900 }}>
                  {DOW_SR[new Date(dayKey + "T00:00:00").getDay()]}
                </span>
                <span style={{ opacity: 0.95, fontWeight: 900 }}>{d}</span>
              </div>

              {/* lista radnica + oznake odmora/pauze */}
              <div style={{ marginTop: 6, display: "grid", gap: 6, width: "100%" }}>
                {entries.length === 0 && (
                  <span style={{ fontSize: 12, opacity: 0.7 }}>Nema smena</span>
                )}
                {entries.slice(0, 12).map((n) => (
                  <span
                    key={n.id}
                    style={empPillStyle(n.hasVacation)}
                    title={n.hasVacation ? "Odmor – klik za uklanjanje smene" : "Klikni da ukloniš smenu"}
                    onClick={() => removeShiftFor(dayKey, n.id)}
                  >
                    {n.name}
                    {n.firstTime ? `  ${n.firstTime}${n.more ? " +" + n.more : ""}` : ""}
                  </span>
                ))}

                {entries.length > 12 && (
                  <span style={{ fontSize: 12, opacity: 0.8 }}>+ još</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* sitni stilovi za navigaciju i ćelije prozora */
const navBtn = (disabled) => ({
  height: 36,
  minWidth: 36,
  borderRadius: 10,
  border: "0.5px solid rgba(255,255,255,.35)",
  background: disabled ? "rgba(255,255,255,.12)" : "linear-gradient(135deg,#ffffff,#ffe3ef)",
  color: disabled ? "rgba(255,255,255,.5)" : "#000",
  fontWeight: 900,
  cursor: disabled ? "default" : "pointer",
});

const calCellWindow = {
  background: "rgba(255,255,255,.12)",
  border: "0.5px solid rgba(255,255,255,.25)",
  borderRadius: 16,
  padding: 10,
  minHeight: 120,
};

/* -------------------- Appointment Modal -------------------- */
function ApptModal({
  appt,
  onClose,
  employees,
  employeesById,
  servicesById,
  salonHours,
  shiftsByEmp,
  pendingPenaltyByPhone,
  earliestApptIdByPhone,
  colorForServiceId,
  onSave,
  onNoShow,
  onCancel,
  onDelete,
  noShowByPhone,
}) {
  const [empId, setEmpId] = useState(appt.employeeId);
  const [start, setStart] = useState(appt.startHHMM);

  // --- cena (editable u modalu)
  const [editPrice, setEditPrice] = useState(appt?.price ?? 0);
  useEffect(() => {
    setEditPrice(appt?.price ?? 0);
  }, [appt]);

  const phoneN = normPhone(appt.clientPhone);
  const hasNoShowHistory = !!(phoneN && noShowByPhone.get(phoneN));

  const srv = servicesById.get(appt.serviceId);
  const duration = appt.durationMin || srv?.durationMin || 0;

  // --- prvi sledeći termin za ovaj telefon
  const earliestId = phoneN ? earliestApptIdByPhone.get(phoneN) : null;
  const isEarliestForPhone = !!(earliestId && earliestId === appt.id);

  // --- stanje kazne za ovaj termin
  const pendingPen = phoneN ? pendingPenaltyByPhone.get(phoneN) : null;
  const penaltyApplied = !!(appt?.penaltyApplied && appt.penaltyApplied.amount > 0);

  // --- bedževi: prikaz SAMO ako je ovo prvi sledeći termin
  const showNoShowHere = !!(hasNoShowHistory && isEarliestForPhone && !penaltyApplied);
  const showPenaltyHere = !!(pendingPen && isEarliestForPhone && !penaltyApplied);
  const showPenaltyAppliedHere = !!(penaltyApplied && isEarliestForPhone);

  // --- radno vreme za datum termina
  const dow = DOW[new Date(appt.dateKey + "T00:00:00").getDay()];
  const hours = (salonHours && salonHours[dow]) || DEFAULT_SALON_HOURS[dow];

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={colorDot(appt.color || colorForServiceId(appt.serviceId))} />
            <div style={{ fontWeight: 900 }}>
              {appt.serviceName || servicesById.get(appt.serviceId)?.name || "Usluga"}
            </div>
          </div>
          <button style={modalClose} onClick={onClose} title="Zatvori">
            <FiX />
          </button>
        </div>

        <div style={modalBody}>
          <div style={field}>
            <label style={fieldLbl}>Radnica</label>
            <select value={empId} onChange={(e) => setEmpId(e.target.value)} style={inp}>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>

          <div style={field}>
            <label style={fieldLbl}>Početak</label>
            <input
              type="time"
              step="300"
              lang="sr-RS"
              value={start}
              min={hours.open}
              max={hours.close}
              onChange={(e) => setStart(e.target.value)}
              style={inp}
            />
            <div style={{ color: "#555", opacity: 0.9, fontSize: 12 }}>
              Trajanje: <b>{duration} min</b>
            </div>
          </div>

          <div style={fieldRow}>
            <div style={{ ...badge, background: "#eef6ff", color: "#0b3d7a" }}>
              <FiCalendar /> {appt.dateKey}
            </div>
            <div style={{ ...badge, background: "#fff3e0", color: "#7a3d0b" }}>
              <FiClock /> {start} → {minToTime(timeToMin(start) + duration)}
            </div>
            <div style={{ ...badge, background: "#e8fff0", color: "#0b7a3d" }}>
              Cena: <b>{Number(editPrice).toLocaleString("sr-RS")} RSD</b>
            </div>

            {showNoShowHere && (
              <div style={{ ...badge, background: "#ffe8ea", color: "#7a1b1b" }}>
                <FiAlertTriangle /> No-show istorija
              </div>
            )}
          </div>

          {showPenaltyHere && (
            <div style={{ ...badge, background: "#fff7e6", color: "#7a3d0b" }}>
              <FiInfo /> Kazna za naplatu: <b>{pendingPen.amount} RSD</b>
            </div>
          )}

          {showPenaltyAppliedHere && (
            <div style={{ ...badge, background: "#e8fff0", color: "#0b7a3d" }}>
              <FiInfo /> Kazna primenjena: <b>{appt.penaltyApplied.amount} RSD</b>
            </div>
          )}

          {(appt.clientName || appt.clientPhone) && (
            <div style={infoBox}>
              <FiInfo style={{ marginRight: 8 }} />
              <div>
                {appt.clientName ? <b>{appt.clientName}</b> : null}
                {appt.clientPhone ? ` • ${appt.clientPhone}` : null}
              </div>
            </div>
          )}
        </div>

        {/* --- Dugmići i cena --- */}
        <div style={modalActions}>
          {/* Levo: Obriši */}
          <button
            style={{ ...actionBtn, background: "#ffe1e1", color: "#7a1b1b" }}
            onClick={onDelete}
            title="Obriši termin"
          >
            <FiTrash2 /> Obriši
          </button>

          {/* Sredina: Cena */}
          <div style={{ flex: 1, margin: "0 12px" }}>
            <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
              Cena
            </label>
            <input
              type="number"
              value={editPrice}
              onChange={(e) => setEditPrice(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid #ccc",
              }}
            />
          </div>

          {/* Desno: Otkaži / No-show / Sačuvaj */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ ...actionBtn, background: "#fff", color: "#222" }}
              onClick={onCancel}
              title="Otkaži"
            >
              <FiSlash /> Otkaži
            </button>
            <button
              style={{ ...actionBtn, background: "#fff7e6", color: "#7a3d0b" }}
              onClick={onNoShow}
              title="No-show"
            >
              <FiAlertTriangle /> No-show
            </button>
            <button
              style={{
                ...actionBtn,
                background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
                color: "#fff",
              }}
              onClick={() =>
                onSave({
                  employeeId: empId,
                  startHHMM: start,
                  price: Number(editPrice) || 0,
                })
              }
              title="Sačuvaj izmene"
            >
              <FiSave /> Sačuvaj
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------- UI helpers & styles -------------------- */
/* kartica termina – zajednički stil za DayGrid i ScheduleGrid */
/* kartica termina – zajednički stil za DayGrid i ScheduleGrid */
const apptCard = (top, height, bg, disabled = false) => ({
  position: "absolute",
  left: 6,
  right: 6,
  top,
  height,
  background: bg,
  borderRadius: 10,
  boxShadow: "0 10px 22px rgba(0,0,0,.18), inset 0 0 0 2px rgba(255,255,255,.35)",
  color: "#222",
  padding: 8,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  cursor: disabled ? "default" : "pointer",
  /* ključne promene: */
  overflowX: "hidden",
  overflowY: "auto",
  WebkitOverflowScrolling: "touch",
  whiteSpace: "normal",
  wordBreak: "break-word",
  overflowWrap: "anywhere",
  lineHeight: 1.3,
});
// --- desktop layout za kolone (jedan red + horizontalni skrol) ---
const COL_W  = (isMobile) => (isMobile ? "100%" : 220);
const COL_GAP = (isMobile) => (isMobile ? 8 : 8);








/* naslov na kartici – funkcija da možemo proslediti isMobile */
/* naslov na kartici – bez sečenja, uvek ceo tekst */
const cardTitle = (isMobile) => ({
  fontWeight: 800,
  fontSize: isMobile ? 14 : 12,
  lineHeight: 1,
  marginBottom: 4,
  textAlign: "left",
  // bez WebkitLineClamp – prikazuj ceo naslov
});


const metaRow = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  marginTop: 2,
  flexWrap: "wrap",
};

const normPhone = (p) =>
  String(p || "")
    .replace(/[^\d+]/g, "")
    .replace(/^00/, "+")
    .replace(/^0(6\d+)/, "+381$1") // ← ključno
    .trim();


const pxFromMin = (min) => min * 3.5;
const gridHeight = (m) => pxFromMin(m);
const timeMarks = (open, close) => {
  const arr = [];
  for (let m = open; m <= close; m += 60) arr.push(m);
  return arr;
};

const wrap = {
  minHeight: "100vh",
  background: "url('/slika1.webp') center/cover fixed no-repeat",
  padding: 18,
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-start",
};
const panel = {
  width: "min(1400px, 100%)",
  background: "rgba(255,255,255,.12)",
  border: "0.5px solid rgba(255,255,255,.35)",
  backdropFilter: "blur(10px)",
  borderRadius: 28,
  boxShadow: "0 24px 60px rgba(0,0,0,.25)",
  padding: "clamp(16px,3vw,24px)",
};

const tabbar = { display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" };
const tabBtn = {
  border: "0.5px solid rgba(255,255,255,.55)",
  borderRadius: 12,
  background: "transparent",
  color: "#fff",
  fontWeight: 700,
  padding: "10px 14px",
  cursor: "pointer",
};
const tabBtnActive = {
  ...tabBtn,
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  border: "none",
};

const ctlWrap = {
  background: "rgba(0,0,0,.35)",
  borderRadius: 16,
  padding: 12,
  marginBottom: 12,
  border: "0.5px solid rgba(255,255,255,.2)",
};
const ctlRowA = {
  display: "grid",
  gridTemplateColumns: "repeat(6, minmax(160px, 1fr))",
  gap: 10,
  marginBottom: 10,
};
const ctlRowB = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};
const ctlItem = { display: "flex", flexDirection: "column", gap: 6 };
const lbl = { color: "#fff", fontWeight: 800, fontSize: 12, opacity: 0.95 };
const inp = {
  height: 40,
  borderRadius: 10,
  border: "0.5px solid #e8e8e8",
  background: "#fff",
  padding: "0 12px",
  fontSize: 14,
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  color: "#000",
};
const primaryBtn = {
  height: 40,
  borderRadius: 10,
  border: "none",
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  color: "#fff",
  fontWeight: 900,
  padding: "0 16px",
  cursor: "pointer",
  boxShadow: "0 8px 20px rgba(255,127,181,.28)",
};

const segWrap = {
  display: "grid",
  gridTemplateColumns: "repeat(2, 1fr)",
  gap: 6,
  background: "rgba(255,255,255,.18)",
  padding: 4,
  borderRadius: 999,
  border: "0.5px solid rgba(255,255,255,.35)",
};
const segBtn = (active) => ({
  height: 32,
  borderRadius: 999,
  border: "none",
  background: active
    ? "linear-gradient(135deg,#ffffff,#ffe3ef)"
    : "transparent",
  color: active ? "#000" : "#fff",
  fontWeight: 900,
  padding: "0 12px",
  cursor: "pointer",
  boxShadow: active ? "0 6px 16px rgba(255,127,181,.25)" : "none",
});

/* --- DayStrip (mesec) --- */
const stripWrap = {
  display: "grid",
  gridAutoFlow: "column",
  gridAutoColumns: "minmax(64px, 1fr)",
  gap: 8,
  overflowX: "auto",
  padding: "4px",
  scrollbarWidth: "none",
};
const stripBtn = (selected, compact) => ({
  display: "grid",
  placeItems: "center",
  gap: 2,
  minWidth: compact ? 64 : 72,
  padding: compact ? "6px 6px" : "8px 8px",
  borderRadius: 12,
  border: selected ? "1px solid #ffcfde" : "1px solid rgba(255,255,255,.35)",
  background: selected
    ? "linear-gradient(135deg,#ffffff,#ffe3ef)"
    : "rgba(255,255,255,.12)",
  color: "#000",
  cursor: "pointer",
  boxShadow: selected ? "0 6px 16px rgba(255,127,181,.25)" : "none",
});

/* --- Grid (dnevni i raspored) --- */
const gridWrap = {
  display: "grid",
  gridTemplateColumns: "80px 1fr",
  gap: 10,
  alignItems: "stretch",
};

const timeAxis = {
  background: "rgba(255,255,255,.12)",
  border: "0.5px solid rgba(255,255,255,.25)",
  borderRadius: 16,
  overflow: "hidden",
};
const markRow = {
  height: pxFromMin(60),
  borderTop: "1px dashed rgba(255,255,255,.25)",
  position: "relative",
  display: "flex",
  alignItems: "flex-start",
};
const markLbl = {
  fontSize: 12,
  color: "#fff",
  opacity: 0.85,
  padding: "2px 8px",
};

// sve kolone u jednom redu + horizontalni skrol (desktop)
const colsOuter = {
  display: "flex",
  flexDirection: "row",
  flexWrap: "nowrap",
  overflowX: "auto",
  overflowY: "hidden",
  gap: 8,
  paddingTop: 8,          // umesto paddingBottom
  WebkitOverflowScrolling: "touch",
  scrollbarWidth: "thin",
  direction: "rtl",       // ⬅️ pomera scrollbar gore
};



const colBox = (isMobile) => ({
  background: "rgba(255,255,255,.12)",
  border: "0.5px solid rgba(255,255,255,.25)",
  borderRadius: 16,
  overflow: "hidden",
  display: "grid",
  gridTemplateRows: "40px 1fr",
  flex: `0 0 ${COL_W(isMobile)}`,
  width: COL_W(isMobile),
  minWidth: COL_W(isMobile),
  maxWidth: COL_W(isMobile),
});



const colHeader = {
  height: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 900,
  color: "#fff",
  background: "rgba(0,0,0,.25)",
  borderBottom: "1px solid rgba(255,255,255,.2)",
  fontSize: "var(--head-fz, 16px)",
};

const colBody = {
  position: "relative",
  background: "rgba(255,255,255,.10)",
  borderRadius: 14,
  margin: 8,
  overflow: "hidden",
};

const badgeNoShow = {
  alignSelf: "flex-start",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 8px",
  borderRadius: 999,
  background: "#ffe8ea",
  color: "#7a1b1b",
  fontSize: 11,
  fontWeight: 700,
};
const badgePenalty = {
  alignSelf: "flex-start",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 8px",
  borderRadius: 999,
  background: "#fff7e6",   // blago narandžasto
  color: "#7a3d0b",
  fontSize: 11,
  fontWeight: 700,
};


const hoverHint = {
  position: "absolute",
  right: 8,
  bottom: 8,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  borderRadius: 8,
  background: "rgba(255,255,255,.9)",
  color: "#000",
  fontSize: 11,
  boxShadow: "0 2px 10px rgba(0,0,0,.18)",
};

/* --- Month/Roster --- */
const monthWrap = {
  background: "rgba(0,0,0,.35)",
  borderRadius: 16,
  padding: 12,
  border: "0.5px solid rgba(255,255,255,.2)",
};

const row = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(160px, 1fr))",
  gap: 10,
  marginBottom: 10,
};
const btnRow = { gridColumn: "1 / -1", display: "flex", gap: 8, flexWrap: "wrap" };

const dayChip = (active) => ({
  display: "inline-block",
  padding: "6px 10px",
  borderRadius: 999,
  border: active ? "2px solid #ffb6d0" : "1px solid rgba(255,255,255,.35)",
  background: active
    ? "linear-gradient(135deg,#ffffff,#ffe3ef)"
    : "rgba(255,255,255,.12)",
  color: "#000",
  fontWeight: 900,
  cursor: "pointer",
});

const empPill = {
  display: "inline-block",
  width: "100%",
  background: "#fff",
  color: "#000",
  borderRadius: 999,
  padding: "4px 10px",
  fontSize: 12,
  fontWeight: 800,
  boxShadow: "0 4px 10px rgba(0,0,0,.08)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const empPillStyle = (isVacation) => ({
  ...empPill,
  cursor: "pointer",
  ...(isVacation
    ? {
        background: "linear-gradient(135deg,#ffe1e8,#ffd3df)",
        color: "#7a1b1b",
        border: "0.5px solid #ffc2d1",
        boxShadow: "0 6px 16px rgba(255,127,181,.25)",
        fontWeight: 900,
      }
    : {}),
});

const pillBase = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  borderRadius: 999,
  fontSize: 12.5,
  fontWeight: 800,
  lineHeight: 1,
};

const pill = {
  ...pillBase,
  background: "rgba(0,0,0,.06)",
  color: "#111",
  boxShadow: "inset 0 0 0 1px rgba(0,0,0,.06)",
};

/* jedina verzija pillLight – funkcija */
const pillLight = (isMobile) => ({
  ...pillBase,
  background: "rgba(0,0,0,.045)",
  color: "#222",
  boxShadow: "inset 0 0 0 1px rgba(0,0,0,.05)",
  fontSize: isMobile ? 12 : 14,
  lineHeight: 1.3,
});

/* --- Modal --- */
const modalBackdrop = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,.5)",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 2147483647,
};
const modalCard = {
  width: "min(560px, 96vw)",
  background: "rgba(255,255,255,.98)",
  borderRadius: 18,
  boxShadow: "0 20px 60px rgba(0,0,0,.35)",
  overflow: "hidden",
  color: "#000",
};
const modalHeader = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "12px 14px",
  background: "linear-gradient(135deg,#ffffff,#ffe3ef)",
  borderBottom: "1px solid #ffd5e3",
};
const colorDot = (bg) => ({
  width: 14,
  height: 14,
  borderRadius: 999,
  background: bg || "#ff7fb5",
  boxShadow: "0 0 0 3px rgba(0,0,0,.08)",
});
const modalClose = {
  border: "none",
  background: "#fff",
  color: "#000",
  borderRadius: 10,
  height: 32,
  width: 32,
  cursor: "pointer",
  display: "grid",
  placeItems: "center",
  boxShadow: "0 4px 10px rgba(0,0,0,.12)",
};
const modalBody = { padding: 14 };
const field = { display: "grid", gap: 6, marginBottom: 10 };
const fieldLbl = { fontSize: 12, fontWeight: 900, color: "#333" };
const fieldRow = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
};
const badge = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
};
const infoBox = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: 10,
  background: "#f7f7f7",
  borderRadius: 12,
  color: "#222",
  border: "0.5px solid #eee",
};
const modalActions = {
  display: "flex",
  gap: 8,
  padding: 12,
  background: "#fafafa",
  borderTop: "1px solid #eee",
};
const actionBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  border: "none",
  borderRadius: 10,
  cursor: "pointer",
  fontWeight: 900,
};

//* --- Responsive fine-tuning --- *//
const responsiveCSS = `

@media (max-width: 768px) {
  .grid-day { grid-template-columns: "40px 1fr" !important; }
  .markLbl { font-size: 10px; padding: 0 4px; }
}

@media (max-width: 768px) {
  .emp-strip-mobile{
    display:flex;
    flex-wrap:nowrap;
    overflow-x:auto;
    gap:8px;
    padding:6px 0;
    scrollbar-width:none;
  }
  .emp-strip-mobile::-webkit-scrollbar{ display:none; }
  .emp-strip-mobile button{ flex:0 0 auto; }
}

/* --- MOBILE TUNE-UP --- */
@media (max-width: 640px) {
  input[type="date"],
  input[type="month"],
  input[type="time"],
  select {
    font-size: 16px;
    padding: 8px 10px;
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    color: #000;
  }
}

.admincal :is(input, select, button) {
  font-size: 16px !important; /* iOS zoom fix */
}

@media (max-width: 1100px) {
  .grid-day, .grid-schedule { gap: 8px !important; }
  .daystrip .strip-btn { min-width: 64px !important; }
}

/* TABLETI */
@media (max-width: 900px) {
  .ctl .ctl-row-a {
    display: grid !important;
    grid-template-columns: repeat(3, minmax(0,1fr)) !important;
    gap: 8px !important;
  }
  .month-wrap .month-row {
    display: grid !important;
    grid-template-columns: repeat(3, minmax(0,1fr)) !important;
    gap: 8px !important;
  }
}

/* TELEFONI ≤640px */
@media (max-width: 640px) {
  .grid-day, .grid-schedule {
    grid-template-columns: 1fr !important;
    gap: 8px !important;
  }

  .ctl .ctl-row-a { grid-template-columns: repeat(2, minmax(0,1fr)) !important; }
  .ctl .ctl-row-b { gap: 6px !important; }
  .month-wrap .month-row { grid-template-columns: repeat(2, minmax(0,1fr)) !important; }

  .daystrip button { min-width: 64px !important; padding: 6px 6px !important; border-radius: 10px !important; }

  .admincal input, .admincal select { width: 100% !important; }
  .admincal button { min-height: 42px !important; }

  .admincal .grid-day > div:last-child > div,
  .admincal .grid-schedule > div:last-child { margin: 6px !important; }

  .admincal { --head-fz: 14px; }
}

/* TELEFONI ≤768px – sakrij levu vremensku osu i prikaži traku radnica */
@media (max-width: 768px) {
  .emp-strip-mobile {
    display: flex;
    overflow-x: auto;
    gap: 6px;
    padding: 6px 0;
    scrollbar-width: none;
  }
  .emp-strip-mobile::-webkit-scrollbar { display: none; }
}


  /* VEOMA MALI TELEFONI */
@media (max-width: 420px) {
  .ctl .ctl-row-a { grid-template-columns: 1fr !important; }

  .month-wrap .month-row { grid-template-columns: 1fr !important; }

  .daystrip button {
    min-width: 52px !important;
    padding: 5px 5px !important;
  }

  .grid-day span, .grid-schedule span {
    font-size: 12px !important;
  }
}

/* --- Scrollbar za kartice termina --- */
/* Default skriven */
.grid-day button::-webkit-scrollbar,
.grid-schedule button::-webkit-scrollbar { 
  width: 0; 
  background: transparent;
}
/* Hover – pojavi se */
.grid-day button:hover::-webkit-scrollbar,
.grid-schedule button:hover::-webkit-scrollbar {
  width: 6px;
}
.grid-day button:hover::-webkit-scrollbar-thumb,
.grid-schedule button:hover::-webkit-scrollbar-thumb {
  background: rgba(0,0,0,.2);
  border-radius: 6px;
}
/* Firefox: none → thin na hover */
.grid-day button, .grid-schedule button { scrollbar-width: none; }
.grid-day button:hover, .grid-schedule button:hover {
  scrollbar-width: thin;
  scrollbar-color: rgba(0,0,0,.2) transparent;
}




`;