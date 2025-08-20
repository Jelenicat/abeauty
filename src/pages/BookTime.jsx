// src/pages/BookTime.jsx
import { useEffect, useMemo, useState } from "react";
import { useBooking } from "../context/BookingContext";
import { useAuth } from "../context/AuthContext";
import { db } from "../firebase";
import { useNavigate } from "react-router-dom";
import {
  collection, onSnapshot, orderBy, query, where,
  getDocs, addDoc, serverTimestamp
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
  const [monthAnchor, setMonthAnchor] = useState(ymStr(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => new Date());
  const [prefs, setPrefs] = useState(() => {
    const m = new Map();
    selectedServices.forEach(s => m.set(s.id, { mode: "any", empId: "", booked: false }));
    return m;
  });
  const noServices = selectedServices.length === 0;
  const activeService = selectedServices.find(s => s.id === activeId) || selectedServices[0] || null;
  const p = activeService ? (prefs.get(activeService.id) || { mode: "any", empId: "", booked: false }) : { mode: "any", empId: "", booked: false };

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

  useEffect(() => {
    let cancel = false;
    async function load() {
      if (!activeService) return;
      setLoading(true);
      const dk = dateKey(selectedDay);
      const map = new Map();
      for (const e of eligible) {
        const qS = query(collection(db, "shifts"), where("dateKey", "==", dk), where("employeeId", "==", e.id));
        const sSnap = await getDocs(qS);
        const segments = sSnap.docs.flatMap((d) => d.data().segments || []);
        if (!segments.length) { map.set(e.id, []); continue; }
        const qA = query(collection(db, "appointments"), where("dateKey", "==", dk), where("employeeId", "==", e.id));
        const aSnap = await getDocs(qA);
        const busy = aSnap.docs.map((d) => d.data());
        const slots = computeSlots({ segments, busy, totalMin: Number(activeService.durationMin || 0), step: 15 });
        map.set(e.id, slots);
      }
      if (!cancel) { setSlotsByEmp(map); setLoading(false); }
    }
    load();
    return () => { cancel = true; };
  }, [selectedDay, eligible, activeService]);

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

  const [confirmData, setConfirmData] = useState(null);
  function askConfirm(slot) {
    if (!user) return alert("Prijavi se da bi rezervisao.");
    if (p.mode === "specific" && !p.empId) return alert("Odaberi radnicu.");
    const emp = employees.find((e) => e.id === slot.employeeId);
    setConfirmData({ slot, emp, service: activeService, date: new Date(selectedDay) });
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
      const busy = aSnap.docs.map((d) => d.data());
      if (busy.some((b) => overlaps(slot.startMin, slot.endMin, b.startMin, b.endMin))) {
        alert("Termin je upravo zauzet. Izaberi drugi."); return;
      }
      await addDoc(collection(db, "appointments"), {
        type: "booking",
        status: "booked",
        employeeId: emp.id,
        employeeName: emp.name || "",
        dateKey: dk,
        startHHMM: minToTime(slot.startMin),
        endHHMM: minToTime(slot.endMin),
        startMin: slot.startMin,
        endMin: slot.endMin,
        durationMin: Number(activeService?.durationMin || 0),
        serviceId: activeService?.id,
        serviceName: activeService?.name,
        price: finalPriceOf(activeService) ?? null,
        clientName: `${user?.firstName || ""} ${user?.lastName || ""}`.trim(),
        clientPhone: user?.phone || "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        ...(activeService?.color ? { color: activeService.color } : {}),
      });
      const nextSelected = selectedServices.filter((x) => x.id !== activeService.id);
      if (typeof setSelectedServices === "function") setSelectedServices(() => nextSelected);
      if (nextSelected.length) { setActiveId(nextSelected[0].id); alert("Termin je uspešno zakazan ❤️"); }
      else {
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
    // **** MOBILNI – NE DIRAMO ****
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
                  return (
                    <button key={s.id} onClick={() => setActiveId(s.id)} style={srvItemMobile(active, booked)} type="button">
                      <div style={{ fontWeight: 900 }}>{s.name}</div>
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

  // **** DESKTOP / LAPTOP – ŠIROK, VERTIKALNI LAYOUT ****
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
            {/* (1) USLUGE – traka iznad svega, celom širinom */}
            <div style={servicesBar}>
              {selectedServices.map((s) => {
                const booked = prefs.get(s.id)?.booked;
                const active = s.id === activeService.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => setActiveId(s.id)}
                    type="button"
                    title={s.name}
                    style={serviceChip(active, booked)}
                  >
                    <div style={{ fontWeight: 900, lineHeight: 1.25 }}>{s.name}</div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      {Number(s.durationMin || 0)} min {finalPriceOf(s) != null && <>• {money(finalPriceOf(s))}</>}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* (2) INFO + KONTROLE – puna širina */}
            <div style={controlsRow}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.9, color: "#fff" }}>Usluga</div>
                <div style={{ fontWeight: 900, color: "#fff", fontSize: 20 }}>{activeService.name}</div>
                <div style={{ fontSize: 13, opacity: 0.9, color: "#fff" }}>
                  Trajanje: <b>{Number(activeService.durationMin || 0)} min</b>
                  {finalPriceOf(activeService) != null && <> • Cena: <b>{money(finalPriceOf(activeService))}</b></>}
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

            {/* (3) TRAKA DATUMA – puna širina */}
            <DateStrip selectedDay={selectedDay} onSelect={setSelectedDay} />

            {/* (4) RADNICE – samo kad je specific */}
            {p.mode === "specific" && (
              <StylistsStrip
                employees={eligible}
                selectedId={p.empId}
                onSelect={(empId) => setPrefs(new Map(prefs.set(activeService.id, { ...p, mode: "specific", empId })))}
              />
            )}

            {/* (5) TERMINI – MREŽA PREKO CELE ŠIRINE */}
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
const AV = mobile ? 110 : 130;  // slike baš velike
const GAP = mobile ? 4 : 4;     // najmanji razmak
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
  const { slot, emp, service, date } = data;
  const dateStr = new Intl.DateTimeFormat("sr-RS", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(date);
  return (
    <div style={modalOverlayTop}>
      <div style={modalBox}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Potvrdi rezervaciju</h3>
        <div style={modalRow}><b>Usluga:</b> {service.name}{finalPriceOf(service) != null ? ` (${money(finalPriceOf(service))})` : ""}</div>
        <div style={modalRow}><b>Datum:</b> {dateStr}</div>
        <div style={modalRow}><b>Vreme:</b> {minToTime(slot.startMin)}</div>
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
const serviceChip = (active, booked) => ({
  textAlign: "left",
  padding: 16,
  borderRadius: 14,
  border: active ? "none" : "1px solid rgba(255,255,255,.35)",
  background: active ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "rgba(255,255,255,.15)",
  color: "#fff",
  boxShadow: active ? "0 8px 20px rgba(255,127,181,.28)" : "none",
  cursor: "pointer",
  outline: booked ? "2px solid rgba(26,127,60,.6)" : "none",
});

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
// mobilni month <input> stil
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

/* pills – DESKTOP full width */
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

/* pills – mobile (ostaje isto) */
const pillsGridMobile = { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 };
const pillBtnMobile = {
  padding: "12px 10px", borderRadius: 999, border: "1px solid #efcddc",
  background: "#fff", color: "#000", cursor: "pointer", textAlign: "center",
  boxShadow: "0 4px 12px rgba(0,0,0,.08)",
};
const emptyMsg = { gridColumn: "1 / -1", textAlign: "center", color: "#fff", opacity: 0.9, fontSize: 15, fontWeight: 600, padding: "12px 8px" };

/* mobile services list (isti kao ranije) */
const mobileServicesCol = { display: "grid", gridTemplateColumns: "1fr", gap: 8, marginBottom: 8 };
const srvItemMobile = (active) => ({
  textAlign: "left", padding: 12, borderRadius: 14, border: active ? "2px solid #ffc0d6" : "1px solid rgba(255,255,255,.35)",
  background: "rgba(255,255,255,.92)", color: "#222",
  boxShadow: active ? "0 8px 20px rgba(0,0,0,.12)" : "0 3px 10px rgba(0,0,0,.08)", cursor: "pointer",
});

/* modal */
const modalOverlayTop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: 28, zIndex: 999 };
const modalBox = {
  background: "linear-gradient(#ffffff, #ffffff) padding-box, linear-gradient(135deg,#ff7fb5,#8f97ff) border-box",
  border: "1px solid transparent", borderRadius: 18, padding: 20, maxWidth: 380, width: "calc(100% - 40px)", boxShadow: "0 16px 44px rgba(0,0,0,.28)", color: "#000",
};
const modalRow = { marginBottom: 6 };
const btnCancel = { flex: 1, padding: "10px 12px", background: "#eee", border: "none", borderRadius: 10, cursor: "pointer" };
const btnConfirm = { flex: 1, padding: "10px 12px", background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)", color: "#fff", border: "none", borderRadius: 10, fontWeight: "bold", cursor: "pointer" };
