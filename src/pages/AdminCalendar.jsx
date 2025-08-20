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
  getDocs,
  runTransaction,
  writeBatch,
  increment,
} from "firebase/firestore";

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

const normPhone = (p) =>
  String(p || "")
    .replace(/[^\d+]/g, "")
    .replace(/^00/, "+")
    .replace(/^0(6\d+)/, "+381$1")
    .trim();

const pxFromMin = (min) => min * 3.5;
const gridHeight = (m) => pxFromMin(m);
const timeMarks = (open, close) => {
  const arr = [];
  for (let m = open; m <= close; m += 60) arr.push(m);
  return arr;
};

/* -------------------- component -------------------- */

// ✳ Najraniji termin – helper
async function applyPendingToEarliestAppt(db, phone, amount) {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${pad2(
    today.getMonth() + 1
  )}-${pad2(today.getDate())}`;

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
  if (!first) return; // nema budućih — ostaje pending

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

// Jedinstvena pozadina po tipu
const apptBgFor = (a, colorForServiceId) => {
  return a.type === "vacation"
    ? "repeating-linear-gradient(-45deg,#ffc6cf 0 10px,#ffadb9 10px 20px)"
    : a.type === "break"
    ? "repeating-linear-gradient(-45deg,#ffd88a 0 10px,#ffcb66 10px 20px)"
    : a.type === "block"
    ? "repeating-linear-gradient(-45deg,#cfcfcf 0 8px,#bdbdbd 8px 16px)"
    : colorForServiceId(a.serviceId) || "#ffffff";
};

// 50% kazne od cene termina
function computePenaltyAmountFromAppt(appt, servicesById) {
  const srvPrice = servicesById.get(appt.serviceId)?.price;
  const basePrice = Number(appt.price ?? srvPrice ?? 0);
  return Math.round(basePrice * 0.5);
}

// NO-SHOW logika
async function markNoShowWithClient(appt, servicesById) {
  if (!appt?.id) return;

  // Označi termin kao no-show
  await updateDoc(doc(db, "appointments", appt.id), {
    status: "noshow",
    noshowAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const phone = normPhone(appt.clientPhone);
  if (!phone) return;

  const cRef = doc(db, "clients", phone);

  // Uvećaj noShowCount i postavi pending kaznu ako već ne postoji
  const createdAmount = await runTransaction(db, async (tx) => {
    const snap = await tx.get(cRef);
    const data = snap.exists() ? snap.data() : {};

    const hasActivePenalty =
      data.pendingPenalty && Number(data.pendingPenalty.amount || 0) > 0;

    const updates = {
      phone,
      name: appt.clientName || "",
      updatedAt: serverTimestamp(),
      noShowCount: increment(1),
    };

    let amountToCreate = 0;
    if (!hasActivePenalty) {
      amountToCreate = computePenaltyAmountFromAppt(appt, servicesById);
      updates.pendingPenalty = {
        amount: amountToCreate,
        sourceApptId: appt.id,
        sourceService: appt.serviceName || "",
        createdAt: serverTimestamp(),
      };
    }

    if (!snap.exists()) {
      updates.createdAt = serverTimestamp();
    } else if (!data.createdAt) {
      updates.createdAt = serverTimestamp();
    }

    tx.set(cRef, updates, { merge: true });
    return amountToCreate;
  });

  if (createdAmount > 0) {
    await applyPendingToEarliestAppt(db, phone, createdAmount);
  }
}

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

  // single-day shift
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

  // live month data
  const [monthShifts, setMonthShifts] = useState([]);
  const [monthBreaksB, setMonthBreaksB] = useState([]);
  const [monthVacations, setMonthVacations] = useState([]);
  const timeOffs = useMemo(
    () => [...monthBreaksB, ...monthVacations],
    [monthBreaksB, monthVacations]
  );

  // schedule tab
  const [schedDate, setSchedDate] = useState(() => new Date());
  const [schedAppts, setSchedAppts] = useState([]);

  // clients markers
  const [noShowByPhone, setNoShowByPhone] = useState(new Map());
  const [pendingPenaltyByPhone, setPendingPenaltyByPhone] = useState(new Map());
  const [firstUpcomingApptIdByPhone, setFirstUpcomingApptIdByPhone] =
    useState(new Map());

  // mobile detect
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const handler = (e) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    try {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    } catch {
      mq.addListener(handler);
      return () => mq.removeListener(handler);
    }
  }, []);

  /* ------------ helpers za template dane ------------ */
  const toggleTplDay = (idx) => {
    setTemplateDays((prev) => {
      const s = new Set(prev);
      if (s.has(idx)) s.delete(idx);
      else s.add(idx);
      return s;
    });
  };
  const pickWorkdays = () => setTemplateDays(new Set([1, 2, 3, 4, 5]));
  const pickAllDays = () => setTemplateDays(new Set([0, 1, 2, 3, 4, 5, 6]));
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

    // no-show istorija
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

    // pending kazne
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

  // daily listeners
  useEffect(() => {
    const dk = dateKey(dayDate);
    const qShifts = query(collection(db, "shifts"), where("dateKey", "==", dk));
    const qAppts = query(
      collection(db, "appointments"),
      where("dateKey", "==", dk)
    );

    const offA = onSnapshot(qAppts, (s) => {
      const all = s.docs.map((d) => ({ id: d.id, ...d.data() }));
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

  // month snapshots
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

  // schedule tab: booked termini
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

  // Najraniji budući termini po telefonu
  useEffect(() => {
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${pad2(
      today.getMonth() + 1
    )}-${pad2(today.getDate())}`;
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

  const workingTodayIds = useMemo(() => {
    const ids = new Set(dayShifts.map((s) => s.employeeId));
    return employees.filter((e) => ids.has(e.id)).map((e) => e.id);
  }, [employees, dayShifts]);

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

  // Otkaži sa pravilom (<6h => pending kazna)
  async function cancelApptWithRule(appt) {
    if (!appt?.id) return;

    await updateDoc(doc(db, "appointments", appt.id), {
      status: "cancelled",
      cancelledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const apptDate = new Date(`${appt.dateKey}T${appt.startHHMM || "00:00"}`);
    const diffHours = (apptDate.getTime() - Date.now()) / 36e5;

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

        const sh = salonHours[DOW[dowIdx]] || DEFAULT_SALON_HOURS[DOW[dowIdx]];
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

  // Vacation: blocks existing shift per day
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

  /* ------------ drag & drop ------------ */

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

  /* ------------ modal ------------ */

  const [hoverApptId, setHoverApptId] = useState(null);
  const [activeAppt, setActiveAppt] = useState(null);

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

                {/* Režim */}
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
            />
          </>
        ) : tab === "month" ? (
          <>
            {/* MONTH */}
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

              {/* RED 3: smena za jedan dan */}
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
              colorForServiceId={colorForServiceId}
              onSave={async (patch) => {
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
                await markNoShowWithClient(activeAppt, servicesById);
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

/* -------------------- DayStrip -------------------- */

function DayStrip({ monthStr, selectedKey, onPickDay, compact = false, chunkSize = 7 }) {
  const base = new Date(monthStr + "-01T00:00:00");
  const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const selDay = selectedKey ? new Date(selectedKey + "T00:00:00").getDate() : 1;
  const [page, setPage] = useState(Math.floor((selDay - 1) / chunkSize));

  useEffect(() => {
    const newPage = Math.floor((selDay - 1) / chunkSize);
    if (newPage !== page) setPage(newPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selDay, chunkSize]);

  const startDay = page * chunkSize + 1;
  const endDay = Math.min(startDay + chunkSize - 1, days);

  return (
    <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>◀</button>
      <div style={stripWrap}>
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
}) {
  return (
    <div style={gridWrap} className="grid-day">
      {!isMobile && (
        <div className="time-axis" style={{ ...timeAxis, height: gridHeight(closeMin - openMin) }}>
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
          const appts = (appointments || []).filter((a) => a.employeeId === empId);

          return (
            <div
              key={empId}
              style={colBox}
              onDragOver={onColDragOver}
              onDrop={onColDrop(empId)}
            >
              <div style={colHeader}>{emp?.name || "—"}</div>
              <div style={{ ...colBody, height: gridHeight(closeMin - openMin) }}>
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
                                
                      border: "1px dashed rgba(0,0,0,.15)",
                      borderRadius: 10,
                      boxShadow: "inset 0 1px 2px rgba(0,0,0,.06)",
                    }}
                  />
                ))}

                {appts.map((a) => {
                  const top = pxFromMin((a.startMin ?? timeToMin(a.startHHMM)) - openMin);
                  const height = pxFromMin((a.endMin ?? timeToMin(a.endHHMM)) - (a.startMin ?? timeToMin(a.startHHMM)));
                  const isHover = hoverApptId === a.id;

                  const phoneN = normPhone(a.clientPhone);
                  const hasNoShows = phoneN && noShowByPhone.get(phoneN) > 0;
                  const pending = phoneN && pendingPenaltyByPhone.get(phoneN);
                  const isEarliest = phoneN && earliestApptIdByPhone.get(phoneN) === a.id;

                  const bg = apptBgFor(a, colorForServiceId);
                  const showGrip = a.type === "booking" && a.status === "booked";

                  return (
                    <div
                      key={a.id}
                      draggable={showGrip}
                      onDragStart={onApptDragStart(a)}
                      onMouseEnter={() => setHoverApptId(a.id)}
                      onMouseLeave={() => setHoverApptId(null)}
                      onClick={() => onApptClick(a)}
                      style={{
                        position: "absolute",
                        left: 4,
                        right: 4,
                        top,
                        height: Math.max(height, 28),
                        borderRadius: 12,
                        background: bg,
                        border: "1px solid rgba(0,0,0,.12)",
                        boxShadow: isHover
                          ? "0 8px 20px rgba(0,0,0,.25)"
                          : "0 2px 8px rgba(0,0,0,.15)",
                        cursor: "pointer",
                        padding: 8,
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "space-between",
                        userSelect: "none",
                      }}
                      title={`${a.startHHMM}–${a.endHHMM} ${a.serviceName || a.type}`}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {showGrip && (
                          <span
                            style={{
                              fontSize: 16,
                              lineHeight: "12px",
                              opacity: 0.6,
                              cursor: "grab",
                            }}
                          >
                            ⋮⋮
                          </span>
                        )}
                        <div style={{ fontWeight: 900, fontSize: 13 }}>
                          {a.startHHMM}–{a.endHHMM}
                        </div>
                        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                          {hasNoShows && (
                            <span style={pill("#111", "#ffd4d4")} title="No-show ranije">
                              No-show
                            </span>
                          )}
                          {pending && isEarliest && (
                            <span style={pill("#111", "#ffe9b5")} title="Kazna se primenjuje na ovaj termin">
                              Kazna {pending.amount} RSD
                            </span>
                          )}
                          {a.status === "cancelled" && (
                            <span style={pill("#fff", "#c0392b")} title="Otkazano">
                              Otkazano
                            </span>
                          )}
                          {a.status === "noshow" && (
                            <span style={pill("#fff", "#e67e22")} title="No-show">
                              No-show
                            </span>
                          )}
                          {a.type === "block" && (
                            <span style={pill("#111", "#dcdcdc")} title="Blokirano">
                              Blok
                            </span>
                          )}
                          {a.type === "vacation" && (
                            <span style={pill("#111", "#ffc6cf")} title="Odmor">
                              Odmor
                            </span>
                          )}
                        </div>
                      </div>

                      <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4 }}>
                        {a.type === "booking" ? (a.serviceName || "Termin") : (a.type.toUpperCase())}
                      </div>
                      {a.clientName && (
                        <div style={{ fontSize: 12, opacity: 0.9 }}>
                          {a.clientName} {a.clientPhone ? `• ${a.clientPhone}` : ""}
                        </div>
                      )}
                    </div>
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

/* -------------------- Schedule grid (lista termina u danu) -------------------- */

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
  const dk = dateKey(dateObj);
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 8 }}>
        {`Raspored za ${dk}`}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "160px 1fr 1fr 1fr", gap: 8 }}>
        {!isMobile && (
          <div style={headCell}>Vreme</div>
        )}
        {!isMobile && <div style={headCell}>Usluga</div>}
        {!isMobile && <div style={headCell}>Klijent</div>}
        {!isMobile && <div style={headCell}>Radnica</div>}

        {appts.map((a) => {
          const phoneN = normPhone(a.clientPhone);
          const pending = phoneN && pendingPenaltyByPhone.get(phoneN);
          const isEarliest = phoneN && earliestApptIdByPhone.get(phoneN) === a.id;
          const hasNoShows = phoneN && noShowByPhone.get(phoneN) > 0;

          const row = (
            <>
              <div style={cellStrong}>
                {a.startHHMM}–{a.endHHMM}
              </div>
              <div style={cell}>
                <div style={{ fontWeight: 800 }}>{a.serviceName}</div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>{servicesById.get(a.serviceId)?.durationMin} min</div>
              </div>
              <div style={cell}>
                <div style={{ fontWeight: 700 }}>{a.clientName || "—"}</div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>{a.clientPhone || "—"}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  {hasNoShows && <span style={pill("#111", "#ffd4d4")}>No-show istorija</span>}
                  {pending && isEarliest && (
                    <span style={pill("#111", "#ffe9b5")}>Kazna {pending.amount} RSD</span>
                  )}
                </div>
              </div>
              <div style={cell}>
                {employeesById.get(a.employeeId)?.name || "—"}
              </div>
            </>
          );

          return (
            <div
              key={a.id}
              onClick={() => onApptClick(a)}
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "160px 1fr 1fr 1fr",
                gap: 8,
                padding: 10,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,.12)",
                background: colorForServiceId(a.serviceId),
                cursor: "pointer",
              }}
            >
              {row}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------- Month roster window (pregled smena i odsustava) -------------------- */

function MonthRosterWindow({ monthStr, shifts, breaks, employeesById, isMobile }) {
  const base = new Date(monthStr + "-01T00:00:00");
  const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();

  const byDay = new Map();
  for (let d = 1; d <= days; d++) {
    byDay.set(d, { shifts: [], breaks: [] });
  }
  shifts.forEach((s) => {
    const dd = new Date(s.dateKey + "T00:00:00").getDate();
    byDay.get(dd)?.shifts.push(s);
  });
  breaks.forEach((b) => {
    const dd = new Date(b.dateKey + "T00:00:00").getDate();
    byDay.get(dd)?.breaks.push(b);
  });

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 6 }}>
        Pregled smena ({monthStr})
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(7, 1fr)",
          gap: 8,
        }}
      >
        {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
          const info = byDay.get(d) || { shifts: [], breaks: [] };
          return (
            <div
              key={d}
              style={{
                border: "1px solid rgba(0,0,0,.12)",
                borderRadius: 10,
                padding: 8,
                background: "#fff",
                minHeight: 80,
              }}
            >
              <div style={{ fontWeight: 900, marginBottom: 6 }}>
                {DOW_SR[new Date(base.getFullYear(), base.getMonth(), d).getDay()]} {pad2(d)}.
              </div>
              {info.shifts.length === 0 && (
                <div style={{ fontSize: 12, opacity: 0.6 }}>Nema smena</div>
              )}
              {info.shifts.map((s) => (
                <div key={s.employeeId + s.dateKey} style={{ fontSize: 12, marginBottom: 4 }}>
                  <b>{employeesById.get(s.employeeId)?.name || "—"}</b>{" "}
                  {(s.segments || []).map((seg, idx) => (
                    <span key={idx}>
                      {seg.start}–{seg.end}
                      {idx < (s.segments?.length || 0) - 1 ? ", " : ""}
                    </span>
                  ))}
                </div>
              ))}
              {info.breaks.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                  {info.breaks.length} blok/odmor
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------- Modal za termin -------------------- */

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
  const [startHHMM, setStartHHMM] = useState(appt.startHHMM);
  const [employeeId, setEmployeeId] = useState(appt.employeeId);

  const srv = servicesById.get(appt.serviceId);
  const duration = appt.durationMin || srv?.durationMin || 0;

  const phoneN = normPhone(appt.clientPhone);
  const pending = phoneN && pendingPenaltyByPhone.get(phoneN);
  const hasNoShows = phoneN && noShowByPhone.get(phoneN) > 0;

  const dow = DOW[new Date(appt.dateKey + "T00:00:00").getDay()];
  const hours = salonHours[dow] || DEFAULT_SALON_HOURS[dow];

  return (
    <div style={modalWrap}>
      <div style={modalCard}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>Termin</div>
          <button onClick={onClose} style={iconBtn} aria-label="Zatvori">
            <FiX />
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>Vreme početka</div>
            <input
              type="time"
              step={300}
              min={hours.open}
              max={hours.close}
              value={startHHMM}
              onChange={(e) => setStartHHMM(e.target.value)}
              style={inp}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>Radnica</div>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={inp}>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ padding: 10, borderRadius: 10, border: "1px solid rgba(0,0,0,.12)", background: colorForServiceId(appt.serviceId) }}>
            <div style={{ fontWeight: 800 }}>{appt.serviceName}</div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              {duration} min • {employeesById.get(employeeId)?.name || "—"}
            </div>
          </div>
          <div style={{ padding: 10, borderRadius: 10, border: "1px solid rgba(0,0,0,.12)", background: "#fff" }}>
            <div style={{ fontWeight: 800 }}>{appt.clientName || "—"}</div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>{appt.clientPhone || "—"}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {hasNoShows && <span style={pill("#111", "#ffd4d4")}>No-show istorija</span>}
              {pending && <span style={pill("#111", "#ffe9b5")}>Pending kazna {pending.amount} RSD</span>}
              {appt.penaltyApplied?.amount > 0 && (
                <span style={pill("#111", "#d6ffcf")}>Kazna primenjena: {appt.penaltyApplied.amount} RSD</span>
              )}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => onSave({ startHHMM, employeeId })} style={primaryBtn}>
            <FiSave style={{ marginRight: 6 }} /> Sačuvaj izmene
          </button>
          <button onClick={onNoShow} style={warnBtn}>
            <FiAlertTriangle style={{ marginRight: 6 }} /> No-show
          </button>
          <button onClick={onCancel} style={ghostBtn}>
            <FiSlash style={{ marginRight: 6 }} /> Otkaži
          </button>
          <button onClick={onDelete} style={dangerBtn}>
            <FiTrash2 style={{ marginRight: 6 }} /> Obriši
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------- Styles -------------------- */

const wrap = {
  padding: 12,
  background:
    "radial-gradient(1200px 800px at 0% 0%, #fef6ff, #fff), radial-gradient(1000px 600px at 100% 0%, #eef7ff, transparent)",
  minHeight: "100vh",
};
const panel = {
  maxWidth: 1280,
  margin: "0 auto",
};

const tabbar = {
  display: "flex",
  gap: 8,
  marginBottom: 10,
  marginTop: 6,
};
const tabBtn = {
  padding: "8px 14px",
  borderRadius: 12,
  border: "1px solid rgba(0,0,0,.12)",
  background: "#fff",
  fontWeight: 800,
  cursor: "pointer",
};
const tabBtnActive = {
  ...tabBtn,
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  color: "#fff",
  borderColor: "transparent",
};

const ctlWrap = {
  background: "#fff",
  border: "1px solid rgba(0,0,0,.12)",
  borderRadius: 14,
  padding: 10,
  marginTop: 6,
};
const ctlRowA = {
  display: "grid",
  gridTemplateColumns: "repeat(6, minmax(0,1fr))",
  gap: 10,
};
const ctlItem = { display: "flex", flexDirection: "column", gap: 6 };
const lbl = { fontSize: 12, fontWeight: 800, opacity: 0.8, display: "flex", gap: 6, alignItems: "center" };
const inp = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(0,0,0,.15)",
  background: "#fff",
  outline: "none",
};
const segWrap = { display: "flex", gap: 6 };
const segBtn = (active) => ({
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid rgba(0,0,0,.12)",
  background: active ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "#fff",
  color: active ? "#fff" : "#000",
  fontWeight: 800,
  cursor: "pointer",
});
const primaryBtn = {
  padding: "10px 14px",
  borderRadius: 12,
  border: "none",
  background: "linear-gradient(135deg,#5f9cff,#8bc3ff)",
  color: "#000",
  fontWeight: 900,
  cursor: "pointer",
  boxShadow: "0 2px 8px rgba(0,0,0,.1)",
};

const monthWrap = { ...ctlWrap, marginTop: 12 };
const row = { display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10, marginBottom: 10 };
const dayChip = (on) => ({
  padding: "8px 12px",
  borderRadius: 999,
  border: "1px solid rgba(0,0,0,.12)",
  background: on ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "#fff",
  color: on ? "#fff" : "#000",
  fontWeight: 800,
  cursor: "pointer",
});
const btnRow = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };

const stripWrap = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: 8,
  flex: 1,
};
const stripBtn = (sel, compact) => ({
  padding: compact ? "6px 8px" : "10px 12px",
  borderRadius: 12,
  border: "1px solid rgba(0,0,0,.12)",
  background: sel ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "#fff",
  color: sel ? "#fff" : "#000",
  fontWeight: 800,
  cursor: "pointer",
});

const gridWrap = {
  marginTop: 10,
  display: "grid",
  gridTemplateColumns: "80px 1fr",
  gap: 8,
};
const timeAxis = {
  background: "#fff",
  border: "1px solid rgba(0,0,0,.12)",
  borderRadius: 12,
  paddingTop: 8,
  position: "relative",
};
const markRow = {
  height: pxFromMin(60),
  borderTop: "1px dashed rgba(0,0,0,.08)",
  position: "relative",
};
const markLbl = {
  position: "absolute",
  top: -8,
  right: 6,
  fontSize: 12,
  opacity: 0.7,
};
const colsWrap = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
  gap: 8,
};
const colBox = {
  background: "#fff",
  border: "1px solid rgba(0,0,0,.12)",
  borderRadius: 12,
  overflow: "hidden",
};
const colHeader = {
  padding: "8px 10px",
  fontWeight: 900,
  background: "linear-gradient(135deg,#ffffff,#eaf5ff)",
  borderBottom: "1px solid rgba(0,0,0,.08)",
};
const colBody = {
  position: "relative",
  background:
    "repeating-linear-gradient(180deg, rgba(0,0,0,.02) 0 20px, rgba(0,0,0,.04) 20px 21px)",
};

