// src/pages/BookTime.jsx
import { useEffect, useMemo, useState, useCallback } from "react";
import { useBooking } from "../context/BookingContext";
import { useAuth } from "../context/AuthContext";
import { db } from "../firebase";
import { useNavigate } from "react-router-dom";
import {
  collection, onSnapshot, orderBy, query, where,
  getDocs, addDoc, serverTimestamp, getDoc, doc
} from "firebase/firestore";

/* ---------- helpers ---------- */
const pad2 = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const ymStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const timeToMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x || 0, 10));
  return (h || 0) * 60 + (m || 0);
};
const minToTime = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const overlaps = (aS, aE, bS, bE) => Math.max(aS, bS) < Math.min(aE, bE);
const num = (v) => (v == null || v === "" ? null : Number(String(v).replace(/[^\d]/g, "")));
const basePriceOf = (s) => num(s?.basePrice ?? s?.price ?? s?.cena ?? s?.priceRSD ?? s?.cost);
const discountOf = (s) => Math.max(0, Math.min(100, num(s?.discountPercent) || 0));
const finalPriceOf = (s) => {
  const b = basePriceOf(s);
  if (b == null) return null;
  return Math.round((b * (100 - discountOf(s))) / 100);
};
const money = (v) =>
  v == null || v === ""
    ? ""
    : new Intl.NumberFormat("sr-RS", { style: "currency", currency: "RSD", maximumFractionDigits: 0 }).format(Number(v));

