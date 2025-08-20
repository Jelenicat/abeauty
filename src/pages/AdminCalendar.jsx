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
import { runTransaction, writeBatch, increment } from "firebase/firestore";

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

/* -------------------- component -------------------- */
// --- helpers (ostaje gde jeste) ---

// ⬇⬇⬇ van komponente
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

  // očisti nevažeće ID-jeve iz selekcije
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
      // prikaži sve koji NISU booking ili su booking ali aktivni (status === "booked")
      const visible = all.filter(
        (a) => a.type !== "booking" || a.status === "booked"
      );
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

  // defaults
  useEffect(() => {
    if (
      !autoPickedRef.current &&
      selEmpId == null &&
      employees.length &&
      !isMobile
    ) {
      setSelEmpId(employees[0].id);
      autoPickedRef.current = true;
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
    const catIds = Array.from(
      new Set(services.map((s) => s.categoryId).filter(Boolean))
    );
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
    if (isMobile) return selEmpId ? [selEmpId] : [];
    if (selectedEmpIds.length) return selectedEmpIds;
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
    for (const [, arr] of m)
      arr.sort((a, b) => (a.startMin || 0) - (b.startMin || 0));
    return m;
  }, [appointments]);

  /* ------------ validations & actions (day) ------------ */

  const withinSalon = (s, e) => s >= openMin && e <= closeMin && e > s;
  const withinShift = (empId, s, e) =>
    (shiftsByEmp.get(empId) || []).some((seg) => s >= seg.start && e <= seg.end);
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
            // primeni i obriši pendingPenalty — SAMO PRVI SLEDEĆI TERMIN
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
            // kreiraj klijenta (osnovno)
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
          clientPhone: phoneN,
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

  async function cancelApptWithRule(appt) {
    if (!appt?.id) return;
    if (!confirm("Otkazati termin?")) return;

    const now = new Date();
    const start = apptStartDate(appt);
    const diffHours = (start - now) / 36e5;

    await deleteDoc(doc(db, "appointments", appt.id));

    if (appt.type === "booking" && diffHours < 6) {
      const phone = normPhone(appt.clientPhone);
      if (phone) {
        const cRef = doc(db, "clients", phone);
        const snap = await getDoc(cRef);

        const srvPrice = servicesById.get(appt.serviceId)?.price;
        const basePrice = Number(appt.price ?? srvPrice ?? 0);
        const penaltyAmount = Math.round(basePrice * 0.5);

        await setDoc(
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
              ? snap.data().createdAt || serverTimestamp()
              : serverTimestamp(),
          },
          { merge: true }
        );
      }
    }
  }

  // mark no-show + upiši kaznu 50% kao pendingPenalty
  async function markNoShowWithClient(appt) {
    if (!appt?.id) return;
    await markAppt(appt.id, { status: "noshow" });

    const phone = normPhone(appt.clientPhone);
    if (!phone) return;

    const cRef = doc(db, "clients", phone);
    const srvPrice = servicesById.get(appt.serviceId)?.price;
    const basePrice = Number(appt.price ?? srvPrice ?? 0);
    const penaltyAmount = Math.round(basePrice * 0.5);

    await setDoc(
      cRef,
      {
        phone,
        name: appt.clientName || "",
        noShowCount: increment(1),
        pendingPenalty: {
          amount: penaltyAmount,
          sourceApptId: appt.id,
          sourceService: appt.serviceName || "",
          createdAt: serverTimestamp(),
        },
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      },
      { merge: true }
    );
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
                  flexWrap: "wrap",
                  overflowX: "visible",
                  gap: 8,
                  rowGap: 6,
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
              isMobile={isMobile}
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
                  <label style={lbl}>Kraj</label>
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

              {/* RED 2 */}
              <div style={{ ...row, alignItems: "end" }} className="month-row">
                <div
                  style={{
                    gridColumn: "1 / -1",
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  {DOW_SR.map((label, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => toggleTplDay(idx)}
                      style={dayChip(templateDays.has(idx))}
                      title={label}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div style={btnRow}>
                  <button
                    type="button"
                    style={primaryBtn}
                    onClick={applyMonthTemplate}
                    disabled={busy}
                    title="Upiši smene za sve izabrane dane u ovom mesecu"
                  >
                    {busy ? "Upisujem…" : "Postavi smene za mesec"}
                  </button>

                  <button
                    type="button"
                    onClick={pickWorkdays}
                    style={{ ...tabBtn, background: "#fff", color: "#000" }}
                    title="Pon–Pet"
                  >
                    Pon–Pet
                  </button>
                  <button
                    type="button"
                    onClick={pickAllDays}
                    style={{ ...tabBtn, background: "#fff", color: "#000" }}
                    title="Sve dane"
                  >
                    Sve
                  </button>
                  <button
                    type="button"
                    onClick={clearTplDays}
                    style={{ ...tabBtn, background: "#fff", color: "#000" }}
                    title="Poništi izbor"
                  >
                    Poništi
                  </button>
                </div>
              </div>

              {/* RED 3: smena za JEDAN DAN */}
              <div style={{ ...row, alignItems: "end" }} className="month-row">
                <div style={ctlItem}>
                  <label style={lbl}>
                    <FiCalendar /> Dan
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
                    <FiClock /> Početak (dan)
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
                  <label style={lbl}>Kraj (dan)</label>
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
                    Postavi smenu za dan
                  </button>
                </div>
              </div>

              {/* ODMOR */}
              <div
                style={{ ...row, alignItems: "end", marginTop: 8 }}
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

function DayStrip({
  monthStr,
  selectedKey,
  onPickDay,
  compact = false,
  chunkSize = 7,
}) {
  const base = new Date(monthStr + "-01T00:00:00");
  const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const ref = useRef(null);

  const selDay = selectedKey
    ? new Date(selectedKey + "T00:00:00").getDate()
    : 1;
  const [page, setPage] = useState(Math.floor((selDay - 1) / chunkSize));

  useEffect(() => {
    const newPage = Math.floor((selDay - 1) / chunkSize);
    if (newPage !== page) setPage(newPage);
  }, [selDay, chunkSize]);

  const startDay = page * chunkSize + 1;
  const endDay = Math.min(startDay + chunkSize - 1, days);

  return (
    <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>
        ◀
      </button>
      <div style={stripWrap} ref={ref}>
        {Array.from(
          { length: endDay - startDay + 1 },
          (_, i) => startDay + i
        ).map((d) => {
          const k = `${base.getFullYear()}-${pad2(
            base.getMonth() + 1
          )}-${pad2(d)}`;
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
              <div style={{ fontWeight: 900, fontSize: compact ? 14 : 16 }}>
                {d}
              </div>
            </button>
          );
        })}
      </div>
      <button
        disabled={endDay === days}
        onClick={() => setPage(page + 1)}
      >
        ▶
      </button>
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
  isMobile,
}) {
  return (
    <div style={gridWrap} className="grid-day">
      {!isMobile && (
        <div
          className="time-axis"
          style={{ ...timeAxis, height: gridHeight(closeMin - openMin) }}
        >
          {timeMarks(openMin, closeMin).map((t) => (
            <div key={t} style={markRow}>
              <span style={markLbl}>{minToTime(t)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={colsWrap}>
        {employeeIdsForDay.map((empId) => {
          const emp = employeesById.get(empId);
          const segs = shiftsByEmp.get(empId) || [];
          const appts = (appointments || []).filter(
            (a) => a.employeeId === empId
          );

          return (
            <div
              key={empId}
              style={colBox}
              onDragOver={onColDragOver}
              onDrop={onColDrop(empId)}
            >
              <div style={colHeader}>{emp?.name || "—"}</div>
              <div
                style={{ ...colBody, height: gridHeight(closeMin - openMin) }}
              >
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

                {appts.map((a) => {
                  const isBlock = a.type === "block";
                  const isBreak = a.type === "break";
                  const isVacation = a.type === "vacation";
                  const top = pxFromMin(a.startMin - openMin);
                  const height = pxFromMin(a.endMin - a.startMin);
                  const bg = apptBgFor(a, colorForServiceId);

                  const phone = normPhone(a.clientPhone);
                  const hasNoShowHistory = !!(phone && noShowByPhone.get(phone));
                  const pendingPen = a.clientPhone
                    ? pendingPenaltyByPhone.get(normPhone(a.clientPhone))
                    : null;
                  const hasPendingPenalty = !!pendingPen;
                  const penaltyApplied = a?.penaltyApplied?.amount > 0;

                  return (
                    <button
                      key={a.id}
                      draggable={!isBreak && !isBlock && !isVacation}
                      onDragStart={onApptDragStart(a)}
                      onMouseEnter={() => setHoverApptId(a.id)}
                      onMouseLeave={() => setHoverApptId(null)}
                      onClick={() =>
                        !isBreak && !isBlock && !isVacation && onApptClick(a)
                      }
                      style={apptCard(top, height, bg, isBreak || isVacation || isBlock)}
                      title={
                        isVacation
                          ? "Odmor"
                          : isBreak
                          ? "Pauza"
                          : isBlock
                          ? "Blokirano"
                          : `${a.serviceName || "Usluga"} ${
                              a.clientName ? "· " + a.clientName : ""
                            }`
                      }
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
                            <FiClock style={{ marginRight: 6 }} />{" "}
                            {minToTime(a.startMin)}–{minToTime(a.endMin)}
                          </span>
                        </div>
                      )}

                      {!isBreak &&
                        !isBlock &&
                        !isVacation &&
                        hasNoShowHistory && (
                          <div style={badgeNoShow}>
                            <FiAlertTriangle style={{ marginRight: 6 }} />
                            No-show istorija
                          </div>
                        )}
                      {!isBreak &&
                        !isBlock &&
                        !isVacation &&
                        hasPendingPenalty &&
                        !penaltyApplied && (
                          <div style={badgePenalty}>
                            <FiInfo style={{ marginRight: 6 }} />
                            Kazna za naplatu
                          </div>
                        )}
                      {!isBreak &&
                        !isBlock &&
                        !isVacation &&
                        penaltyApplied && (
                          <div style={badgePenalty}>
                            <FiInfo style={{ marginRight: 6 }} />
                            Kazna primenjena
                          </div>
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

      <div style={gridWrap} className="grid-schedule">
        {!isMobile && (
          <div style={{ ...timeAxis, height: gridHeight(closeMin - openMin) }}>
            {timeMarks(openMin, closeMin).map((t) => (
              <div key={t} style={markRow}>
                <span style={markLbl}>{minToTime(t)}</span>
              </div>
            ))}
          </div>
        )}

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

                {hasNoShowHistory && (
                  <div style={badgeNoShow}>
                    <FiAlertTriangle style={{ marginRight: 6 }} />
                    No-show istorija
                  </div>
                )}
                {hasPendingPenalty && !penaltyApplied && (
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
  const base = new Date(monthStr + "-01T00:00:00");
  const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();

  // grupiši po dateKey
  const byDay = useMemo(() => {
    const m = new Map();
    for (let d = 1; d <= days; d++) {
      const k = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(d)}`;
      m.set(k, { shifts: [], timeOff: [] });
    }
    for (const s of shifts || []) {
      if (!m.has(s.dateKey)) m.set(s.dateKey, { shifts: [], timeOff: [] });
      m.get(s.dateKey).shifts.push(s);
    }
    for (const b of breaks || []) {
      if (!m.has(b.dateKey)) m.set(b.dateKey, { shifts: [], timeOff: [] });
      m.get(b.dateKey).timeOff.push(b);
    }
    return m;
  }, [monthStr, shifts, breaks]);

  // mobilno: prikaz samo selektovanog dana (ili današnjeg)
  const [selKey, setSelKey] = useState(() => {
    const today = new Date();
    if (today.getFullYear() === base.getFullYear() && today.getMonth() === base.getMonth()) {
      return dateKey(today);
    }
    return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-01`;
  });

  if (isMobile) {
    const record = byDay.get(selKey) || { shifts: [], timeOff: [] };
    return (
      <div style={{ marginTop: 12 }}>
        <DayStrip
          monthStr={monthStr}
          selectedKey={selKey}
          onPickDay={(k) => setSelKey(k)}
          compact
          chunkSize={7}
        />
        <div style={rosterMobileBox}>
          <div style={rosterTitle}>
            {selKey} • {DOW_SR[new Date(selKey + "T00:00:00").getDay()]}
          </div>
          {record.shifts.length === 0 && record.timeOff.length === 0 ? (
            <div style={emptyText}>Nema smene/odsustava za ovaj dan.</div>
          ) : (
            <>
              {record.shifts.map((s) => (
                <div key={s.id} style={rosterRow}>
                  <div style={rosterEmp}>{employeesById.get(s.employeeId)?.name || "—"}</div>
                  <div style={rosterSegs}>
                    {(s.segments || []).map((seg, i) => (
                      <span key={i} style={pill}>
                        {seg.start}–{seg.end}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {record.timeOff.map((t) => (
                <div key={t.id} style={rosterTimeOffRow}>
                  <div style={rosterEmp}>{employeesById.get(t.employeeId)?.name || "—"}</div>
                  <div style={rosterSegs}>
                    <span style={pillWarn}>
                      {t.type === "vacation" ? "Odmor" : "Pauza"} {t.startHHMM}–{t.endHHMM}
                    </span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    );
  }

  // desktop: 7 dana „prozor“
  const [winStart, setWinStart] = useState(1);
  const canPrev = winStart > 1;
  const canNext = winStart + 7 <= days;
  const range = Array.from({ length: Math.min(7, days - winStart + 1) }, (_, i) => winStart + i);
  const keys = range.map((d) => `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(d)}`);

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <button disabled={!canPrev} onClick={() => setWinStart((n) => Math.max(1, n - 7))}>◀</button>
        <div style={{ color: "#fff", fontWeight: 900 }}>
          Roster: {pad2(range[0])}.–{pad2(range[range.length - 1])}. {base.getFullYear()}.
        </div>
        <button disabled={!canNext} onClick={() => setWinStart((n) => Math.min(days - 6, n + 7))}>▶</button>
      </div>

      <div style={rosterGrid}>
        {keys.map((k) => {
          const record = byDay.get(k) || { shifts: [], timeOff: [] };
          const dowLabel = DOW_SR[new Date(k + "T00:00:00").getDay()];
          return (
            <div key={k} style={rosterCell}>
              <div style={rosterCellHead}>
                <div style={{ fontSize: 12, opacity: 0.85 }}>{dowLabel}</div>
                <div style={{ fontWeight: 900 }}>{k.split("-")[2]}</div>
              </div>
              <div>
                {record.shifts.map((s) => (
                  <div key={s.id} style={rosterRow}>
                    <div style={rosterEmp}>{employeesById.get(s.employeeId)?.name || "—"}</div>
                    <div style={rosterSegs}>
                      {(s.segments || []).map((seg, i) => (
                        <span key={i} style={pill}>
                          {seg.start}–{seg.end}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                {record.timeOff.map((t) => (
                  <div key={t.id} style={rosterTimeOffRow}>
                    <div style={rosterEmp}>{employeesById.get(t.employeeId)?.name || "—"}</div>
                    <div style={rosterSegs}>
                      <span style={pillWarn}>
                        {t.type === "vacation" ? "Odmor" : "Pauza"} {t.startHHMM}–{t.endHHMM}
                      </span>
                    </div>
                  </div>
                ))}
                {record.shifts.length === 0 && record.timeOff.length === 0 && (
                  <div style={emptyText}>—</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------- Appt Modal -------------------- */

function ApptModal({
  appt,
  onClose,
  employees,
  servicesById,
  employeesById,
  salonHours,
  shiftsByEmp,
  pendingPenaltyByPhone,
  colorForServiceId,
  onSave,
  onNoShow,
  onCancel,
  onDelete,
  noShowByPhone,
}) {
  const srvName = servicesById.get(appt.serviceId)?.name || appt.serviceName || "Usluga";
  const duration = appt.durationMin || servicesById.get(appt.serviceId)?.durationMin || 0;

  const [employeeId, setEmployeeId] = useState(appt.employeeId);
  const [startHHMM, setStartHHMM] = useState(appt.startHHMM);
  const [clientName, setClientName] = useState(appt.clientName || "");
  const [clientPhone, setClientPhone] = useState(appt.clientPhone || "");
  const [price, setPrice] = useState(Number(appt.price || 0));

  const phoneN = normPhone(appt.clientPhone);
  const pendingPen = phoneN ? pendingPenaltyByPhone.get(phoneN) : null;
  const hasPendingPenalty = !!(pendingPen && pendingPen.amount > 0);
  const penaltyApplied = appt?.penaltyApplied?.amount > 0;

  const dow = DOW[new Date(appt.dateKey + "T00:00:00").getDay()];
  const hours = salonHours[dow] || DEFAULT_SALON_HOURS[dow];

  return createPortal(
    <div style={modalBackdrop} onClick={onClose}>
      <div style={modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={modalHead}>
          <div style={{ fontWeight: 900 }}>
            {srvName} • {appt.dateKey}
          </div>
          <button onClick={onClose} style={iconBtn} title="Zatvori">
            <FiX />
          </button>
        </div>

        <div style={row}>
          <div style={ctlItem}>
            <label style={lbl}>Radnica</label>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
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
              <FiClock /> Početak
            </label>
            <input
              type="time"
              step={300}
              lang="sr-RS"
              min={hours.open}
              max={hours.close}
              value={startHHMM}
              onChange={(e) => setStartHHMM(e.target.value)}
              style={inp}
            />
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
              Trajanje: {duration} min • Kraj:{" "}
              {minToTime(timeToMin(startHHMM) + Number(duration || 0))}
            </div>
          </div>
        </div>

        <div style={row}>
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
          <div style={ctlItem}>
            <label style={lbl}>Cena</label>
            <input
              type="number"
              step={50}
              value={price}
              onChange={(e) => setPrice(Number(e.target.value || 0))}
              style={inp}
            />
          </div>
        </div>

        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {phoneN && noShowByPhone.get(phoneN) > 0 && (
              <div style={badgeNoShow}>
                <FiAlertTriangle style={{ marginRight: 6 }} />
                No-show istorija: {noShowByPhone.get(phoneN)}
              </div>
            )}
            {hasPendingPenalty && !penaltyApplied && (
              <div style={badgePenalty}>
                <FiInfo style={{ marginRight: 6 }} />
                Kazna za naplatu: {pendingPen.amount} RSD
              </div>
            )}
            {penaltyApplied && (
              <div style={badgePenalty}>
                <FiInfo style={{ marginRight: 6 }} />
                Kazna primenjena ({appt.penaltyApplied.amount} RSD)
              </div>
            )}
          </div>
        </div>

        <div style={{ ...btnRow, marginTop: 12 }}>
          <button
            style={primaryBtn}
            onClick={() =>
              onSave({
                employeeId,
                startHHMM,
                clientName: clientName.trim(),
                clientPhone: normPhone(clientPhone),
                price: Number(price || 0),
                color: appt.type === "booking" ? colorForServiceId(appt.serviceId) : undefined,
              })
            }
          >
            <FiSave style={{ marginRight: 6 }} />
            Sačuvaj izmene
          </button>

          {appt.type === "booking" && appt.status === "booked" && (
            <button style={dangerBtn} onClick={onNoShow} title="Označi kao no-show i upiši kaznu">
              <FiSlash style={{ marginRight: 6 }} />
              No-show
            </button>
          )}

          {appt.type === "booking" && (
            <button style={warnBtn} onClick={onCancel} title="Otkazivanje (pravilo 6h)">
              <FiAlertTriangle style={{ marginRight: 6 }} />
              Otkaži
            </button>
          )}

          <button style={ghostBtn} onClick={onDelete} title="Obriši termin">
            <FiTrash2 style={{ marginRight: 6 }} />
            Obriši
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* -------------------- helpers & stilovi -------------------- */

function normPhone(s) {
  if (!s) return "";
  // zadrži samo cifre
  let d = String(s).replace(/\D+/g, "");
  // srpski formati – normalizuj 06… u +3816…
  if (d.startsWith("06")) d = "381" + d.slice(1);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return d;
}

// vremenska osa
function timeMarks(openMin, closeMin) {
  const res = [];
  const startH = Math.ceil(openMin / 60);
  const endH = Math.floor(closeMin / 60);
  for (let h = startH; h <= endH; h++) res.push(h * 60);
  return res;
}
const PX_PER_MIN = 2; // visina ćelije
const gridHeight = (totalMin) => Math.max(200, totalMin * PX_PER_MIN);
const pxFromMin = (min) => min * PX_PER_MIN;

// STILOVI (inline objects + responsive CSS)

const wrap = {
  padding: 12,
  minHeight: "100dvh",
  background: "#0b0b0f",
  backgroundImage:
    "radial-gradient(1000px 600px at 10% -10%, rgba(255,96,150,.20), transparent 60%), radial-gradient(800px 500px at 110% 10%, rgba(255,200,230,.18), transparent 60%)",
};

const panel = {
  maxWidth: 1200,
  margin: "0 auto",
  background: "rgba(255,255,255,.06)",
  border: "1px solid rgba(255,255,255,.18)",
  borderRadius: 18,
  padding: 12,
  boxShadow: "0 10px 30px rgba(0,0,0,.35)",
};

const tabbar = {
  display: "flex",
  gap: 8,
  marginBottom: 10,
};

const baseBtn = {
  padding: "10px 16px",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,.35)",
  cursor: "pointer",
  fontWeight: 800,
  whiteSpace: "nowrap",
};

const tabBtn = {
  ...baseBtn,
  background: "rgba(255,255,255,.14)",
  color: "#000",
};

const tabBtnActive = {
  ...baseBtn,
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  color: "#fff",
};

const ctlWrap = {
  marginTop: 6,
  background: "rgba(255,255,255,.08)",
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 16,
  padding: 10,
};

const ctlRowA = {
  display: "grid",
  gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
  gap: 10,
};

const ctlItem = { display: "flex", flexDirection: "column", gap: 6 };
const lbl = { color: "#fff", fontWeight: 800, fontSize: 12, letterSpacing: 0.2 };
const inp = {
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,.25)",
  background: "#fff",
  color: "#000",
  fontWeight: 600,
};

const segWrap = { display: "flex", gap: 6 };
const segBtn = (active) => ({
  ...baseBtn,
  background: active ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "#fff",
  color: active ? "#fff" : "#000",
  padding: "8px 12px",
});

const primaryBtn = {
  ...baseBtn,
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  color: "#fff",
};

const warnBtn = { ...baseBtn, background: "linear-gradient(135deg,#ffd88a,#ffc04d)", color: "#000" };
const dangerBtn = { ...baseBtn, background: "linear-gradient(135deg,#ff9aa2,#ff5f6d)", color: "#fff" };
const ghostBtn = { ...baseBtn, background: "rgba(255,255,255,.12)", color: "#000" };
const btnRow = { display: "flex", gap: 8, flexWrap: "wrap" };

const monthWrap = {
  background: "rgba(255,255,255,.08)",
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 16,
  padding: 10,
  marginTop: 6,
};

const row = { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 };

const stripWrap = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: 6,
  flex: 1,
};
const stripBtn = (sel, compact) => ({
  ...baseBtn,
  borderRadius: 12,
  padding: compact ? "6px 8px" : "10px 12px",
  background: sel ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "#fff",
  color: sel ? "#fff" : "#000",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
});

const gridWrap = {
  display: "flex",
  gap: 8,
  alignItems: "stretch",
  marginTop: 10,
};

const timeAxis = {
  flex: "0 0 64px",
  display: "flex",
  flexDirection: "column",
  gap: 0,
  position: "relative",
  borderRight: "1px solid rgba(255,255,255,.25)",
  paddingRight: 6,
};
const markRow = {
  position: "relative",
  height: pxFromMin(60),
  borderTop: "1px dashed rgba(255,255,255,.15)",
};
const markLbl = { position: "absolute", top: -8, right: 6, fontSize: 12, color: "#fff", opacity: 0.85 };

const colsWrap = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px,1fr))", gap: 8, flex: 1 };

const colBox = {
  background: "rgba(255,255,255,.12)",
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 16,
  overflow: "hidden",
};
const colHeader = {
  padding: "8px 10px",
  fontWeight: 900,
  color: "#000",
  background: "linear-gradient(135deg,#ffffff,#eaf5ff)",
  borderBottom: "1px solid rgba(0,0,0,.06)",
};
const colBody = { position: "relative", padding: 6 };

const apptCard = (top, height, bg, muted = false) => ({
  position: "absolute",
  left: 6,
  right: 6,
  top,
  height,
  background: bg,
  borderRadius: 12,
  border: "1px solid rgba(0,0,0,.15)",
  boxShadow: "0 6px 14px rgba(0,0,0,.25)",
  color: "#111",
  padding: 8,
  textAlign: "left",
  cursor: muted ? "default" : "pointer",
  opacity: muted ? 0.85 : 1,
});

const cardTitle = (isMobile) => ({
  fontWeight: 900,
  fontSize: isMobile ? 13 : 14,
  lineHeight: 1.1,
  marginBottom: 6,
  color: "#111",
});
const metaRow = { display: "flex", gap: 6, flexWrap: "wrap" };

const pill = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 8px",
  borderRadius: 999,
  background: "rgba(255,255,255,.85)",
  color: "#111",
  fontWeight: 700,
  fontSize: 12,
};
const pillLight = (isMobile) => ({
  ...pill,
  background: "rgba(255,255,255,.65)",
  fontSize: isMobile ? 11 : 12,
});

const badgeNoShow = {
  marginTop: 6,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 8px",
  borderRadius: 999,
  background: "#ffd2d7",
  color: "#6b000c",
  fontWeight: 800,
  fontSize: 12,
};
const badgePenalty = {
  marginTop: 6,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 8px",
  borderRadius: 999,
  background: "#fff3cd",
  color: "#5c3d00",
  fontWeight: 800,
  fontSize: 12,
};

const hoverHint = {
  position: "absolute",
  right: 8,
  bottom: 6,
  fontSize: 11,
  fontWeight: 800,
  background: "rgba(255,255,255,.8)",
  color: "#222",
  borderRadius: 8,
  padding: "2px 6px",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const dayChip = (active) => ({
  ...baseBtn,
  padding: "8px 10px",
  borderRadius: 10,
  background: active ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "#fff",
  color: active ? "#fff" : "#000",
});

const rosterGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: 8,
};
const rosterCell = {
  background: "rgba(255,255,255,.12)",
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 16,
  padding: 8,
};
const rosterCellHead = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  color: "#fff",
  marginBottom: 6,
};
const rosterRow = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "6px 0",
  borderBottom: "1px dashed rgba(255,255,255,.15)",
};
const rosterTimeOffRow = { ...rosterRow, background: "rgba(255,255,255,.06)", borderRadius: 8 };
const rosterEmp = { color: "#fff", fontWeight: 800 };
const rosterSegs = { display: "flex", gap: 6, flexWrap: "wrap" };
const pillWarn = { ...pill, background: "#fff0f0", color: "#7a0011" };
const emptyText = { color: "#fff", opacity: 0.8, fontStyle: "italic", padding: "6px 0" };

const rosterMobileBox = {
  background: "rgba(255,255,255,.10)",
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 16,
  padding: 10,
  marginTop: 8,
};
const rosterTitle = { color: "#fff", fontWeight: 900, marginBottom: 8 };

/* ---- modal ---- */

const modalBackdrop = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,.55)",
  display: "grid",
  placeItems: "center",
  zIndex: 1000,
};
const modalBox = {
  width: "min(680px, 92vw)",
  background: "linear-gradient(180deg, rgba(255,255,255,.96), rgba(255,255,255,.92))",
  color: "#111",
  borderRadius: 16,
  border: "1px solid rgba(0,0,0,.1)",
  boxShadow: "0 20px 60px rgba(0,0,0,.35)",
  padding: 12,
};
const modalHead = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 8,
};
const iconBtn = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  fontSize: 18,
};

/* ---- responsive CSS (ne menjaj JS objekte) ---- */
const responsiveCSS = `
@media (max-width: 900px) {
  .ctl-row-a {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .month-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .ctl-row-a {
    grid-template-columns: 1fr;
  }
  .month-row {
    grid-template-columns: 1fr;
  }
  .admincal button {
    font-size: 14px;
  }
}
`;