const headCell = { fontWeight: 800, fontSize: 12, opacity: 0.8 };
const cell = { fontSize: 14 };
const cellStrong = { ...cell, fontWeight: 900 };

const modalWrap = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const modalCard = {
  width: "min(680px, 92vw)",
  background: "#fff",
  borderRadius: 16,
  border: "1px solid rgba(0,0,0,.12)",
  boxShadow: "0 20px 60px rgba(0,0,0,.35)",
  padding: 14,
};
const iconBtn = {
  border: "none",
  background: "transparent",
  fontSize: 20,
  cursor: "pointer",
};

const warnBtn = {
  padding: "10px 14px",
  borderRadius: 12,
  border: "1px solid #e67e22",
  background: "#fff7ec",
  color: "#b04b00",
  fontWeight: 900,
  cursor: "pointer",
};
const ghostBtn = {
  padding: "10px 14px",
  borderRadius: 12,
  border: "1px solid rgba(0,0,0,.12)",
  background: "#fff",
  fontWeight: 900,
  cursor: "pointer",
};
const dangerBtn = {
  padding: "10px 14px",
  borderRadius: 12,
  border: "1px solid #c0392b",
  background: "#ffeaea",
  color: "#8e1b10",
  fontWeight: 900,
  cursor: "pointer",
};

function pill(fg, bg) {
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 900,
    color: fg,
    background: bg,
    border: "1px solid rgba(0,0,0,.08)",
  };
}

const responsiveCSS = `
/* Mobilne prilagodbe */
@media (max-width: 1024px) {
  .ctl-row-a {
    grid-template-columns: repeat(2, minmax(0,1fr));
  }
}
@media (max-width: 640px) {
  .ctl-row-a {
    grid-template-columns: 1fr;
  }
  .month-row {
    grid-template-columns: 1fr;
  }
  .grid-day {
    grid-template-columns: 1fr;
  }
  .time-axis { display: none !important; }
}
`;