function computeSlots({ segments, busy, totalMin, step = 15 }) {
  const res = [];
  const segs = (segments || [])
    .map((s) => ({ start: timeToMin(s.start), end: timeToMin(s.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const taken = (busy || [])
    .map((b) => ({ start: b.startMin, end: b.endMin }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  for (const seg of segs) {
    let cur = seg.start;
    for (const b of taken) {
      if (b.end <= seg.start || b.start >= seg.end) continue;
      const freeEnd = Math.min(b.start, seg.end);
      for (let t = cur; t + totalMin <= freeEnd; t += step) res.push({ startMin: t, endMin: t + totalMin });
      cur = Math.max(cur, b.end);
    }
    for (let t = cur; t + totalMin <= seg.end; t += step) res.push({ startMin: t, endMin: t + totalMin });
  }
  return res;
}
const DEFAULT_SALON_HOURS = {
  mon: { open: "08:00", close: "22:00" },
  tue: { open: "08:00", close: "22:00" },
  wed: { open: "08:00", close: "22:00" },
  thu: { open: "08:00", close: "22:00" },
  fri: { open: "08:00", close: "22:00" },
  sat: { open: "08:00", close: "20:00" },
  sun: { open: "09:00", close: "17:00" },
};
const DOW = ["sun","mon","tue","wed","thu","fri","sat"];
/* ---------- responsive ---------- */
function useIsMobile(bp = 820) {
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" ? window.innerWidth <= bp : true);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= bp);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [bp]);
  return isMobile;
}

/* ===================== MAIN ===================== */
export default function BookTime() {
  const { selectedServices, clearServices, setSelectedServices } = useBooking();
  const { user } = useAuth();
  const nav = useNavigate();
  const isMobile = useIsMobile();

  const [salonHours, setSalonHours] = useState(DEFAULT_SALON_HOURS);
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, "settings", "salonHours"));
        if (snap.exists()) {
          setSalonHours({ ...DEFAULT_SALON_HOURS, ...(snap.data() || {}) });
        }
      } catch {}
    })();
  }, []);

  const backBtn = {
    height: 40, borderRadius: 12, border: "1px solid rgba(0,0,0,.12)", padding: "0 16px",
    fontWeight: 900, cursor: "pointer", background: "#fff", color: "#000", boxShadow: "0 6px 16px rgba(0,0,0,.08)"
  };

  const [employees, setEmployees] = useState([]);
  useEffect(() => {
    const off = onSnapshot(query(collection(db, "employees"), orderBy("name", "asc")),
      s => setEmployees(s.docs.map(d => ({ id: d.id, ...d.data() }))));
    return () => off();
  }, []);

  const [activeId, setActiveId] = useState(selectedServices[0]?.id || "");
  const activeService = selectedServices.find(s => s.id === activeId) || selectedServices[0] || null;

  // === Multi-select u istoj kategoriji (toggle, uključujući aktivnu) ===
  const [togetherIds, setTogetherIds] = useState(() => new Set(activeService ? [activeService.id] : []));
  useEffect(() => {
    if (!activeService) { setTogetherIds(new Set()); return; }
    setTogetherIds(prev => {
      const n = new Set();
      for (const id of prev) {
        const srv = selectedServices.find(x => x.id === id);
        if (srv && srv.categoryId === activeService.categoryId) n.add(id);
      }
      return n;
    });
  }, [activeService?.id, activeService?.categoryId, selectedServices]);

  const [monthAnchor, setMonthAnchor] = useState(ymStr(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => new Date());
  const [prefs, setPrefs] = useState(() => {
    const m = new Map();
    selectedServices.forEach(s => m.set(s.id, { mode: "any", empId: "", booked: false }));
    return m;
  });
  const noServices = selectedServices.length === 0;
  const p = activeService ? (prefs.get(activeService.id) || { mode: "any", empId: "", booked: false }) : { mode: "any", empId: "", booked: false };

  // === COMBO: ručno štiklirane usluge iz iste kategorije kao aktivna ===
  const comboServices = useMemo(() => {
    if (!activeService) return [];
    return selectedServices.filter(s => togetherIds.has(s.id) && s.categoryId === activeService.categoryId);
  }, [selectedServices, activeService, togetherIds]);

  const totalDuration = useMemo(
    () => comboServices.reduce((sum, s) => sum + Number(s.durationMin || 0), 0),
    [comboServices]
  );

  const totalPrice = useMemo(
    () => comboServices.reduce((sum, s) => sum + (finalPriceOf(s) || 0), 0),
    [comboServices]
  );

  const eligible = useMemo(() => {
    if (!activeService) return [];
    const cid = activeService.categoryId;
    return employees.filter((e) => {
      const srv = new Set(e.services || []);
      const cat = new Set(e.categories || []);
      return srv.has(activeService.id) || (cid && cat.has(cid));
    });
  }, [employees, activeService]);

  const [slotsByEmp, setSlotsByEmp] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  /* ------------ Učitavanje slotova (zbirno trajanje grupe) ------------ */
  const load = useCallback(async () => {
    if (!activeService) {
      setSlotsByEmp(new Map());
      return;
    }

    setLoading(true);
    const dk = dateKey(selectedDay);

    const empIds = eligible.map(e => e.id);
    if (empIds.length === 0) {
      setSlotsByEmp(new Map());
      setLoading(false);
      return;
    }

    const chunks = [];
    for (let i = 0; i < empIds.length; i += 10) chunks.push(empIds.slice(i, i + 10));

    try {
      const [shiftSnaps, apptSnaps] = await Promise.all([
        Promise.all(chunks.map(ids =>
          getDocs(query(
            collection(db, "shifts"),
            where("dateKey", "==", dk),
            where("employeeId", "in", ids)
          ))
        )),
        Promise.all(chunks.map(ids =>
          getDocs(query(
            collection(db, "appointments"),
            where("dateKey", "==", dk),
            where("employeeId", "in", ids)
          ))
        )),
      ]);

      const segsByEmp = new Map();
      shiftSnaps.flat().forEach(s => {
        s.docs.forEach(d => {
          const data = d.data() || {};
          const arr = data.segments || [];
          const list = segsByEmp.get(data.employeeId) || [];
          list.push(...arr);
          segsByEmp.set(data.employeeId, list);
        });
      });

      const busyByEmp = new Map();
      apptSnaps.flat().forEach(s => {
        s.docs.forEach(d => {
          const a = d.data() || {};
          const blocks = (busyByEmp.get(a.employeeId) || []);
          if (
            (a.type === "booking" && a.status === "booked") ||
            a.type === "block" ||
            a.type === "vacation" ||
            a.type === "break"
          ) blocks.push(a);
          busyByEmp.set(a.employeeId, blocks);
        });
      });

      const dowKey = DOW[selectedDay.getDay()];
      const h = salonHours[dowKey] || DEFAULT_SALON_HOURS[dowKey];
      const defaultSeg = [{ start: h.open, end: h.close }];

      const duration = Number(totalDuration || activeService?.durationMin || 0);
      const map = new Map();
      for (const id of empIds) {
        const segments = (segsByEmp.get(id) || defaultSeg);
        const busy = (busyByEmp.get(id) || []);
        const slots = computeSlots({ segments, busy, totalMin: duration, step: 15 });
        map.set(id, slots);
      }

      setSlotsByEmp(map);
    } finally {
      setLoading(false);
    }
  }, [activeService, eligible, salonHours, selectedDay, totalDuration]);

  useEffect(() => {
    const t = setTimeout(() => { load(); }, 180);
    return () => clearTimeout(t);
  }, [load]);

  const combined = useMemo(() => {
    const arr = [];
    for (const [id, slots] of slotsByEmp) for (const s of slots) arr.push({ ...s, employeeId: id });
    arr.sort((a, b) => a.startMin - b.startMin);
    return arr;
  }, [slotsByEmp]);

  const currentSlots = useMemo(() => {
    const base = p.mode === "specific"
      ? (slotsByEmp.get(p.empId) || []).map((s) => ({ ...s, employeeId: p.empId }))
      : combined;

    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const selStart = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate()).getTime();
    if (selStart < todayStart) return [];
    if (selStart === todayStart) {
      const nowMin = today.getHours() * 60 + today.getMinutes();
      return base.filter((s) => s.startMin > nowMin);
    }
    return base;
  }, [p.mode, p.empId, slotsByEmp, combined, selectedDay]);

  // Klik na chip usluge:
  // - druga kategorija: aktivna = ta usluga; selekcija postaje samo ta
  // - ista kategorija: toggle ZA SVAKU (uključujući aktivnu)
  const onServiceChipClick = (s) => {
    if (!activeService || s.categoryId !== activeService.categoryId) {
      setActiveId(s.id);
      setTogetherIds(new Set([s.id]));
      return;
    }
    setTogetherIds(prev => {
      const n = new Set(prev);
      if (n.has(s.id)) n.delete(s.id); else n.add(s.id);
      selectedServices.forEach(x => { if (x.categoryId !== activeService.categoryId) n.delete(x.id); });
      return n;
    });
  };

  const [confirmData, setConfirmData] = useState(null);
  function askConfirm(slot) {
    if (!user) return alert("Prijavi se da bi rezervisao.");
    if (p.mode === "specific" && !p.empId) return alert("Odaberi radnicu.");
    if (!comboServices.length) return alert("Odaberi bar jednu uslugu iz ove kategorije.");
    const emp = employees.find((e) => e.id === slot.employeeId);
    setConfirmData({
      slot,
      emp,
      services: comboServices,
      totalDuration,
      totalPrice,
      date: new Date(selectedDay)
    });
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch {}
  }

  async function book(slot) {
    if (busyAction) return;
    const emp = employees.find((e) => e.id === slot.employeeId);
    if (!emp) return alert("Radnica nije pronađena.");
    try {
      setBusyAction(true);
      const dk = dateKey(selectedDay);
      const qA = query(collection(db, "appointments"), where("dateKey", "==", dk), where("employeeId", "==", emp.id));
      const aSnap = await getDocs(qA);
      const busy = aSnap.docs
        .map((d) => d.data())
        .filter(a =>
          (a.type === "booking" && a.status === "booked") ||
          a.type === "block" ||
          a.type === "vacation" ||
          a.type === "break"
        );

      if (busy.some((b) => overlaps(slot.startMin, slot.endMin, b.startMin, b.endMin))) {
        alert("Termin je upravo zauzet. Izaberi drugi.");
        return;
      }

      const namesJoined = comboServices.map(s => s.name).join(" + ");

      // legacy polja (da AdminCalendar bez izmena vidi sve stavke)
      const serviceIdsLegacy = comboServices.map(s => s.id);
      const servicesInfoLegacy = comboServices.map(s => ({
        id: s.id,
        name: s.name,
        durationMin: Number(s.durationMin || 0),
        price: finalPriceOf(s) ?? null,
        ...(s.color ? { color: s.color } : {}),
      }));

      const payload = {
        type: "booking",
        status: "booked",
        manual: false,

        employeeId: emp.id,
        employeeName: emp.name || "",

        dateKey: dk,
        startHHMM: minToTime(slot.startMin),
        endHHMM: minToTime(slot.endMin),
        startMin: slot.startMin,
        endMin: slot.endMin,

        // === legacy + modern ===
        serviceIds: serviceIdsLegacy,
        servicesInfo: servicesInfoLegacy,
        services: servicesInfoLegacy,

        // ukupno trajanje i cena
        durationMin: Number(totalDuration || 0),
        totalPrice: totalPrice || null,

        // kompatibilnost
        serviceId: comboServices[0]?.id || activeService?.id,
        serviceName: namesJoined || activeService?.name,
        price: totalPrice || finalPriceOf(activeService) || null,

        clientName: `${user?.firstName || ""} ${user?.lastName || ""}`.trim(),
        clientPhone: user?.phone || "",

        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),

        ...(comboServices[0]?.color ? { color: comboServices[0].color } : {}),
      };

      const docRef = await addDoc(collection(db, "appointments"), payload);

// === admin push notifikacija ===
try {
  const dateText = new Intl.DateTimeFormat("sr-RS", {
    weekday: "short", day: "2-digit", month: "short"
  }).format(selectedDay);
  const timeText = minToTime(slot.startMin);

  // kao pre: ako si na localhostu, gađa produkcijski URL;
  // u produkciji koristi relativni
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(window.location.origin);
  const url = isLocal
    ? "https://abeauty.im/api/notify-admins-new-appointment"
    : "/api/notify-admins-new-appointment";

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientName: `${user?.firstName || ""} ${user?.lastName || ""}`.trim(),
      clientPhone: user?.phone || "",
      serviceName: namesJoined || activeService?.name || "",
      startText: `${dateText} ${timeText}`,
      screen: "/admin/kalendar",
      dateKey: dk,
      employeeId: emp.id,
      employeeName: emp.name || "",
      startMin: slot.startMin,
      apptId: docRef.id
    }),
  });

  const txt = await resp.text();
  console.log("notify-admins response:", resp.status, txt);
} catch (e) {
  console.warn("Slanje admin notifikacije nije uspelo:", e);
}





      // Ukloni iz korpe samo izabranu grupu
      const idsToRemove = new Set(comboServices.map(s => s.id));
      const nextSelected = selectedServices.filter(x => !idsToRemove.has(x.id));

      if (typeof setSelectedServices === "function") setSelectedServices(() => nextSelected);

      if (nextSelected.length) {
        setActiveId(nextSelected[0].id);
        alert("Termin je uspešno zakazan ❤️");
      } else {
        alert("Sve izabrane usluge su uspešno zakazane ❤️");
        if (typeof clearServices === "function") clearServices();
        else if (typeof setSelectedServices === "function") setSelectedServices(() => []);
        nav("/");
      }
    } catch (e) {
      console.error(e);
      alert("Greška pri rezervaciji. Pokušaj ponovo.");
    } finally { setBusyAction(false); }
  }

  const allBooked = selectedServices.length === 0;

  /* ===================== RENDER ===================== */
  if (isMobile) {
    return (
      <div style={wrap(true)}>
        <div style={panel(true)}>
          <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 8 }}>
            <button onClick={() => nav(-1)} style={backBtn}>← Nazad</button>
          </div>

          {noServices ? (
            <>
              <h2 style={title}>Nema izabranih usluga</h2>
              <div style={{ color: "#fff" }}>Vrati se i izaberi do 5 usluga.</div>
            </>
          ) : (
            <>
              <div style={mobileServicesCol}>
                {selectedServices.map((s) => {
                  const booked = prefs.get(s.id)?.booked;
                  const active = s.id === activeService.id;
                  const selected = togetherIds.has(s.id);
                  const dimmed = !!activeService && s.categoryId !== activeService.categoryId;
                  return (
                    <button
                      key={s.id}
                      onClick={() => onServiceChipClick(s)}
                      style={srvItemMobile(active, booked, selected, dimmed)}
                      type="button"
                    >
                      <div style={{ fontWeight: 900 }}>
                        {selected && s.id !== activeService.id ? "✓ " : ""}{s.name}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.85 }}>
                        {Number(s.durationMin || 0)} min {finalPriceOf(s) != null && <>• {money(finalPriceOf(s))}</>}
                      </div>
                    </button>
                  );
                })}
              </div>

              <DateStrip selectedDay={selectedDay} onSelect={setSelectedDay} />

              <div style={{ display: "grid", gap: 8, margin: "8px 0 6px" }}>
                <ModeToggle
                  mode={p.mode}
                  onChange={(mode) =>
                    setPrefs(new Map(prefs.set(activeService.id, { ...p, mode, empId: mode === "specific" ? p.empId : "" })))
                  }
                />
                <input
                  type="month"
                  value={monthAnchor}
                  onChange={(e) => {
                    setMonthAnchor(e.target.value);
                    const [y, m] = e.target.value.split("-").map((n) => parseInt(n, 10));
                    setSelectedDay(new Date(y, m - 1, 1));
                  }}
                  style={inpMobile}
                />
              </div>

              {p.mode === "specific" && (
                <StylistsStrip
                  employees={eligible}
                  selectedId={p.empId}
                  onSelect={(empId) => setPrefs(new Map(prefs.set(activeService.id, { ...p, mode: "specific", empId })))}
                  mobile
                />
              )}

              <TotalsCard
                names={comboServices.map(s => s.name)}
                totalDuration={totalDuration}
                totalPrice={totalPrice}
              />

              <div style={pillsGridMobile}>
                {loading ? (
                  <div style={{ color: "#fff", opacity: 0.9 }}>Učitavam…</div>
                ) : currentSlots.length ? (
                  currentSlots.map((s) => {
                    const e = employees.find((x) => x.id === s.employeeId);
                    return (
                      <button
                        key={`${s.employeeId}_${s.startMin}`}
                        style={{ ...pillBtnMobile, opacity: busyAction ? 0.7 : 1, pointerEvents: busyAction ? "none" : "auto" }}
                        onClick={() => askConfirm(s)}
                        type="button"
                        disabled={busyAction}
                        title={e?.name || "Radnica"}
                      >
                        {minToTime(s.startMin)}
                        {p.mode !== "specific" && <span style={{ fontSize: 11, opacity: 0.8, display: "block" }}>{e?.name || "Radnica"}</span>}
                      </button>
                    );
                  })
                ) : (
                  <div style={emptyMsg}>Nema slobodnih termina za izabrani dan.</div>
                )}
              </div>

              {allBooked && <div style={{ marginTop: 12, color: "#fff" }}>🎉 Sve izabrane usluge su zakazane. Hvala!</div>}

              <ConfirmModal
                data={confirmData}
                onCancel={() => setConfirmData(null)}
                onConfirm={(slot) => { setConfirmData(null); book(slot); }}
              />
            </>
          )}
        </div>
      </div>
    );
  }

  // **** DESKTOP / LAPTOP ****
  return (
    <div style={wrap(false)}>
      <div style={panel(false)}>
        <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 12 }}>
          <button onClick={() => nav(-1)} style={backBtn}>← Nazad</button>
        </div>

        {noServices ? (
          <>
            <h2 style={title}>Nema izabranih usluga</h2>
            <div style={{ color: "#fff" }}>Vrati se i izaberi do 5 usluga.</div>
          </>
        ) : (
          <>
            {/* (1) USLUGE – traka iznad svega */}
            <div style={servicesBar}>
              {selectedServices.map((s) => {
                const booked = prefs.get(s.id)?.booked;
                const active = s.id === activeService.id;
                const selected = togetherIds.has(s.id);
                const dimmed = !!activeService && s.categoryId !== activeService.categoryId;
                return (
                  <button
                    key={s.id}
                    onClick={() => onServiceChipClick(s)}
                    type="button"
                    title={s.name}
                    style={serviceChip(active, booked, selected, dimmed)}
                  >
                    <div style={{ fontWeight: 900, lineHeight: 1.25 }}>
                      {selected && s.id !== activeService.id ? "✓ " : ""}{s.name}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      {Number(s.durationMin || 0)} min {finalPriceOf(s) != null && <>• {money(finalPriceOf(s))}</>}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* (2) INFO + KONTROLE */}
            <div style={controlsRow}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.9, color: "#fff" }}>Usluge</div>
                <div style={{ fontWeight: 900, color: "#fff", fontSize: 20 }}>
                  {comboServices.length ? comboServices.map(s => s.name).join(" + ") : (activeService?.name || "")}
                </div>
                <div style={{ fontSize: 13, opacity: 0.9, color: "#fff" }}>
                  Trajanje: <b>{Number(totalDuration || activeService?.durationMin || 0)} min</b>
                  {totalPrice ? <> • Cena: <b>{money(totalPrice)}</b></> : (finalPriceOf(activeService) != null ? <> • Cena: <b>{money(finalPriceOf(activeService))}</b></> : null)}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 420px) 200px", gap: 12, alignItems: "end" }}>
                <div>
                  <label style={lbl}>Način izbora</label>
                  <ModeToggle
                    mode={p.mode}
                    onChange={(mode) =>
                      setPrefs(new Map(prefs.set(activeService.id, { ...p, mode, empId: mode === "specific" ? p.empId : "" })))
                    }
                  />
                </div>
                <div>
                  <label style={lbl}>Mesec</label>
                  <input
                    type="month"
                    value={monthAnchor}
                    onChange={(e) => {
                      setMonthAnchor(e.target.value);
                      const [y, m] = e.target.value.split("-").map((n) => parseInt(n, 10));
                      setSelectedDay(new Date(y, m - 1, 1));
                    }}
                    style={inp}
                  />
                </div>
              </div>
            </div>

            {/* (3) TRAKA DATUMA */}
            <DateStrip selectedDay={selectedDay} onSelect={setSelectedDay} />

            {/* (4) RADNICE – samo kad je "specific" */}
            {p.mode === "specific" && (
              <StylistsStrip
                employees={eligible}
                selectedId={p.empId}
                onSelect={(empId) => setPrefs(new Map(prefs.set(activeService.id, { ...p, mode: "specific", empId })))}
              />
            )}

            {/* (5) ZBIRNI INFO */}
            <TotalsCard
              names={comboServices.map(s => s.name)}
              totalDuration={totalDuration}
              totalPrice={totalPrice}
            />

            {/* (6) TERMINI */}
            <div style={pillsGridDesktop}>
              {loading ? (
                <div style={{ color: "#fff", opacity: 0.9 }}>Učitavam…</div>
              ) : currentSlots.length ? (
                currentSlots.map((s) => {
                  const e = employees.find((x) => x.id === s.employeeId);
                  return (
                    <button
                      key={`${s.employeeId}_${s.startMin}`}
                      style={{ ...pillBtnDesktop, opacity: busyAction ? 0.7 : 1, pointerEvents: busyAction ? "none" : "auto" }}
                      onClick={() => askConfirm(s)}
                      type="button"
                      disabled={busyAction}
                      title={e?.name || "Radnica"}
                    >
                      <div style={{ fontWeight: 800, fontSize: 18 }}>{minToTime(s.startMin)}</div>
                      {p.mode !== "specific" && <div style={{ fontSize: 12, opacity: 0.85 }}>{e?.name || "Radnica"}</div>}
                    </button>
                  );
                })
              ) : (
                <div style={emptyMsg}>Nema slobodnih termina za izabrani dan.</div>
              )}
            </div>

            {allBooked && <div style={{ marginTop: 12, color: "#fff" }}>🎉 Sve izabrane usluge su zakazane. Hvala!</div>}

            <ConfirmModal
              data={confirmData}
              onCancel={() => setConfirmData(null)}
              onConfirm={(slot) => { setConfirmData(null); book(slot); }}
            />
          </>
        )}
      </div>
    </div>
  );
}

