// src/pages/AdminCalendar.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { db } from "../firebase";
import { useNavigate } from "react-router-dom";
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
// Normalize telefona u E.164 (fokus na SRB), robustno za razne unose
const normPhone = (v) => {
  if (v == null) return "";
  let s = String(v).trim();

  // zadrži samo cifre i plus
  s = s.replace(/[^\d+]/g, "");

  // 00xx -> +xx
  if (s.startsWith("00")) s = "+" + s.slice(2);

  // Ako je lokalni oblik koji krene sa 0 (npr. 060..., 061..., 065...)
  // pretvori u +381 bez vodeće nule
  if (/^0\d{6,}$/.test(s)) s = "+381" + s.slice(1);

  // Ako nema plus, dodaj (fallback)
  if (!s.startsWith("+")) s = "+" + s;

  return s;
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

export default function AdminCalendar() {
  const nav = useNavigate();
  const [tab, setTab] = useState("day"); // 'day' | 'month' | 'schedule'

  // meta
  const [salonHours, setSalonHours] = useState(DEFAULT_SALON_HOURS);

  // collections
  const [employees, setEmployees] = useState([]);
  const [services, setServices] = useState([]);
  // DESKTOP multi-select
  const [selectedEmpIds, setSelectedEmpIds] = useState([]);
  const toggleEmp = (id) =>
    setSelectedEmpIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  // ako lista radnica stigne/menja se, očisti nevažeće ID-jeve iz selekcije
  useEffect(() => {
    const valid = new Set(employees.map((e) => e.id));
    setSelectedEmpIds((prev) => prev.filter((id) => valid.has(id)));
  }, [employees]);
  const manyEmployees = employees.length > 10;

  // day view
  const [dayDate, setDayDate] = useState(() => new Date());
  const [onlyWorking, setOnlyWorking] = useState(true);
  const [appointments, setAppointments] = useState([]);
  const [dayShifts, setDayShifts] = useState([]);

  // create (day): 'booking' | 'block'
  const [mode, setMode] = useState("booking");
  const [selEmpId, setSelEmpId] = useState(null);
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
  const [activeAppt, setActiveAppt] = useState(null); // opens modal
  // clients with pending penalty (by phone)
  const [pendingPenaltyByPhone, setPendingPenaltyByPhone] = useState(new Map());

  // Map telefona -> ID najranijeg budućeg termina (status 'booked')
  const [firstUpcomingApptIdByPhone, setFirstUpcomingApptIdByPhone] = useState(new Map());

  // --- mobile detect (≤640px) ---
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const handler = (e) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    try {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    } catch {
      // Safari fallback
      mq.addListener(handler);
      return () => mq.removeListener(handler);
    }
  }, []);

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
      (s) => setEmployees(s.docs.map((d) => ({ id: d.id, ...d.data() })))
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
      offClientsPenalty();
    };
  }, []);

  useEffect(() => setVacStart(`${monthAnchor}-01`), [monthAnchor]);

  // daily listeners (day tab)
  useEffect(() => {
    const dk = dateKey(dayDate);
    const qShifts = query(collection(db, "shifts"), where("dateKey", "==", dk));
    const qAppts = query(
      collection(db, "appointments"),
      where("dateKey", "==", dk)
    );
    const offA = onSnapshot(qAppts, (s) => {
      const all = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      // Prikaži sve koji NISU booking ili su booking ali aktivni (status === "booked")
      const visible = all.filter((a) => a.type !== "booking" || a.status === "booked");
      setAppointments(visible);
    });

    const offS = onSnapshot(qShifts, (s) =>
      setDayShifts(s.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    return () => {
      offA();
      offS();
    };
  }, [dayDate]);

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
        s.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.startMin || 0) - (b.startMin || 0))
      )
    );
    return () => off();
  }, [schedDate]);

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
    const catIds = Array.from(new Set(services.map((s) => s.categoryId).filter(Boolean)));
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
  const workingTodayIds = useMemo(() => {
    const ids = new Set(dayShifts.map((s) => s.employeeId));
    return employees.filter((e) => ids.has(e.id)).map((e) => e.id);
  }, [employees, dayShifts]);

  // Koje kolone da prikažemo u gridu
  const idsToRender = useMemo(() => {
    // MOBILNI: jedna izabrana ili ništa dok ne izabereš
    if (isMobile) return selEmpId ? [selEmpId] : [];

    // DESKTOP: ako je nešto ručno izabrano — prikaži baš to
    if (selectedEmpIds.length) return selectedEmpIds;

    // Fallback ponašanje kao ranije
    if (onlyWorking) return workingTodayIds;
    return employees.map((e) => e.id);
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

  const apptsByEmp = useMemo(() => {
    const m = new Map();
    for (const a of appointments) {
      if (!m.has(a.employeeId)) m.set(a.employeeId, []);
      m.get(a.employeeId).push(a);
    }
    for (const [, arr] of m) arr.sort((a, b) => (a.startMin || 0) - (b.startMin || 0));
    return m;
  }, [appointments]);

  /* ------------ validations & actions (day) ------------ */

  const withinSalon = (s, e) => s >= openMin && e <= closeMin && e > s;

  // ✨ bitno: ako radnica NEMA smenu za dan → tretiraj kao da radi tokom radnog vremena salona
  const withinShift = (empId, s, e) => {
    const segs = shiftsByEmp.get(empId);
    if (!segs || segs.length === 0) {
      return s >= openMin && e <= closeMin && e > s;
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

  function apptStartDate(appt) {
    // lokalno vreme browsera (koristi Europe/Belgrade kod tebe)
    return new Date(`${appt.dateKey}T${appt.startHHMM || "00:00"}:00`);
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
      const end = start + Number(srv.durationMin || 0);

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
          price: Number(srv.price || 0),
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
    const end = timeToMin(endTime);

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
              ? data.createdAt || serverTimestamp()
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
                ? data.createdAt || serverTimestamp()
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
    const srvPrice = servicesById.get(appt.serviceId)?.price;
    const basePrice = Number(appt.price ?? srvPrice ?? 0);
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
    const okShift = segs.some(
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

  const openApptModal = (a) => setActiveAppt(a);
  const closeApptModal = () => setActiveAppt(null);

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
                    onChange={(e) =>
                      setDayDate(new Date(e.target.value + "T00:00:00"))
                    }
                    style={inp}
                  />
                </div>

                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiUser /> Radnica
                  </label>
                  <select
                    value={selEmpId || ""}
                    onChange={(e) => setSelEmpId(e.target.value)}
                    style={inp}
                  >
                    <option value="">— Odaberi —</option>
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>

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

                {/* Termin / Blokada */}
                <div style={ctlItem}>
                  <label style={lbl}>Režim</label>
                  <div style={segWrap}>
                    {["booking", "block"].map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        style={segBtn(mode === m)}
                      >
                        {m === "booking" ? "Termin" : "Blokada"}
                      </button>
                    ))}
                  </div>
                </div>

                {mode === "booking" ? (
                  <div style={ctlItem}>
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
                )}

                {mode === "booking" && (
                  <>
                    <div style={ctlItem}>
                      <label style={lbl}>Klijent</label>
                      <input
                        value={clientName}
                        onChange={(e) => setClientName(e.target.value)}
                        style={inp}
                        placeholder="Ime klijenta"
                      />
                    </div>
                    <div style={ctlItem}>
                      <label style={lbl}>Telefon</label>
                      <input
                        value={clientPhone}
                        onChange={(e) => setClientPhone(e.target.value)}
                        style={inp}
                        placeholder="Telefon"
                      />
                    </div>
                  </>
                )}

                <div style={{ ...ctlItem, alignSelf: "flex-end" }}>
                  <button style={primaryBtn} onClick={addItem}>
                    <FiPlus style={{ marginRight: 6 }} />
                    {mode === "booking" ? "Dodaj termin" : "Blokiraj period"}
                  </button>
                </div>
              </div>

              {/* MOBILNA TRAKA RADNICA */}
              {isMobile && (
                <div
                  className="emp-strip-mobile"
                  style={{
                    display: "flex",
                    flexWrap: "nowrap",
                    overflowX: "auto",
                    gap: 8,
                    padding: "6px 0",
                    WebkitOverflowScrolling: "touch",
                    scrollbarWidth: "none",
                  }}
                >
                  {employees.map((e) => {
                    const isWorking = workingTodayIds.includes(e.id);
                    const isSelected = selEmpId === e.id;
                    return (
                      <button
                        key={e.id}
                        onClick={() => setSelEmpId(e.id)}
                        style={{
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
                  flexWrap: "wrap", // ⇐ dozvoli prelamanje u više redova
                  overflowX: "visible", // ⇐ bez horizontalnog skrola
                  gap: 8,
                  rowGap: 6, // ⇐ malo vertikalnog razmaka između redova
                  padding: "6px 0",
                  marginTop: 6,
                  alignItems: "center",
                }}
              >
                {/* Pomoćna dugmad levo */}
                <button
                  onClick={() => {
                    setSelEmpId(null);
                    setOnlyWorking(true);
                    setSelectedEmpIds(workingTodayIds);
                  }}
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
                  onClick={() => {
                    setSelEmpId(null);
                    setOnlyWorking(false);
                    setSelectedEmpIds(employees.map((e) => e.id));
                  }}
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
                {employees.map((e) => {
                  const isWorking = workingTodayIds.includes(e.id);
                  const isSelected = selectedEmpIds.includes(e.id);
                  return (
                    <button
                      key={e.id}
                      onClick={() => {
                        toggleEmp(e.id);
                        setSelEmpId(e.id);
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
              onCreateBlock={handleCreateBlock}
              dayKey={dateKey(dayDate)} // za NOW liniju
            />
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
                    <option value="">— Odaberi —</option>
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
                    step={300}
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
                    step={300}
                    lang="sr-RS"
                    value={tplEnd}
                    onChange={(e) => setTplEnd(e.target.value)}
                    style={inp}
                  />
                </div>
              </div>

              {/* DANI U NEDELJI */}
              <div style={btnRow} className="tpl-days">
                {DOW_SR.map((d, i) => (
                  <button
                    key={i}
                    onClick={() => toggleTplDay(i)}
                    style={dayChip(templateDays.has(i))}
                  >
                    {d}
                  </button>
                ))}
                <button onClick={pickWorkdays} style={dayChip(false)}>
                  Radni dani
                </button>
                <button onClick={pickAllDays} style={dayChip(false)}>
                  Svi dani
                </button>
                <button onClick={clearTplDays} style={dayChip(false)}>
                  Očisti
                </button>
              </div>

              {/* DUGMAD ZA PRIMENU */}
              <div style={{ ...btnRow, marginTop: 8 }}>
                <button
                  style={primaryBtn}
                  onClick={applyMonthTemplate}
                  disabled={busy}
                >
                  {busy ? "Upisujem..." : "Primeni šablon na mesec"}
                </button>
              </div>

              {/* JEDAN DAN */}
              <div style={{ ...row, marginTop: 16 }} className="month-row">
                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiCalendar /> Jedan dan
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
                    step={300}
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
                    step={300}
                    lang="sr-RS"
                    value={oneEnd}
                    onChange={(e) => setOneEnd(e.target.value)}
                    style={inp}
                  />
                </div>
                <div style={ctlItem}>
                  <button
                    style={primaryBtn}
                    onClick={applySingleDayShift}
                    disabled={busy}
                  >
                    {busy ? "Upisujem..." : "Postavi za taj dan"}
                  </button>
                </div>
              </div>

              {/* ODMOR */}
              <div style={{ ...row, alignItems: "end", marginTop: 8 }}
                className="month-row"
              >
                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiCalendar /> Početak odmora (datum)
                  </label>
                  <input
                    type="date"
                    value={vacStart}
                    onChange={(e) => setVacStart(e.target.value)}
                    style={inp}
                  />
                </div>
                <div style={ctlItem}>
                  <label style={lbl}>Trajanje (dana)</label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={vacDays}
                    onChange={(e) => setVacDays(e.target.value)}
                    style={inp}
                  />
                </div>
                <div style={{ ...ctlItem }}>
                  <button
                    style={primaryBtn}
                    onClick={applyVacationRange}
                    disabled={busyVac}
                  >
                    {busyVac ? "Upisujem…" : "Postavi odmor"}
                  </button>
                </div>
              </div>

              {/* Roster prozor */}
              <MonthRosterWindow
                monthStr={monthAnchor}
                shifts={monthShifts}
                breaks={[...timeOffs]}
                employeesById={employeesById}
                isMobile={isMobile}
              />
            </div>
          </>
        ) : (
          <>
            {/* RASPORED */}
            <div style={monthWrap} className="month-wrap">
              <div style={row} className="month-row">
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
                  <label style={lbl}>Dan</label>
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

              <DayStrip
                monthStr={monthAnchor}
                selectedKey={dateKey(schedDate)}
                onPickDay={(key) => setSchedDate(new Date(key + "T00:00:00"))}
              />

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
            </div>
          </>
        )}

        {/* Modal za termin */}
        {activeAppt &&
          createPortal(
            <ApptModal
              appt={activeAppt}
              onClose={closeApptModal}
              employees={employees}
              servicesById={servicesById}
              employeesById={employeesById}
              salonHours={salonHours}
              shiftsByEmp={shiftsByEmp}
              pendingPenaltyByPhone={pendingPenaltyByPhone}
              earliestApptIdByPhone={firstUpcomingApptIdByPhone}
              colorForServiceId={colorForServiceId}
              onSave={async (patch) => {
                // validacija pre snimanja
                const { startHHMM, employeeId } = patch;
                const a = activeAppt;
                const srv = servicesById.get(a.serviceId);
                const duration = a.durationMin || srv?.durationMin || 0;
                const newStart = timeToMin(startHHMM || a.startHHMM);
                const newEnd = newStart + duration;

                const dow = DOW[new Date(a.dateKey + "T00:00:00").getDay()];
                const hours = salonHours[dow] || DEFAULT_SALON_HOURS[dow];
                const open = timeToMin(hours.open);
                const close = timeToMin(hours.close);

                if (!(newEnd > newStart && newStart >= open && newEnd <= close)) {
                  alert("Vreme je van radnog vremena salona.");
                  return;
                }
                const emp = employeeId || a.employeeId;
                const segs = shiftsByEmp.get(emp) || [];
                const okShift = segs.some(
                  (seg) => newStart >= seg.start && newEnd <= seg.end
                );
                if (!okShift) {
                  alert("Vreme je van smene radnice.");
                  return;
                }
                if (!noOverlap(emp, newStart, newEnd, a.id)) {
                  alert("Preklapanje sa postojećim terminom.");
                  return;
                }

                await updateDoc(doc(db, "appointments", a.id), {
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
  dayKey, // dodato za NOW liniju
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragEmpId, setDragEmpId] = useState(null);
  const [dragStartMin, setDragStartMin] = useState(0);
  const [previewTop, setPreviewTop] = useState(0);
  const [previewHeight, setPreviewHeight] = useState(0);

  const getMinFromEvent = (e) => {
    const touch = e.touches?.[0] || e.changedTouches?.[0];
    const clientY = touch ? touch.clientY : e.clientY;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = clientY - rect.top;
    let min = openMin + Math.floor(y / 3.5);
    min = Math.round(min / 5) * 5;
    return clamp(min, openMin, closeMin);
  };

  const handleMouseDown = (e, empId) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startMin = getMinFromEvent(e);
    setIsDragging(true);
    setDragEmpId(empId);
    setDragStartMin(startMin);
    setPreviewTop(pxFromMin(startMin - openMin));
    setPreviewHeight(0);
  };

  const handleMouseMove = (e, empId) => {
    if (!isDragging || dragEmpId !== empId) return;
    const currentMin = getMinFromEvent(e);
    const min1 = Math.min(dragStartMin, currentMin);
    const min2 = Math.max(dragStartMin, currentMin);
    setPreviewTop(pxFromMin(min1 - openMin));
    setPreviewHeight(pxFromMin(min2 - min1));
  };

  const handleMouseUp = (e, empId) => {
    if (!isDragging || dragEmpId !== empId) return;
    const endMin = getMinFromEvent(e);
    const startMinFinal = Math.min(dragStartMin, endMin);
    const endMinFinal = Math.max(dragStartMin, endMin);
    if (endMinFinal - startMinFinal < 5) {
      setIsDragging(false);
      setDragEmpId(null);
      return;
    }
    onCreateBlock(empId, startMinFinal, endMinFinal);
    setIsDragging(false);
    setDragEmpId(null);
  };

  const handleMouseLeave = () => {
    if (isDragging) {
      setIsDragging(false);
      setDragEmpId(null);
    }
  };

  const handleTouchStart = (e, empId) => {
    const startMin = getMinFromEvent(e);
    setIsDragging(true);
    setDragEmpId(empId);
    setDragStartMin(startMin);
    setPreviewTop(pxFromMin(startMin - openMin));
    setPreviewHeight(0);
  };

  const handleTouchMove = (e, empId) => {
    if (!isDragging || dragEmpId !== empId) return;
    if (e.touches.length !== 1) return;
    e.preventDefault(); // bitno za mobilni
    const currentMin = getMinFromEvent(e);
    const min1 = Math.min(dragStartMin, currentMin);
    const min2 = Math.max(dragStartMin, currentMin);
    setPreviewTop(pxFromMin(min1 - openMin));
    setPreviewHeight(pxFromMin(min2 - min1));
  };

  const handleTouchEnd = (e, empId) => {
    if (!isDragging || dragEmpId !== empId) return;
    if (e.changedTouches.length !== 1) {
      setIsDragging(false);
      setDragEmpId(null);
      return;
    }
    const endMin = getMinFromEvent(e);
    const startMinFinal = Math.min(dragStartMin, endMin);
    const endMinFinal = Math.max(dragStartMin, endMin);
    if (endMinFinal - startMinFinal < 5) {
      setIsDragging(false);
      setDragEmpId(null);
      return;
    }
    onCreateBlock(empId, startMinFinal, endMinFinal);
    setIsDragging(false);
    setDragEmpId(null);
  };

  // NOW linija: prikaz samo ako je izabrani dan = danas i vreme unutar otvorenog intervala
  const todayKey = dateKey(new Date());
  const isToday = dayKey === todayKey;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const showNow = isToday && nowMin >= openMin && nowMin <= closeMin;

  return (
    <div
      style={{ ...gridWrap, gridTemplateColumns: isMobile ? "36px 1fr" : "80px 1fr" }}
      className="grid-day"
    >
      <div className="time-axis" style={{ ...timeAxis, height: gridHeight(closeMin - openMin) }}>
        {timeMarks(openMin, closeMin).map((t) => (
          <div key={t} style={markRow}>
            <span style={markLbl(isMobile)}>{minToTime(t)}</span>
          </div>
        ))}
      </div>

      <div style={colsWrap}>
        {employeeIdsForDay.map((empId) => {
          const emp = employeesById.get(empId);
          const segs = shiftsByEmp.get(empId) || [];
          const appts = (appointments || []).filter((a) => a.employeeId === empId);

          return (
            <div
              key={empId}
              style={colBox}
              onDragOver={onColDragOver}
              onDrop={onColDrop(empId)}
            >
              <div style={colHeader}>{emp?.name || "—"}</div>
              <div
                style={{ ...colBody, height: gridHeight(closeMin - openMin), touchAction: "none" }}
                onMouseDown={(e) => handleMouseDown(e, empId)}
                onMouseMove={(e) => handleMouseMove(e, empId)}
                onMouseUp={(e) => handleMouseUp(e, empId)}
                onMouseLeave={handleMouseLeave}
                onTouchStart={(e) => handleTouchStart(e, empId)}
                onTouchMove={(e) => handleTouchMove(e, empId)}
                onTouchEnd={(e) => handleTouchEnd(e, empId)}
              >
                {/* smene kao overlay */}
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

                {/* NOW linija — samo u ovoj koloni */}
                {showNow && (
                  <div
                    aria-label="trenutno vreme"
                    style={{
                      position: "absolute",
                      left: 6,
                      right: 6,
                      top: pxFromMin(nowMin - openMin) - 1,
                      height: 2,
                      background: "#ff2b6a",
                      opacity: 0.95,
                      borderRadius: 2,
                      pointerEvents: "none",
                    }}
                  />
                )}

                {/* prikaz termina */}
                {appts.map((a) => {
                  const isBlock = a.type === "block";
                  const isBreak = a.type === "break";
                  const isVacation = a.type === "vacation";
                  const top = pxFromMin(a.startMin - openMin);
                  const height = pxFromMin(a.endMin - a.startMin);
                  const bg = apptBgFor(a, colorForServiceId);

                  // badge logika
                  const phone = normPhone(a.clientPhone);
                  const hasNoShowHistory = !!(phone && noShowByPhone.get(phone));
                  const pendingPen = a.clientPhone
                    ? pendingPenaltyByPhone.get(normPhone(a.clientPhone))
                    : null;
                  const hasPendingPenalty = !!pendingPen;
                  const penaltyApplied = a?.penaltyApplied?.amount > 0;

                  const earliestIdForPhone = phone ? earliestApptIdByPhone.get(phone) : null;
                  const showPendingPenaltyHere =
                    !!(hasPendingPenalty && !penaltyApplied && earliestIdForPhone === a.id);
                  const showNoShowHere = !!(hasNoShowHistory && earliestIdForPhone === a.id);

                  // Specijalan prikaz za BLOKADU: traka + mala kartica sa vremenom i (x)
                  if (isBlock) {
                    const stripe = (
                      <div
                        key={a.id + ":stripe"}
                        style={apptBlockStripe(top, height)}
                        title="Blokirano"
                      />
                    );
                    const card = (
                      <div
                        key={a.id}
                        style={apptCard(top, height, "rgba(255,255,255,.85)", true, 6 + BLOCK_WIDTH + 6, 6)}
                        title="Blokirano"
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                          }}
                        >
                          <div style={{ fontWeight: 800 }}>Blokada</div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteAppt(a.id);
                            }}
                            title="Obriši blokadu"
                            style={{
                              border: "none",
                              background: "transparent",
                              fontSize: 16,
                              lineHeight: 1,
                              cursor: "pointer",
                            }}
                            aria-label="Obriši blokadu"
                          >
                            ×
                          </button>
                        </div>
                        <div
                          style={{
                            marginTop: 2,
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            fontWeight: 700,
                          }}
                        >
                          <span>⏱ {minToTime(a.startMin)}–{minToTime(a.endMin)}</span>
                        </div>
                      </div>
                    );
                    return [stripe, card];
                  }

                  // ostali: booking / break / vacation
                  const styleForCard = apptCard(top, height, bg, isBreak || isVacation);

                  return (
                    <button
                      key={a.id}
                      draggable={!isBreak && !isVacation}
                      onDragStart={onApptDragStart(a)}
                      onMouseEnter={() => setHoverApptId(a.id)}
                      onMouseLeave={() => setHoverApptId(null)}
                      onClick={() => !isBreak && !isVacation && onApptClick(a)}
                      style={styleForCard}
                      title={
                        isVacation
                          ? "Odmor"
                          : isBreak
                          ? "Pauza"
                          : `${a.serviceName || "Usluga"} ${
                              a.clientName ? "· " + a.clientName : ""
                            }`
                      }
                    >
                      <div style={cardTitle(isMobile)}>
                        {isVacation ? "Odmor" : isBreak ? "Pauza" : a.serviceName || "Usluga"}
                      </div>

                      {!isBreak && !isVacation && (
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
                            <FiClock style={{ marginRight: 6 }} />{" "}
                            {minToTime(a.startMin)}–{minToTime(a.endMin)}
                          </span>
                        </div>
                      )}

                      {!isBreak && !isVacation && showNoShowHere && (
                        <div style={badgeNoShow}>
                          <FiAlertTriangle style={{ marginRight: 6 }} />
                          No-show istorija
                        </div>
                      )}
                      {!isBreak && !isVacation && showPendingPenaltyHere && (
                        <div style={badgePenalty}>
                          <FiInfo style={{ marginRight: 6 }} />
                          Kazna za naplatu
                        </div>
                      )}
                      {!isBreak && !isVacation && penaltyApplied && (
                        <div style={badgePenalty}>
                          <FiInfo style={{ marginRight: 6 }} />
                          Kazna primenjena
                        </div>
                      )}

                      {hoverApptId === a.id && !isBreak && !isVacation && (
                        <div style={hoverHint}>
                          <FiEdit3 /> Klikni za detalje
                        </div>
                      )}
                    </button>
                  );
                })}

                {/* preview crtanja blokade tokom drag-a */}
                {isDragging && dragEmpId === empId && (
                  <div
                    style={{
                      position: "absolute",
                      left: 6,
                      width: BLOCK_WIDTH,
                      top: previewTop,
                      height: previewHeight,
                      background:
                        "repeating-linear-gradient(-45deg,#cfcfcf 0 8px,#bdbdbd 8px 16px)",
                      opacity: 0.8,
                      borderRadius: 6,
                      pointerEvents: "none",
                    }}
                  />
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

      <div
        style={{ ...gridWrap, gridTemplateColumns: isMobile ? "36px 1fr" : "80px 1fr" }}
        className="grid-schedule"
      >
        {!isMobile && (
          <div style={{ ...timeAxis, height: gridHeight(closeMin - openMin) }}>
            {timeMarks(openMin, closeMin).map((t) => (
              <div key={t} style={markRow}>
                <span style={markLbl(isMobile)}>{minToTime(t)}</span>
              </div>
            ))}
          </div>
        )}

        <div
          style={{
            ...colBody,
            height: gridHeight(closeMin - openMin),
            position: "relative",
            touchAction: "none", // bitno za mobilni – omogući preventDefault
            userSelect: "none",
            background: "rgba(255,255,255,.12)",
            borderRadius: 16,
            border: "0.5px solid rgba(255,255,255,.25)",
          }}
        >
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

            const phone = normPhone(a.clientPhone);
            const hasNoShowHistory = !!(phone && noShowByPhone.get(phone));
            const pendingPen = a.clientPhone
              ? pendingPenaltyByPhone.get(normPhone(a.clientPhone))
              : null;
            const hasPendingPenalty = !!pendingPen;
            const penaltyApplied = a?.penaltyApplied?.amount > 0;

            const earliestIdForPhone = phone ? earliestApptIdByPhone.get(phone) : null;
            const showPendingPenaltyHere =
              hasPendingPenalty && !penaltyApplied && earliestIdForPhone === a.id;
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
                title={`${srv} • ${minToTime(a.startMin)}–${minToTime(
                  a.endMin
                )} • ${empName}`}
              >
                <div style={cardTitle(isMobile)}>{srv}</div>

                <div style={metaRow}>
                  <span style={pill}>
                    <FiClock style={{ marginRight: 6 }} />
                    {minToTime(a.startMin)}–{minToTime(a.endMin)}
                  </span>
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
/* -------------------- Month roster (WINDOW: 7 dana desktop / 1 dan mobilni) -------------------- */

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

  // ko radi po danu
  const byDay = new Map();
  for (const s of shifts) {
    if (!byDay.has(s.dateKey)) byDay.set(s.dateKey, new Set());
    byDay.get(s.dateKey).add(s.employeeId);
  }
  // pauze/odmori po (dan,radnica)
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
            : `Dani ${start}-${end} • ${pad2(base.getMonth()+1)}.${base.getFullYear()}.`}
        </div>
        <button onClick={() => !nextDisabled && setPage(page + 1)} disabled={nextDisabled} style={navBtn(nextDisabled)}>▶</button>
      </div>

      {/* 7 kolona (desktop) / 1 kolona (mobilni) */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${end - start + 1}, minmax(140px, 1fr))`, gap: 10 }}>
        {Array.from({ length: end - start + 1 }, (_, i) => start + i).map((d) => {
          const dayKey = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(d)}`;
          const workers = Array.from(byDay.get(dayKey) || []);
          const isToday =
            today.getFullYear() === base.getFullYear() &&
            today.getMonth() === base.getMonth() &&
            today.getDate() === d;

          return (
            <div key={dayKey} style={rosterCol}>
              <div style={rosterHead(isToday)}>
                <div style={{ fontWeight: 900 }}>{pad2(d)}.{pad2(base.getMonth()+1)}.</div>
                <div style={{ opacity: 0.85, fontSize: 12 }}>{DOW_SR[new Date(dayKey + "T00:00:00").getDay()]}</div>
              </div>

              {!workers.length ? (
                <div style={rosterEmpty}>Nema smena.</div>
              ) : (
                <div style={{ display: "grid", gap: 6 }}>
                  {workers.map((empId) => {
                    const name = employeesById.get(empId)?.name || "Radnica";
                    const offs = timeOffMap.get(`${dayKey}|${empId}`) || [];
                    const hasVacation = offs.some((x) => x.type === "vacation");
                    const hasBreak = offs.some((x) => x.type === "break");
                    return (
                      <div key={empId} style={rosterCard}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={dot} />
                          <div style={{ fontWeight: 800 }}>{name}</div>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {hasVacation && <span style={chipDanger}>Odmor</span>}
                          {hasBreak && <span style={chipWarn}>Pauza</span>}
                        </div>
                        <button
                          onClick={() => removeShiftFor(dayKey, empId)}
                          style={trashBtn}
                          title="Ukloni smenu za ovaj dan"
                          aria-label={`Ukloni smenu: ${name}`}
                        >
                          <FiTrash2 />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------- Appt modal -------------------- */

function ApptModal({
  appt,
  onClose,
  employees,
  servicesById,
  employeesById,
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
  const [employeeId, setEmployeeId] = useState(appt.employeeId || "");
  const [startHHMM, setStartHHMM] = useState(appt.startHHMM || "09:00");

  const srv = servicesById.get(appt.serviceId);
  const serviceName = srv?.name || appt.serviceName || "Usluga";
  const color = appt.type === "booking" ? colorForServiceId(appt.serviceId) : "#ddd";
  const duration = appt.durationMin || srv?.durationMin || 0;

  const phone = normPhone(appt.clientPhone);
  const hasNoShowHistory = !!(phone && noShowByPhone.get(phone));
  const pendingPen = phone ? pendingPenaltyByPhone.get(phone) : null;
  const earliestIdForPhone = phone ? earliestApptIdByPhone.get(phone) : null;
  const showPendingHere = !!(pendingPen && appt.id === earliestIdForPhone && !(appt?.penaltyApplied?.amount > 0));

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div style={modalHeader(color)}>
          <div>
            <div style={{ fontWeight: 900 }}>{serviceName}</div>
            <div style={{ fontSize: 12, opacity: 0.9 }}>
              {appt.clientName ? `${appt.clientName} • ` : ""}{minToTime(appt.startMin)}–{minToTime(appt.endMin)} ({duration} min)
            </div>
          </div>
          <button style={deleteButton} onClick={onClose} aria-label="Zatvori">
            <FiX />
          </button>
        </div>

        <div style={modalBody}>
          <div style={field}>
            <div style={fieldLbl}>Radnica</div>
            <select style={inpLight} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>

          <div style={field}>
            <div style={fieldLbl}>Početak</div>
            <input style={inpLight} type="time" step={300} value={startHHMM} onChange={(e) => setStartHHMM(e.target.value)} />
          </div>

          {(hasNoShowHistory || showPendingHere || appt?.penaltyApplied?.amount > 0) && (
            <div style={infoBox}>
              {hasNoShowHistory && (
                <span style={{ ...badge, background: "#fff4e5", color: "#9a5a00" }}>
                  <FiAlertTriangle /> No-show istorija
                </span>
              )}
              {showPendingHere && (
                <span style={{ ...badge, background: "#eaf3ff", color: "#104a93" }}>
                  <FiInfo /> Kazna za naplatu ({pendingPen?.amount ?? 0} RSD)
                </span>
              )}
              {appt?.penaltyApplied?.amount > 0 && (
                <span style={{ ...badge, background: "#eaf3ff", color: "#104a93" }}>
                  <FiInfo /> Kazna primenjena ({appt.penaltyApplied.amount} RSD)
                </span>
              )}
            </div>
          )}
        </div>

        <div style={modalActions}>
          <button
            onClick={() => onSave({ employeeId, startHHMM })}
            style={{ ...actionBtn, background: "#000", color: "#fff" }}
          >
            <FiSave /> Sačuvaj
          </button>
          <button onClick={onCancel} style={{ ...actionBtn, background: "#ffe7ec", color: "#c3224e" }}>
            <FiSlash /> Otkaži
          </button>
          <button onClick={onNoShow} style={{ ...actionBtn, background: "#fff4e5", color: "#9a5a00" }}>
            <FiAlertTriangle /> No-show
          </button>
          <button onClick={onDelete} style={{ ...actionBtn, background: "#fff0f0", color: "#b00020" }}>
            <FiTrash2 /> Obriši
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------- Pomoćne funkcije i stilovi koje koristi grid/strip/modal -------------------- */

const BLOCK_WIDTH = 10;

const wrap = { display: "grid", placeItems: "start center", padding: 10 };
const panel = {
  width: "100%",
  maxWidth: 1200,
  background: "linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.04))",
  border: "1px solid rgba(255,255,255,.2)",
  borderRadius: 16,
  padding: 12,
};
const tabbar = { display: "flex", gap: 8, marginBottom: 10 };
const tabBtn = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,.3)",
  background: "rgba(255,255,255,.08)",
  color: "#fff",
  fontWeight: 800,
  cursor: "pointer",
};
const tabBtnActive = { ...tabBtn, background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)", borderColor: "transparent" };

const ctlWrap = { display: "grid", gap: 8, marginBottom: 8 };
const ctlRowA = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 };
const ctlItem = { display: "grid", gap: 6 };
const lbl = { color: "#fff", fontWeight: 900, fontSize: 12, opacity: 0.95 };
const inp = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,.35)",
  background: "rgba(255,255,255,.92)",
  color: "#000",
};
const inpLight = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #ddd",
  background: "#fff",
  color: "#000",
};
const segWrap = { display: "flex", gap: 6 };
const segBtn = (active) => ({
  padding: "8px 12px",
  borderRadius: 999,
  border: active ? "none" : "1px solid rgba(255,255,255,.35)",
  background: active ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "rgba(255,255,255,.12)",
  color: active ? "#fff" : "#000",
  fontWeight: 900,
  cursor: "pointer",
});
const primaryBtn = {
  padding: "10px 14px",
  borderRadius: 12,
  border: "none",
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  color: "#fff",
  fontWeight: 900,
  cursor: "pointer",
};

const monthWrap = { display: "grid", gap: 10, marginTop: 6 };
const row = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 };
const btnRow = { display: "flex", gap: 6, flexWrap: "wrap" };
const dayChip = (active) => ({
  padding: "8px 12px",
  borderRadius: 999,
  border: active ? "none" : "1px solid rgba(255,255,255,.35)",
  background: active ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "rgba(255,255,255,.12)",
  color: active ? "#fff" : "#000",
  fontWeight: 900,
  cursor: "pointer",
});
const navBtn = (disabled) => ({
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,.3)",
  background: disabled ? "rgba(255,255,255,.08)" : "linear-gradient(135deg,#ffffff,#eaf5ff)",
  color: "#000",
  fontWeight: 800,
  cursor: disabled ? "default" : "pointer",
});

const stripWrap = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(80px, 1fr))",
  gap: 6,
  width: "100%",
};
const stripBtn = (active, compact) => ({
  minWidth: compact ? 70 : 90,
  padding: compact ? "6px 8px" : "8px 10px",
  borderRadius: 12,
  border: active ? "none" : "1px solid rgba(255,255,255,.35)",
  background: active ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "rgba(255,255,255,.12)",
  color: active ? "#fff" : "#000",
  fontWeight: 900,
  display: "grid",
  justifyItems: "center",
  gap: 2,
});

const gridWrap = { display: "grid", gap: 12, alignItems: "start" };
const colsWrap = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
  gap: 10,
};
const timeAxis = { position: "relative" };
const markRow = { position: "relative", height: 3.5 * 60 }; // 60min * 3.5px
const markLbl = (isMobile) => ({
  position: "absolute",
  top: -7,
  right: isMobile ? 0 : -6,
  transform: "translate(100%,0)",
  fontSize: 12,
  color: "#fff",
  opacity: 0.85,
});
const colBox = {
  borderRadius: 16,
  overflow: "hidden",
  background: "rgba(255,255,255,.12)",
  border: "0.5px solid rgba(255,255,255,.25)",
};
const colHeader = {
  padding: "8px 10px",
  fontWeight: 900,
  color: "#fff",
  background: "rgba(255,255,255,.06)",
  borderBottom: "1px solid rgba(255,255,255,.2)",
};
const colBody = { position: "relative", padding: 6, userSelect: "none" };

const rosterCol = {
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 12,
  background: "rgba(255,255,255,.08)",
  padding: 8,
  color: "#fff",
};
const rosterHead = (today) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 8,
  paddingBottom: 6,
  borderBottom: "1px dashed rgba(255,255,255,.25)",
  ...(today ? { background: "linear-gradient(90deg, rgba(255,255,255,.12), transparent)" } : {}),
});
const rosterEmpty = { opacity: 0.8, fontStyle: "italic" };
const rosterCard = {
  position: "relative",
  display: "grid",
  gap: 6,
  padding: 8,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,.25)",
  background: "rgba(255,255,255,.12)",
};
const dot = {
  width: 8,
  height: 8,
  borderRadius: 999,
  background: "#ff7fb5",
};
const chipWarn = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  background: "#fff6e0",
  color: "#8a5700",
  fontWeight: 800,
  fontSize: 12,
};
const chipDanger = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  background: "#ffe3e9",
  color: "#b12b54",
  fontWeight: 800,
  fontSize: 12,
};
const trashBtn = {
  position: "absolute",
  right: 6,
  top: 6,
  border: "none",
  background: "transparent",
  color: "#000",
  cursor: "pointer",
};

/* --- vizuelne funkcije za grid --- */
const pxFromMin = (m) => Math.round(m * 3.5);
const gridHeight = (mins) => pxFromMin(mins);
const timeMarks = (open, close) => {
  const res = [];
  for (let t = Math.ceil(open / 60) * 60; t <= close; t += 60) res.push(t);
  return res;
};

const cardTitle = (isMobile) => ({ fontWeight: 900, fontSize: isMobile ? 13 : 14, lineHeight: 1.05 });
const metaRow = { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 };
const pill = { display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 999, background: "rgba(255,255,255,.92)", color: "#000", fontWeight: 800, fontSize: 12 };
const pillLight = (isMobile) => ({ ...pill, background: isMobile ? "rgba(255,255,255,.92)" : "rgba(255,255,255,.75)" });

const hoverHint = {
  position: "absolute",
  right: 8,
  bottom: 8,
  background: "rgba(0,0,0,.55)",
  color: "#fff",
  fontSize: 12,
  padding: "4px 8px",
  borderRadius: 999,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const apptCard = (top, height, bg, muted, left = 6, right = 6) => ({
  position: "absolute",
  top,
  left,
  right,
  height,
  padding: 8,
  borderRadius: 12,
  background: bg,
  border: "1px solid rgba(0,0,0,.1)",
  color: muted ? "#333" : "#000",
  textAlign: "left",
  cursor: muted ? "default" : "pointer",
  overflow: "hidden",
});
const apptBlockStripe = (top, height) => ({
  position: "absolute",
  left: 6,
  width: BLOCK_WIDTH,
  top,
  height,
  background: "repeating-linear-gradient(-45deg,#cfcfcf 0 8px,#bdbdbd 8px 16px)",
  borderRadius: 6,
});

const badgeNoShow = { ...pill, background: "#fff4e5", color: "#9a5a00", position: "absolute", top: 6, right: 6 };
const badgePenalty = { ...pill, background: "#eaf3ff", color: "#104a93", position: "absolute", top: 6, right: 6 };

/* --- Modal stilovi --- */
const modalBackdrop = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,.6)",
  display: "grid",
  placeItems: "center",
  zIndex: 1000,
};
const modal = {
  width: "min(640px, 96vw)",
  background: "#fff",
  color: "#000",
  borderRadius: 14,
  overflow: "hidden",
  boxShadow: "0 16px 60px rgba(0,0,0,.35)",
};
const modalHeader = (color) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: 12,
  borderBottom: "1px solid #eee",
  background: `linear-gradient(135deg, ${color || "#f2f2f2"}, #ffffff)`,
});
const modalBody = { padding: 14 };
const field = { display: "grid", gap: 6, marginBottom: 10 };
const fieldLbl = { fontSize: 12, fontWeight: 900, color: "#333" };
const badge = { display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 999, fontSize: 12, fontWeight: 800 };
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
const modalActions = { display: "flex", gap: 8, padding: 12, background: "#fafafa", borderTop: "1px solid #eee" };
const actionBtn = { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 12px", border: "none", borderRadius: 10, cursor: "pointer", fontWeight: 900 };
const deleteButton = { position: "absolute", top: 8, right: 8, background: "transparent", border: "none", color: "#000", fontSize: 18, cursor: "pointer", padding: 0 };

/* --- Responsive fine-tuning (kao u prilogu) --- */
const responsiveCSS = `
/* Mobilni i tableti – 2 kolone sa tankom vremenskom osom */
@media (max-width: 768px) {
  .grid-day, .grid-schedule { grid-template-columns: 36px 1fr !important; }
  .time-axis { display:block !important; min-width:36px; }
}
/* iOS zoom fix */
.admincal :is(input, select, button) { font-size: 16px !important; }
@media (max-width: 1100px) {
  .grid-day, .grid-schedule { gap: 8px !important; }
  .daystrip .strip-btn { min-width: 64px !important; }
}
@media (max-width: 900px) {
  .ctl .ctl-row-a { display: grid !important; grid-template-columns: 1fr 1fr; gap: 8px; }
}
`;
