// src/pages/AdminCalendar.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../firebase";
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
} from "firebase/firestore";
import {
  FiCalendar,
  FiUser,
  FiClock,
  FiAlertTriangle,
  FiSlash,
  FiTrash2,
  FiPlus,
  FiMove,
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

export default function AdminCalendar() {
  const [tab, setTab] = useState("day"); // 'day' | 'month' | 'schedule'

  // meta
  const [salonHours, setSalonHours] = useState(DEFAULT_SALON_HOURS);

  // collections
  const [employees, setEmployees] = useState([]);
  const [services, setServices] = useState([]);

  // day view
  const [dayDate, setDayDate] = useState(() => new Date());
  const [onlyWorking, setOnlyWorking] = useState(true);
  const [appointments, setAppointments] = useState([]);
  const [dayShifts, setDayShifts] = useState([]);

  // create (day): 'booking' | 'block'
  const [mode, setMode] = useState("booking");
  const [selEmpId, setSelEmpId] = useState("");
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
    return () => {
      offEmp();
      offSrv();
      offClients();
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
    const offA = onSnapshot(qAppts, (s) =>
      setAppointments(s.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
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
      where("type", "==", "booking")
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

  // defaults
  useEffect(() => {
    if (!selEmpId && employees.length) setSelEmpId(employees[0].id);
  }, [employees, selEmpId]);
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

  const employeeIdsForDay = useMemo(() => {
    if (!onlyWorking) return employees.map((e) => e.id);
    const ids = new Set(dayShifts.map((s) => s.employeeId));
    return employees.filter((e) => ids.has(e.id)).map((e) => e.id);
  }, [onlyWorking, employees, dayShifts]);

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

  const colorForServiceId = (id) =>
    servicesById.get(id)?.color || hashToColor(id || "block");

  async function addItem() {
    const dk = dateKey(dayDate);
    const empId = selEmpId;
    if (!empId) return alert("Odaberi radnicu.");

    let start = timeToMin(startTime);
    let end = start;

    let payload = {
      employeeId: empId,
      employeeName: employeesById.get(empId)?.name || "",
      dateKey: dk,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (mode === "booking") {
      const srv = servicesById.get(selSrvId);
      if (!srv) return alert("Odaberi uslugu.");
      end = start + Number(srv.durationMin || 0);
      Object.assign(payload, {
        type: "booking",
        status: "booked",
        startHHMM: minToTime(start),
        endHHMM: minToTime(end),
        startMin: start,
        endMin: end,
        serviceId: srv.id,
        serviceName: srv.name,
        durationMin: Number(srv.durationMin || 0),
        color: colorForServiceId(srv.id),
        clientName: clientName.trim(),
        clientPhone: clientPhone.trim(),
      });
    } else {
      end = timeToMin(endTime);
      Object.assign(payload, {
        type: "block",
        status: "blocked",
        startHHMM: minToTime(start),
        endHHMM: minToTime(end),
        startMin: start,
        endMin: end,
      });
    }

    if (!withinSalon(start, end)) return alert("Van radnog vremena salona.");
    if (!withinShift(empId, start, end)) return alert("Van smene radnice.");
    if (!noOverlap(empId, start, end)) return alert("Preklapanje sa postojećim.");

    await addDoc(collection(db, "appointments"), payload);
    if (mode === "booking") {
      setClientName("");
      setClientPhone("");
    }
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
    await markAppt(appt.id, { status: "noshow" });
    const phone = normPhone(appt.clientPhone);
    if (!phone) return;
    const cRef = doc(db, "clients", phone);
    const snap = await getDoc(cRef);
    const current = snap.exists() ? snap.data().noShowCount || 0 : 0;
    await setDoc(
      cRef,
      {
        phone,
        name: appt.clientName || "",
        noShowCount: current + 1,
        updatedAt: serverTimestamp(),
        createdAt: snap.exists() ? snap.data().createdAt || serverTimestamp() : serverTimestamp(),
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
    if (a.employeeId === empIdTarget) return; // no change
    // Check shift + overlap for target
    const segs = shiftsByEmp.get(empIdTarget) || [];
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

              <div style={ctlRowB} className="ctl-row-b">
                <label style={{ ...lbl, display: "flex", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={onlyWorking}
                    onChange={(e) => setOnlyWorking(e.target.checked)}
                  />
                  Prikaži samo radnice koje rade danas
                </label>
                <div style={{ color: "#fff", opacity: 0.9 }}>
                  {DOW_SR[dayDate.getDay()]} •{" "}
                  <b>
                    {dayHours.open}–{dayHours.close}
                  </b>
                </div>
              </div>
            </div>

            {/* GRID */}
            <DayGrid
              employees={employees}
              employeesById={employeesById}
              employeeIdsForDay={employeeIdsForDay}
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
            />
          </>
        ) : tab === "month" ? (
          <>
            {/* MONTH PLANNER + DAY STRIP + ROSTER */}
            <div style={monthWrap} className="month-wrap">
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

              <div style={{ ...row, alignItems: "center" }} className="month-row">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {DOW_SR.map((d, i) => (
                    <label key={d} style={dayChip(templateDays.has(i))}>
                      <input
                        type="checkbox"
                        checked={templateDays.has(i)}
                        onChange={(e) => {
                          const next = new Set(templateDays);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          setTemplateDays(next);
                        }}
                        style={{ display: "none" }}
                      />
                      {d}
                    </label>
                  ))}
                </div>

                <button
                  style={primaryBtn}
                  onClick={applyMonthTemplate}
                  disabled={busy}
                >
                  {busy ? "Upisujem…" : "Postavi smene za mesec"}
                </button>
              </div>

              {/* ODMOR: datum + trajanje dana */}
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
                  <div style={{ color: "#fff", opacity: 0.8, fontSize: 12 }}>
                    Blokira <b>celu smenu</b> radnice za svaki dan u rasponu.
                  </div>
                </div>
              </div>

              {/* NOVO: DayStrip za brzi pregled jednog dana u mesecu */}
              <DayStrip
                monthStr={monthAnchor}
                selectedKey={dateKey(new Date(vacStart + "T00:00:00"))}
                onPickDay={(key) => setVacStart(key)}
                compact
              />

              <MonthRoster
                monthStr={monthAnchor}
                shifts={monthShifts}
                breaks={[...timeOffs]}
                employeesById={employeesById}
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

              {/* NOVO: DayStrip umesto mini-meseca */}
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
              />
            </div>
          </>
        )}

        {/* Modal za termin */}
        {activeAppt && (
          <ApptModal
            appt={activeAppt}
            onClose={closeApptModal}
            employees={employees}
            servicesById={servicesById}
            employeesById={employeesById}
            salonHours={salonHours}
            shiftsByEmp={shiftsByEmp}
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
              await markAppt(activeAppt.id, { status: "cancelled" });
              setActiveAppt(null);
            }}
            onDelete={async () => {
              await deleteAppt(activeAppt.id);
              setActiveAppt(null);
            }}
            noShowByPhone={noShowByPhone}
          />
        )}
      </div>
    </div>
  );
}

/* -------------------- DayStrip (horizontal days) -------------------- */

function DayStrip({ monthStr, selectedKey, onPickDay, compact = false }) {
  const base = new Date(monthStr + "-01T00:00:00");
  const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const ref = useRef(null);

  useEffect(() => {
    // auto-scroll to selected
    if (!ref.current) return;
    const el = ref.current.querySelector(`[data-daykey="${selectedKey}"]`);
    if (el) {
      const { left, width } = el.getBoundingClientRect();
      const cont = ref.current.getBoundingClientRect();
      const delta = left + width / 2 - (cont.left + cont.width / 2);
      ref.current.scrollBy({ left: delta, behavior: "smooth" });
    }
  }, [selectedKey]);

  return (
    <div style={{ marginTop: 8 }} className="daystrip">
      <div style={stripWrap} ref={ref}>
        {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
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
              title={`Dan ${k}`}
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
}) {
  return (
    <div style={gridWrap} className="grid-day">
      <div style={{ ...timeAxis, height: gridHeight(closeMin - openMin) }}>
        {timeMarks(openMin, closeMin).map((t) => (
          <div key={t} style={markRow}>
            <span style={markLbl}>{minToTime(t)}</span>
          </div>
        ))}
      </div>

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
                      border: "1px dashed rgba(255,255,255,.25)",
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
                  const bg = isVacation
                    ? "repeating-linear-gradient(-45deg,#ffc6cf 0 10px,#ffadb9 10px 20px)"
                    : isBreak
                    ? "repeating-linear-gradient(-45deg,#ffd88a 0 10px,#ffcb66 10px 20px)"
                    : isBlock
                    ? "repeating-linear-gradient(-45deg,#c7c7c7 0 8px,#b9b9b9 8px 16px)"
                    : a.color || colorForServiceId(a.serviceId);

                  const phone = normPhone(a.clientPhone);
                  const hasNoShowHistory = !!(phone && noShowByPhone.get(phone));

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
                      style={{
                        position: "absolute",
                        left: 6,
                        right: 6,
                        top,
                        height,
                        background: bg,
                        borderRadius: 10,
                        boxShadow:
                          "0 10px 22px rgba(0,0,0,.18), inset 0 0 0 2px rgba(255,255,255,.35)",
                        color: "#222",
                        padding: 8,
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "space-between",
                        cursor:
                          isBreak || isBlock || isVacation ? "default" : "pointer",
                      }}
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
                      <div style={{ fontWeight: 800, fontSize: 13 }}>
                        {isVacation
                          ? "Odmor"
                          : isBreak
                          ? "Pauza"
                          : isBlock
                          ? "Blokirano"
                          : a.serviceName || "Usluga"}
                      </div>
                      <div style={{ fontSize: 12 }}>
                        {minToTime(a.startMin)}–{minToTime(a.endMin)}
                        {!isBreak &&
                          !isBlock &&
                          !isVacation &&
                          a.clientName &&
                          ` · ${a.clientName}`}
                      </div>

                      {!isBreak && !isBlock && !isVacation && hasNoShowHistory && (
                        <div style={badgeNoShow}>
                          <FiAlertTriangle style={{ marginRight: 6 }} />
                          No-show istorija
                        </div>
                      )}

                      {/* (Hover hint) */}
                      {hoverApptId === a.id && !isBreak && !isBlock && !isVacation && (
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
        <div style={{ ...timeAxis, height: gridHeight(closeMin - openMin) }}>
          {timeMarks(openMin, closeMin).map((t) => (
            <div key={t} style={markRow}>
              <span style={markLbl}>{minToTime(t)}</span>
            </div>
          ))}
        </div>

        <div
          style={{
            ...colBody,
            height: gridHeight(closeMin - openMin),
            position: "relative",
            background: "rgba(255,255,255,.12)",
            borderRadius: 16,
            border: "1px solid rgba(255,255,255,.25)",
          }}
        >
          {laid.map((a) => {
            const top = pxFromMin(a.startMin - openMin);
            const height = pxFromMin(a.endMin - a.startMin);
            const widthPct = 100 / (a.cols || 1);
            const leftPct = (a.lane || 0) * widthPct;
            const bg = a.color || colorForServiceId(a.serviceId) || "#fff";

            const empName = employeesById.get(a.employeeId)?.name || "—";
            const srv =
              servicesById.get(a.serviceId)?.name ||
              a.serviceName ||
              "Usluga";

            const phone = normPhone(a.clientPhone);
            const hasNoShowHistory = !!(phone && noShowByPhone.get(phone));

            return (
              <button
                key={a.id}
                onClick={() => onApptClick(a)}
                style={{
                  position: "absolute",
                  top,
                  left: `calc(${leftPct}% + 6px)`,
                  width: `calc(${widthPct}% - 12px)`,
                  height,
                  background: bg,
                  borderRadius: 10,
                  boxShadow:
                    "0 10px 22px rgba(0,0,0,.18), inset 0 0 0 2px rgba(255,255,255,.35)",
                  color: "#222",
                  padding: 8,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  cursor: "pointer",
                }}
                title={`${srv} • ${minToTime(a.startMin)}–${minToTime(
                  a.endMin
                )} • ${empName}`}
              >
                <div style={{ fontWeight: 900, fontSize: 13 }}>{srv}</div>
                <div style={{ fontSize: 12, opacity: 0.9 }}>
                  {minToTime(a.startMin)}–{minToTime(a.endMin)} · {empName}
                  {a.clientName ? ` · ${a.clientName}` : ""}
                </div>

                {hasNoShowHistory && (
                  <div style={badgeNoShow}>
                    <FiAlertTriangle style={{ marginRight: 6 }} />
                    No-show istorija
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

/* -------------------- Month Roster -------------------- */

function MonthRoster({ monthStr, shifts, breaks, employeesById }) {
  const base = new Date(monthStr + "-01T00:00:00");
  const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const startDow = new Date(base.getFullYear(), base.getMonth(), 1).getDay();

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

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);

  return (
    <div style={{ marginTop: 12 }}>
      <div style={calHeader}>
        {DOW_SR.map((d) => (
          <div key={d} style={calHeadCell}>
            {d}
          </div>
        ))}
      </div>
      <div style={calGrid}>
        {cells.map((d, i) => {
          if (!d) return <div key={i} style={calCell} />;
          const key = `${base.getFullYear()}-${pad2(
            base.getMonth() + 1
          )}-${pad2(d)}`;
          const empIds = Array.from(byDay.get(key) || []);
          const entries = empIds.map((id) => {
            const name = employeesById.get(id)?.name || "—";
            const offs = timeOffMap.get(`${key}|${id}`) || [];
            const firstBreak = offs.find((x) => x.type === "break");
            const hasVacation = offs.some((x) => x.type === "vacation");
            return {
              id,
              name,
              firstTime: firstBreak?.startHHMM,
              hasVacation,
              more: Math.max(
                0,
                offs.length - (firstBreak ? 1 : 0) - (hasVacation ? 1 : 0)
              ),
            };
          });

          return (
            <div key={i} style={calCell}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  width: "100%",
                }}
              >
                <span style={{ opacity: 0.9, fontWeight: 900 }}>{d}</span>
                {!!entries.length && (
                  <span style={{ opacity: 0.8, fontSize: 12 }}>
                    {entries.length} rad.
                  </span>
                )}
              </div>
              <div style={{ marginTop: 6, display: "grid", gap: 6, width: "100%" }}>
                {entries.slice(0, 6).map((n) => (
                  <span key={n.id} style={empPill}>
                    {n.name}
                    {n.hasVacation ? " 🏖" : ""}
                    {n.firstTime
                      ? ` ☕ ${n.firstTime}${n.more ? " +" + n.more : ""}`
                      : ""}
                  </span>
                ))}
                {entries.length > 6 && (
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

/* -------------------- Appointment Modal -------------------- */

function ApptModal({
  appt,
  onClose,
  employees,
  employeesById,
  servicesById,
  salonHours,
  shiftsByEmp,
  colorForServiceId,
  onSave,
  onNoShow,
  onCancel,
  onDelete,
  noShowByPhone,
}) {
  const [empId, setEmpId] = useState(appt.employeeId);
  const [start, setStart] = useState(appt.startHHMM);
  const phone = normPhone(appt.clientPhone);
  const hasNoShowHistory = !!(phone && noShowByPhone.get(phone));
  const srv = servicesById.get(appt.serviceId);
  const duration = appt.durationMin || srv?.durationMin || 0;

  const dow = DOW[new Date(appt.dateKey + "T00:00:00").getDay() ];
  const hours = salonHours[dow] || DEFAULT_SALON_HOURS[dow];

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
            <div style={{ color: "#fff", opacity: 0.8, fontSize: 12 }}>
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
            {hasNoShowHistory && (
              <div style={{ ...badge, background: "#ffe8ea", color: "#7a1b1b" }}>
                <FiAlertTriangle /> No-show istorija
              </div>
            )}
          </div>

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

        <div style={modalActions}>
          <button
            style={{ ...actionBtn, background: "#ffe1e1", color: "#7a1b1b" }}
            onClick={onDelete}
            title="Obriši termin"
          >
            <FiTrash2 /> Obriši
          </button>
          <div style={{ flex: 1 }} />
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
            style={{ ...actionBtn, background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)", color: "#fff" }}
            onClick={() => onSave({ employeeId: empId, startHHMM: start })}
            title="Sačuvaj izmene"
          >
            <FiSave /> Sačuvaj
          </button>
        </div>
      </div>
    </div>
  );
}


/* -------------------- UI helpers & styles -------------------- */

/* -------------------- UI helpers & styles -------------------- */

const normPhone = (s) =>
  String(s || "")
    .replace(/[^\d+]/g, "")
    .replace(/^00/, "+")
    .trim();

const pxFromMin = (min) => min * 2;
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
  border: "1px solid rgba(255,255,255,.35)",
  backdropFilter: "blur(10px)",
  borderRadius: 28,
  boxShadow: "0 24px 60px rgba(0,0,0,.25)",
  padding: "clamp(16px,3vw,24px)",
};

const tabbar = { display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" };
const tabBtn = {
  border: "1px solid rgba(255,255,255,.55)",
  borderRadius: 12,
  background: "transparent",
  color: "#fff",
  fontWeight: 800,
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
  border: "1px solid rgba(255,255,255,.2)",
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
  border: "1px solid #e8e8e8",
  background: "#fff",
  padding: "0 12px",
  fontSize: 14,
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
  border: "1px solid rgba(255,255,255,.35)",
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
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 16,
  overflow: "hidden",
};
const markRow = {
  height: pxFromMin(60), // na sat
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

const colsWrap = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 10,
};

const colBox = {
  background: "rgba(255,255,255,.12)",
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 16,
  overflow: "hidden",
  display: "grid",
  gridTemplateRows: "40px 1fr",
};

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
  fontSize: 12,
  fontWeight: 800,
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
  background: "rgba(255,255,255,.95)",
  color: "#000",
  fontSize: 11,
  boxShadow: "0 2px 10px rgba(0,0,0,.18)",
};

/* --- Month/Roster --- */
const monthWrap = {
  background: "rgba(0,0,0,.35)",
  borderRadius: 16,
  padding: 12,
  border: "1px solid rgba(255,255,255,.2)",
};

const row = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(160px, 1fr))",
  gap: 10,
  marginBottom: 10,
};

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

const calHeader = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: 8,
  marginTop: 12,
  color: "#fff",
  fontWeight: 900,
};
const calHeadCell = {
  textAlign: "center",
  background: "rgba(255,255,255,.15)",
  borderRadius: 10,
  padding: "6px 0",
  border: "1px solid rgba(255,255,255,.25)",
};
const calGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: 8,
  marginTop: 8,
};
const calCell = {
  minHeight: 120,
  background: "rgba(255,255,255,.12)",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,.25)",
  padding: 8,
  color: "#fff",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
};
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

/* --- Modal --- */
const modalBackdrop = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,.5)",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 999,
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
  fontSize: 12,
  fontWeight: 800,
};
const infoBox = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: 10,
  background: "#f7f7f7",
  borderRadius: 12,
  color: "#222",
  border: "1px solid #eee",
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

/* --- Responsive fine-tuning --- */
const responsiveCSS = `
/* --- MOBILE TUNE-UP --- */

.admincal :is(input, select, button) {
  font-size: 16px !important; /* iOS zoom fix */
}

@media (max-width: 1100px) {
  .grid-day, .grid-schedule { gap: 8px !important; }
  .daystrip .strip-btn { min-width: 64px !important; }
}

/* TABLETI */
@media (max-width: 900px) {
  /* KONTROLE (day tab) → 3 kolone */
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

/* TELEFONI */
@media (max-width: 640px) {
  /* Grid: vreme levo uže, desno 1 kolona */
  .grid-day, .grid-schedule {
    grid-template-columns: 64px 1fr !important;
    gap: 8px !important;
  }

  /* KONTROLE (day tab) → 2 kolone */
  .ctl .ctl-row-a {
    grid-template-columns: repeat(2, minmax(0,1fr)) !important;
  }

  .ctl .ctl-row-b { gap: 6px !important; }

  /* Month planner redovi → 2 kolone */
  .month-wrap .month-row {
    grid-template-columns: repeat(2, minmax(0,1fr)) !important;
  }

  /* DayStrip kompaktniji */
  .daystrip button {
    min-width: 58px !important;
    padding: 6px 6px !important;
    border-radius: 10px !important;
  }

  /* Inputi i selecti širina 100% */
  .admincal input,
  .admincal select {
    width: 100% !important;
  }

  /* Dugmad veća – touch friendly */
  .admincal button {
    min-height: 42px !important;
  }

  /* Manje margine unutar kolona */
  .admincal .grid-day > div:last-child > div,
  .admincal .grid-schedule > div:last-child {
    margin: 6px !important;
  }

  .admincal { --head-fz: 14px; }
}

/* VEOMA MALI TELEFONI */
@media (max-width: 420px) {
  /* KONTROLE (day tab) → 1 kolona */
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
`;