/* ===================== SUB-KOMPONENTE ===================== */
function DateStrip({ selectedDay, onSelect }) {
  const start = new Date(selectedDay);
  start.setDate(selectedDay.getDate() - 1);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });

  return (
    <div style={stripWrap}>
      <button type="button" onClick={() => onSelect(new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate() - 7))} style={stripArrow} aria-label="Prethodna nedelja">‹</button>
      <div style={stripScroller}>
        {days.map((d, idx) => {
          const isSel = dateKey(d) === dateKey(selectedDay);
          const wd = d.toLocaleDateString("sr-RS", { weekday: "short" }).replace(".", "");
          return (
            <button key={idx} onClick={() => onSelect(d)} type="button" style={stripDay(isSel)}>
              <div style={{ fontSize: 11, opacity: 0.9 }}>{wd}</div>
              <div style={{ fontWeight: 900, fontSize: 16 }}>{d.getDate()}</div>
            </button>
          );
        })}
      </div>
      <button type="button" onClick={() => onSelect(new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate() + 7))} style={stripArrow} aria-label="Sledeća nedelja">›</button>
    </div>
  );
}

function TotalsCard({ names, totalDuration, totalPrice }) {
  if (!names?.length) return null;
  return (
    <div style={{
      margin: "8px 0 12px",
      background: "rgba(255,255,255,.18)",
      border: "1px solid rgba(255,255,255,.35)",
      borderRadius: 14,
      padding: "10px 12px",
      color: "#fff",
      display: "flex",
      flexWrap: "wrap",
      gap: 12,
      alignItems: "center"
    }}>
      <div><b>Izabrano:</b> {names.join(" + ")}</div>
      <div><b>Trajanje:</b> {Number(totalDuration || 0)} min</div>
      {totalPrice ? <div><b>Cena:</b> {money(totalPrice)}</div> : null}
    </div>
  );
}

