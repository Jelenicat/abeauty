// src/pages/AdminCalendar.jsx
import React, { useEffect, useMemo, useState } from "react";
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
const timeToMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x || 0, 10));
  return (h || 0) * 60 + (m || 0);
};
const minToTime = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function hashToColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return hslToHex(hue, 65, 72);
}
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (0 <= h && h < 60) [r, g, b] = [c, x, 0];
  else if (60 <= h && h < 120) [r, g, b] = [x, c, 0];
  else if (120 <= h && h < 180) [r, g, b] = [0, c, x];
  else if (180 <= h && h < 240) [r, g, b] = [0, x, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v) => pad2(Math.round((v + m) * 255).toString(16));
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
const overlaps = (aStart, aEnd, bStart, bEnd) =>
  Math.max(aStart, bStart) < Math.min(aEnd, bEnd);

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
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  });
  const [monthEmpId, setMonthEmpId] = useState("");
  const [templateDays, setTemplateDays] = useState(new Set([1, 2, 3, 4, 5]));
  const [tplStart, setTplStart] = useState("09:00");
  const [tplEnd, setTplEnd] = useState("17:00");
  const [busy, setBusy] = useState(false);

  // ODmor: POČETAK (datum) + TRAJANJE (dana)
  const [vacStart, setVacStart] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
  });
  const [vacDays, setVacDays] = useState(1);
  const [busyVac, setBusyVac] = useState(false);

  // live month data to render roster
  const [monthShifts, setMonthShifts] = useState([]);
  const [monthBreaksB, setMonthBreaksB] = useState([]);     // type === "break"
  const [monthVacations, setMonthVacations] = useState([]); // type === "vacation"
  const timeOffs = useMemo(
    () => [...monthBreaksB, ...monthVacations],
    [monthBreaksB, monthVacations]
  );

  // RASPORED (tab): izabrani dan + termini za taj dan
  const [schedDate, setSchedDate] = useState(() => new Date());
  const [schedAppts, setSchedAppts] = useState([]);

  const [hoverApptId, setHoverApptId] = useState(null);

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
    return () => {
      offEmp();
      offSrv();
    };
  }, []);

  useEffect(() => {
    setVacStart(`${monthAnchor}-01`);
  }, [monthAnchor]);

  // daily listeners (day tab)
  useEffect(() => {
    const dk = dateKey(dayDate);
    const qShifts = query(collection(db, "shifts"), where("dateKey", "==", dk));
    const qAppts = query(collection(db, "appointments"), where("dateKey", "==", dk));
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

  // schedule tab: termini (booking) za izabrani dan
  useEffect(() => {
    const dk = dateKey(schedDate);
    const q = query(
      collection(db, "appointments"),
      where("dateKey", "==", dk),
      where("type", "==", "booking")
    );
    const off = onSnapshot(q, (s) =>
      setSchedAppts(
        s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.startMin || 0) - (b.startMin || 0))
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
    for (const [, arr] of m) arr.sort((a, b) => (a.startMin || 0) - (b.startMin || 0));
    return m;
  }, [appointments]);

  /* ------------ validations & actions (day) ------------ */

  const withinSalon = (s, e) => s >= openMin && e <= closeMin && e > s;
  const withinShift = (empId, s, e) =>
    (shiftsByEmp.get(empId) || []).some((seg) => s >= seg.start && e <= seg.end);
  const noOverlap = (empId, s, e) =>
    !(apptsByEmp.get(empId) || []).some((a) => overlaps(s, e, a.startMin, a.endMin));

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
    await updateDoc(doc(db, "appointments", id), { ...patch, updatedAt: serverTimestamp() });
  }
  async function deleteAppt(id) {
    if (!confirm("Obrisati stavku?")) return;
    await deleteDoc(doc(db, "appointments", id));
  }

  /* ------------ actions (month) ------------ */

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

  // Odmor: po datumu početka + broju dana — blokira celu smenu
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
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
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

  /* ------------ render ------------ */

  return (
    <div style={wrap}>
      <div style={panel}>
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
            <div style={ctlWrap}>
              <div style={ctlRowA}>
                <div style={ctlItem}>
                  <label style={lbl}><FiCalendar /> Datum</label>
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
                  <label style={lbl}><FiUser /> Radnica</label>
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
                  <label style={lbl}><FiClock /> Početak</label>
                  <input
                    type="time"
                    step="300"
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

              <div style={ctlRowB}>
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
              markAppt={markAppt}
              deleteAppt={deleteAppt}
            />
          </>
        ) : tab === "month" ? (
          <>
            {/* MONTH PLANNER + ROSTER */}
            <div style={monthWrap}>
              <div style={row}>
                <div style={ctlItem}>
                  <label style={lbl}><FiUser /> Radnica</label>
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
                  <label style={lbl}><FiCalendar /> Mesec</label>
                  <input
                    type="month"
                    value={monthAnchor}
                    onChange={(e) => setMonthAnchor(e.target.value)}
                    style={inp}
                  />
                </div>

                <div style={ctlItem}>
                  <label style={lbl}><FiClock /> Početak</label>
                  <input
                    type="time"
                    value={tplStart}
                    onChange={(e) => setTplStart(e.target.value)}
                    style={inp}
                  />
                </div>
                <div style={ctlItem}>
                  <label style={lbl}>Kraj</label>
                  <input
                    type="time"
                    value={tplEnd}
                    onChange={(e) => setTplEnd(e.target.value)}
                    style={inp}
                  />
                </div>
              </div>

              <div style={{ ...row, alignItems: "center" }}>
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

                <button style={primaryBtn} onClick={applyMonthTemplate} disabled={busy}>
                  {busy ? "Upisujem…" : "Postavi smene za mesec"}
                </button>
              </div>

              {/* ODMOR: datum + trajanje dana */}
              <div style={{ ...row, alignItems: "end", marginTop: 8 }}>
                <div style={ctlItem}>
                  <label style={lbl}><FiCalendar /> Početak odmora (datum)</label>
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
                  <button style={primaryBtn} onClick={applyVacationRange} disabled={busyVac}>
                    {busyVac ? "Upisujem…" : "Postavi odmor"}
                  </button>
                  <div style={{ color: "#fff", opacity: 0.8, fontSize: 12 }}>
                    Blokira <b>celu smenu</b> radnice za svaki dan u rasponu.
                  </div>
                </div>
              </div>

              <MonthRoster
                monthStr={monthAnchor}
                shifts={monthShifts}
                breaks={timeOffs}
                employeesById={employeesById}
              />
            </div>
          </>
        ) : (
          <>
            {/* RASPORED (klik na dan iz kalendara => timeline svih termina) */}
            <div style={monthWrap}>
              <div style={row}>
                <div style={ctlItem}>
                  <label style={lbl}><FiCalendar /> Mesec</label>
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
                    onChange={(e) => setSchedDate(new Date(e.target.value + "T00:00:00"))}
                    style={inp}
                  />
                </div>
              </div>

              <MiniMonth
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
              />
            </div>
          </>
        )}
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
  markAppt,
  deleteAppt,
}) {
  return (
    <div style={gridWrap}>
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
          const appts = (appointments || []).filter((a) => a.employeeId === empId);

          return (
            <div key={empId} style={colBox}>
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

                  return (
                    <div
                      key={a.id}
                      onMouseEnter={() => setHoverApptId(a.id)}
                      onMouseLeave={() => setHoverApptId(null)}
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
                      }}
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
                        {!isBreak && !isBlock && !isVacation && a.clientName ? ` · ${a.clientName}` : ""}
                      </div>

                      {hoverApptId === a.id && (
                        <div style={cardActions}>
                          {!isBreak && !isBlock && !isVacation && a.status !== "cancelled" && (
                            <button
                              style={smallBtn}
                              onClick={() => markAppt(a.id, { status: "cancelled" })}
                              title="Otkaži"
                            >
                              <FiSlash />
                              <span style={{ marginLeft: 6 }}>Otkaži</span>
                            </button>
                          )}
                          {!isBreak && !isBlock && !isVacation && a.status !== "noshow" && (
                            <button
                              style={smallBtn}
                              onClick={() => markAppt(a.id, { status: "noshow" })}
                              title="No-show"
                            >
                              <FiAlertTriangle />
                              <span style={{ marginLeft: 6 }}>No-show</span>
                            </button>
                          )}
                          <button
                            style={{ ...smallBtn, background: "#ffe1e1", color: "#7a1b1b" }}
                            onClick={() => deleteAppt(a.id)}
                            title="Obriši"
                          >
                            <FiTrash2 />
                            <span style={{ marginLeft: 6 }}>Obriši</span>
                          </button>
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

/* -------------------- Mini month (for schedule tab) -------------------- */

function MiniMonth({ monthStr, selectedKey, onPickDay }) {
  const base = new Date(monthStr + "-01T00:00:00");
  const days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const startDow = new Date(base.getFullYear(), base.getMonth(), 1).getDay();

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={calHeader}>
        {DOW_SR.map((d) => (
          <div key={d} style={calHeadCell}>{d}</div>
        ))}
      </div>
      <div style={calGrid}>
        {cells.map((d, i) => {
          if (!d) return <div key={i} style={calCell} />;
          const key = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(d)}`;
          const isSel = key === selectedKey;
          return (
            <button
              key={i}
              style={{
                ...calCell,
                cursor: "pointer",
                outline: "none",
                background: isSel ? "linear-gradient(135deg,#fff,#ffe7f1)" : calCell.background,
                color: isSel ? "#222" : "#fff",
                border: isSel ? "1px solid rgba(255,255,255,.9)" : calCell.border,
              }}
              onClick={() => onPickDay(key)}
              title={`Prikaži raspored za ${key}`}
            >
              <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                <span style={{ opacity: 0.9, fontWeight: 900 }}>{d}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------- Schedule grid (all bookings of the day) -------------------- */

function ScheduleGrid({ dateObj, appts, salonHours, employeesById, servicesById, colorForServiceId }) {
  // salon hours for this day
  const dow = DOW[dateObj.getDay()];
  const hours = salonHours[dow] || DEFAULT_SALON_HOURS[dow];
  const openMin = timeToMin(hours.open);
  const closeMin = timeToMin(hours.close);

  // layout: podela po "clusterima" preklapanja + lane assignment
  const laid = useMemo(() => {
    const items = (appts || []).map((a) => ({ ...a }));
    items.sort((a, b) => (a.startMin || 0) - (b.startMin || 0));
    const res = [];
    let cluster = [];
    let clusterEnd = -1;

    const flush = () => {
      if (!cluster.length) return;
      // lane assignment
      const lanesEnd = []; // lane index -> last endMin
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

      <div style={gridWrap}>
        <div style={{ ...timeAxis, height: gridHeight(closeMin - openMin) }}>
          {timeMarks(openMin, closeMin).map((t) => (
            <div key={t} style={markRow}>
              <span style={markLbl}>{minToTime(t)}</span>
            </div>
          ))}
        </div>

        <div style={{ ...colBody, height: gridHeight(closeMin - openMin), position: "relative", background: "rgba(255,255,255,.12)", borderRadius: 16, border: "1px solid rgba(255,255,255,.25)" }}>
          {laid.map((a) => {
            const top = pxFromMin(a.startMin - openMin);
            const height = pxFromMin(a.endMin - a.startMin);
            const widthPct = 100 / (a.cols || 1);
            const leftPct = (a.lane || 0) * widthPct;
            const bg = a.color || colorForServiceId(a.serviceId) || "#fff";

            const empName = employeesById.get(a.employeeId)?.name || "—";
            const srv = servicesById.get(a.serviceId)?.name || a.serviceName || "Usluga";

            return (
              <div
                key={a.id}
                style={{
                  position: "absolute",
                  top,
                  left: `calc(${leftPct}% + 6px)`,
                  width: `calc(${widthPct}% - 12px)`,
                  height,
                  background: bg,
                  borderRadius: 10,
                  boxShadow: "0 10px 22px rgba(0,0,0,.18), inset 0 0 0 2px rgba(255,255,255,.35)",
                  color: "#222",
                  padding: 8,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
                title={`${srv} • ${minToTime(a.startMin)}–${minToTime(a.endMin)} • ${empName}`}
              >
                <div style={{ fontWeight: 900, fontSize: 13 }}>{srv}</div>
                <div style={{ fontSize: 12, opacity: 0.9 }}>
                  {minToTime(a.startMin)}–{minToTime(a.endMin)} · {empName}
                  {a.clientName ? ` · ${a.clientName}` : ""}
                </div>
              </div>
            );
          })}
          {!laid.length && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#fff", opacity: 0.8 }}>
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

  // ko radi taj dan
  const byDay = new Map(); // dateKey -> Set(empId)
  for (const s of shifts) {
    if (!byDay.has(s.dateKey)) byDay.set(s.dateKey, new Set());
    byDay.get(s.dateKey).add(s.employeeId);
  }

  // time-off (pauze + odmori) po danu+radnici
  const timeOffMap = new Map(); // `${dateKey}|${empId}` -> [items]
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
          <div key={d} style={calHeadCell}>{d}</div>
        ))}
      </div>
      <div style={calGrid}>
        {cells.map((d, i) => {
          if (!d) return <div key={i} style={calCell} />;
          const key = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(d)}`;
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
              more: Math.max(0, offs.length - (firstBreak ? 1 : 0) - (hasVacation ? 1 : 0)),
            };
          });

          return (
            <div key={i} style={calCell}>
              <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                <span style={{ opacity: 0.9, fontWeight: 900 }}>{d}</span>
                {!!entries.length && (
                  <span style={{ opacity: 0.8, fontSize: 12 }}>{entries.length} rad.</span>
                )}
              </div>
              <div style={{ marginTop: 6, display: "grid", gap: 6, width: "100%" }}>
                {entries.slice(0, 6).map((n) => (
                  <span key={n.id} style={empPill}>
                    {n.name}
                    {n.hasVacation ? " 🏖" : ""}
                    {n.firstTime ? ` ☕ ${n.firstTime}${n.more ? " +" + n.more : ""}` : ""}
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

/* -------------------- UI helpers & styles -------------------- */

const pxFromMin = (min) => min * 2;
const gridHeight = (m) => pxFromMin(m);
const timeMarks = (open, close) => {
  const arr = [];
  for (let m = open; m <= close; m += 60) arr.push(m);
  return arr;
};

const wrap = {
  minHeight: "100vh",
  background: "url('/slika7.webp') center/cover fixed no-repeat",
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

const tabbar = { display: "flex", gap: 12, marginBottom: 12 };
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
  color: active ? "#222" : "#fff",
  fontWeight: 900,
  cursor: "pointer",
});

/* grid */
const gridWrap = { display: "grid", gridTemplateColumns: "80px 1fr", gap: 10 };
const timeAxis = {
  position: "relative",
  background: "rgba(0,0,0,.25)",
  borderRadius: 14,
  border: "1px solid rgba(255,255,255,.2)",
  overflow: "hidden",
};
const markRow = {
  height: pxFromMin(60),
  borderBottom: "1px dashed rgba(255,255,255,.2)",
  display: "flex",
  alignItems: "flex-start",
  paddingTop: 2,
};
const markLbl = { color: "#fff", fontSize: 12, opacity: 0.9, marginLeft: 8 };

const colsWrap = {
  display: "grid",
  gridAutoFlow: "column",
  gridAutoColumns: "minmax(220px, 1fr)",
  gap: 12,
  overflowX: "auto",
  paddingBottom: 6,
};
const colBox = {
  background: "rgba(255,255,255,.12)",
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 16,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
};
const colHeader = {
  padding: "8px 12px",
  color: "#fff",
  fontWeight: 900,
  background: "rgba(0,0,0,.35)",
  borderBottom: "1px solid rgba(255,255,255,.15)",
};
const colBody = { position: "relative", paddingTop: 4 };

const cardActions = { display: "flex", gap: 6, marginTop: 8 };
const smallBtn = {
  border: "none",
  height: 28,
  borderRadius: 8,
  padding: "0 10px",
  fontSize: 12,
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  background: "rgba(255,255,255,.85)",
  cursor: "pointer",
};

/* month */
const monthWrap = {
  background: "rgba(0,0,0,.35)",
  borderRadius: 16,
  padding: 12,
  border: "1px solid rgba(255,255,255,.2)",
};
const row = {
  display: "grid",
  gridTemplateColumns: "repeat(5, minmax(180px, 1fr))",
  gap: 10,
  marginBottom: 10,
};

/* lepši dugmići dana u nedelji */
const dayChip = (on) => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 36,
  minWidth: 56,
  padding: "0 12px",
  borderRadius: 999,
  border: on ? "1px solid rgba(255,255,255,.9)" : "1px solid rgba(255,255,255,.5)",
  background: on
    ? "linear-gradient(135deg,#fff,#ffe7f1)"
    : "rgba(255,255,255,.25)",
  color: on ? "#222" : "#fff",
  fontWeight: 900,
  cursor: "pointer",
  boxShadow: on ? "0 6px 14px rgba(255,127,181,.25)" : "none",
});

/* roster grid */
const calHeader = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: 6,
  marginBottom: 6,
};
const calHeadCell = {
  textAlign: "center",
  padding: "6px 8px",
  background: "rgba(255,255,255,.85)",
  borderRadius: 10,
  fontWeight: 900,
  border: "1px solid #ececec",
};
const calGrid = { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 };
const calCell = {
  minHeight: 110,
  background: "rgba(255,255,255,.12)",
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 10,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  padding: 8,
  color: "#fff",
};
const empPill = {
  display: "inline-block",
  padding: "4px 8px",
  background: "rgba(255,255,255,.9)",
  color: "#333",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 800,
  border: "1px solid #ececec",
};