function ModeToggle({ mode, onChange }) {
  return (
    <div style={toggleRow}>
      <button type="button" onClick={() => onChange("any")} style={modeBtn(mode === "any")}>Prva slobodna radnica</button>
      <button type="button" onClick={() => onChange("specific")} style={modeBtn(mode === "specific")}>Određena radnica</button>
    </div>
  );
}

function StylistsStrip({ employees, selectedId, onSelect, mobile = false }) {
  if (!employees?.length) return <div style={{ color: "#fff", opacity: 0.85, padding: 8 }}>Nema radnica za ovu uslugu/kategoriju.</div>;
  const AV = mobile ? 110 : 130;
  const GAP = mobile ? 4 : 4;
  const MINW = mobile ? 110 : 130;
  const PAD = mobile ? 4 : 8;

  const stripWrapLocal = { display: "grid", gridTemplateColumns: "36px 1fr 36px", alignItems: "center", gap: GAP, margin: "6px 0 10px" };
  const scroller = { display: "grid", gridAutoFlow: "column", gridAutoColumns: `minmax(${MINW}px, 1fr)`, gap: GAP, overflowX: "auto", padding: "2px 2px", scrollbarWidth: "none" };
  const item = (active) => ({
    display: "grid", gridTemplateRows: "auto auto", placeItems: "center", gap: mobile ? 4 : 6, padding: PAD, minWidth: MINW,
    borderRadius: 8, border: "none", background: "transparent", boxShadow: "none", color: "#fff", cursor: "pointer",
    transform: active ? "translateY(-1px)" : "none",
  });
  const avatar = { height: AV, width: AV, borderRadius: "50%", overflow: "hidden", border: `2px solid ${selectedId ? "#f68fa9" : "transparent"}` };
  const img = { width: "100%", height: "100%", objectFit: "cover" };
  const name = { fontWeight: 800, fontSize: mobile ? 12 : 13, color: "#fff", textAlign: "center" };
  const arrowBtn = { height: 36, width: 36, borderRadius: 12, border: "1px solid rgba(255,255,255,.35)", background: "rgba(255,255,255,.15)", color: "#fff", fontSize: 18, cursor: "pointer" };

  return (
    <div style={stripWrapLocal}>
      <button type="button" onClick={(e) => e.currentTarget.nextSibling.scrollBy({ left: -250, behavior: "smooth" })} style={arrowBtn} aria-label="Levo">‹</button>
      <div style={scroller}>
        {employees.map((e) => {
          const active = e.id === selectedId;
          return (
            <button key={e.id} type="button" onClick={() => onSelect(e.id)} style={item(active)} title={e.name}>
              <div style={avatar}><img src={e.photoUrl || ""} alt={e.name} style={img} onError={(ev) => (ev.currentTarget.style.display = "none")} /></div>
              <div style={name}>{e.name}</div>
            </button>
          );
        })}
      </div>
      <button type="button" onClick={(e) => e.currentTarget.previousSibling.scrollBy({ left: 250, behavior: "smooth" })} style={arrowBtn} aria-label="Desno">›</button>
    </div>
  );
}

/* =============== MODAL =============== */
function ConfirmModal({ data, onCancel, onConfirm }) {
  if (!data) return null;
  const { slot, emp, services, totalDuration, totalPrice, date } = data;
  const dateStr = new Intl.DateTimeFormat("sr-RS", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(date);
  return (
    <div style={modalOverlayTop}>
      <div style={modalBox}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Potvrdi rezervaciju</h3>
        <div style={modalRow}><b>Usluge:</b> {services.map(s => s.name).join(", ")}</div>
        <div style={modalRow}><b>Ukupno trajanje:</b> {Number(totalDuration || 0)} min</div>
        {totalPrice ? <div style={modalRow}><b>Ukupna cena:</b> {money(totalPrice)}</div> : null}
        <div style={modalRow}><b>Datum:</b> {dateStr}</div>
        <div style={modalRow}><b>Početak:</b> {minToTime(slot.startMin)}</div>
        <div style={modalRow}><b>Radnica:</b> {emp?.name || "Radnica"}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button style={btnCancel} onClick={onCancel}>Otkaži</button>
          <button style={btnConfirm} onClick={() => onConfirm(slot)}>Potvrdi</button>
        </div>
      </div>
    </div>
  );
}

/* ===================== STYLES ===================== */
const wrap = (mobile) => ({
  minHeight: "100vh",
  background: "url('/slika7.webp') center/cover fixed no-repeat",
  padding: mobile ? 12 : 24,
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-start",
});
const panel = (mobile) => ({
  width: mobile ? "min(860px, 100%)" : "min(1900px, 100%)",
  margin: "0 auto",
  background: "rgba(255,255,255,.12)",
  border: "1px solid rgba(255,255,255,.35)",
  backdropFilter: "blur(10px)",
  borderRadius: 24,
  boxShadow: "0 24px 60px rgba(0,0,0,.25)",
  padding: mobile ? 14 : "clamp(24px,3vw,40px)",
});
const title = { marginTop: 0, color: "#000", textShadow: "0 2px 14px rgba(0,0,0,.25)" };

/* -- DESKTOP top services bar -- */
const servicesBar = {
  display: "grid",
  gridAutoFlow: "column",
  gridAutoColumns: "minmax(260px, 1fr)",
  gap: 12,
  marginBottom: 16,
  overflowX: "auto",
  paddingBottom: 4,
};
const serviceChip = (active, booked, selected, dimmed) => {
  const base = {
    textAlign: "left",
    padding: 16,
    borderRadius: 14,
    color: "#fff",
    cursor: "pointer",
    transition: "transform .12s ease, box-shadow .12s ease, opacity .12s ease",
  };

  let background, border, boxShadow, opacity = 1;

  if (active) {
    background = "linear-gradient(135deg,#ff4f98,#ff7fb5)";
    border = "none";
    boxShadow = "0 8px 20px rgba(255,127,181,.28)";
  } else if (selected) {
    background = "linear-gradient(135deg,#7a1f4a,#a02f62)";
    border = "1px solid rgba(255,255,255,.35)";
    boxShadow = "0 8px 20px rgba(160,47,98,.35)";
  } else if (dimmed) {
    background = "rgba(255,255,255,.12)";
    border = "1px solid rgba(255,255,255,.20)";
    opacity = 0.65;
  } else {
    background = "rgba(255,255,255,.15)";
    border = "1px solid rgba(255,255,255,.35)";
    boxShadow = "none";
  }

  return {
    ...base,
    background,
    border,
    boxShadow,
    outline: booked ? "2px solid rgba(26,127,60,.6)" : "none",
    opacity,
  };
};

/* controls row */
const controlsRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-end",
  gap: 16,
  marginBottom: 10,
};
const lbl = { color: "#fff", fontWeight: 900, fontSize: 12, opacity: 0.95 };
const inp = {
  height: 42, borderRadius: 10, border: "1px solid #e8e8e8", background: "#fff",
  padding: "0 12px", fontSize: 14, color: "#222", width: "100%",
};
const inpMobile = {
  height: 36,
  borderRadius: 12,
  border: "1px solid #e8e8e8",
  background: "#fff",
  padding: "0 10px",
  fontSize: 14,
  color: "#222",
  width: "140px",
  maxWidth: "50vw",
  alignSelf: "start",
};

/* date strip */
const stripWrap = { display: "grid", gridTemplateColumns: "36px 1fr 36px", alignItems: "center", gap: 8, margin: "6px 0 8px" };
const stripArrow = { height: 36, width: 36, borderRadius: 12, border: "1px solid rgba(255,255,255,.35)", background: "rgba(255,255,255,.15)", color: "#fff", fontSize: 18, cursor: "pointer" };
const stripScroller = { display: "grid", gridAutoFlow: "column", gridAutoColumns: "minmax(56px, 1fr)", gap: 8, overflowX: "auto", padding: "2px 2px", scrollbarWidth: "none" };
const stripDay = (sel) => ({
  display: "grid", placeItems: "center", gap: 2, padding: "8px 6px",
  borderRadius: 12, border: sel ? "1px solid #ffcfde" : "1px solid rgba(255,255,255,.35)",
  background: sel ? "linear-gradient(135deg,#ffffff,#ffe3ef)" : "rgba(255,255,255,.12)",
  color: "#000", minWidth: 64, cursor: "pointer",
  boxShadow: sel ? "0 6px 16px rgba(255,127,181,.25)" : "none",
});

/* toggle */
const toggleRow = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 };
const modeBtn = (active) => ({
  height: 40, borderRadius: 12, border: active ? "2px solid #ffb6d0" : "1px solid #e8e8e8",
  background: active ? "linear-gradient(135deg,#ffffff,#ffe3ef)" : "#fff",
  boxShadow: active ? "0 6px 16px rgba(255,127,181,.25)" : "none",
  fontWeight: 800, cursor: "pointer", color: "#000",
});

/* pills – DESKTOP */
const pillsGridDesktop = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))",
  gap: 14,
};
const pillBtnDesktop = {
  display: "grid",
  justifyItems: "center",
  gap: 4,
  padding: "14px 16px",
  borderRadius: 999,
  border: "1px solid #efcddc",
  background: "#fff",
  color: "#000",
  cursor: "pointer",
  boxShadow: "0 6px 16px rgba(0,0,0,.08)",
};

/* pills – mobile */
const pillsGridMobile = { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 };
const pillBtnMobile = {
  padding: "12px 10px", borderRadius: 999, border: "1px solid #efcddc",
  background: "#fff", color: "#000", cursor: "pointer", textAlign: "center",
  boxShadow: "0 4px 12px rgba(0,0,0,.08)",
};
const emptyMsg = { gridColumn: "1 / -1", textAlign: "center", color: "#fff", opacity: 0.9, fontSize: 15, fontWeight: 600, padding: "12px 8px" };

/* mobile services list */
const mobileServicesCol = { display: "grid", gridTemplateColumns: "1fr", gap: 8, marginBottom: 8 };
const srvItemMobile = (active, _booked, selected, dimmed) => {
  let background = "rgba(255,255,255,.92)";
  let color = "#222";
  let border = "1px solid rgba(255,255,255,.35)";
  let boxShadow = "0 3px 10px rgba(0,0,0,.08)";
  let opacity = 1;

  if (selected) {
    background = "linear-gradient(135deg,#7a1f4a,#a02f62)";
    color = "#fff";
    border = "2px solid #ffb6d0";
    boxShadow = "0 8px 20px rgba(160,47,98,.25)";
  }
  if (active) {
    border = "2px solid #ffc0d6";
  }
  if (dimmed && !selected) {
    opacity = 0.75;
  }

  return {
    textAlign: "left",
    padding: 12,
    borderRadius: 14,
    background,
    color,
    border,
    boxShadow,
    cursor: "pointer",
    transition: "transform .12s ease, box-shadow .12s ease, opacity .12s ease",
    opacity,
  };
};

/* modal */
const modalOverlayTop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: 28, zIndex: 999 };
const modalBox = {
  background: "linear-gradient(#ffffff, #ffffff) padding-box, linear-gradient(135deg,#ff7fb5,#8f97ff) border-box",
  border: "1px solid transparent", borderRadius: 18, padding: 20, maxWidth: 380, width: "calc(100% - 40px)", boxShadow: "0 16px 44px rgba(0,0,0,.28)", color: "#000",
};
const modalRow = { marginBottom: 6 };
const btnCancel = { flex: 1, padding: "10px 12px", background: "#eee", border: "none", borderRadius: 10, cursor: "pointer" };
const btnConfirm = { flex: 1, padding: "10px 12px", background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)", color: "#fff", border: "none", borderRadius: 10, fontWeight: "bold", cursor: "pointer" };
