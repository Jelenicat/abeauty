// src/pages/BookTime.jsx
import { useEffect, useMemo, useState } from "react";
import { useBooking } from "../context/BookingContext";
import { useAuth } from "../context/AuthContext";
import { db } from "../firebase";
import { useNavigate } from "react-router-dom";

import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
  getDocs,
  addDoc,
  serverTimestamp,
} from "firebase/firestore";

/* ---------- helpers ---------- */
const pad2 = (n) => String(n).padStart(2, "0");
const dateKey = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const ymStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const timeToMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x || 0, 10));
  return (h || 0) * 60 + (m || 0);
};
const minToTime = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const overlaps = (aS, aE, bS, bE) => Math.max(aS, bS) < Math.min(aE, bE);

const num = (v) =>
  v == null || v === ""
    ? null
    : Number(typeof v === "string" ? v.replace(/[^\d]/g, "") : v);
const basePriceOf = (s) =>
  num(s?.basePrice ?? s?.price ?? s?.cena ?? s?.priceRSD ?? s?.cost);
const discountOf = (s) => {
  const d = num(s?.discountPercent);
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.min(100, d));
};
const finalPriceOf = (s) => {
  const b = basePriceOf(s);
  if (b == null) return null;
  return Math.round((b * (100 - discountOf(s))) / 100);
};
const money = (v) =>
  v == null || v === ""
    ? ""
    : new Intl.NumberFormat("sr-RS", {
        style: "currency",
        currency: "RSD",
        maximumFractionDigits: 0,
      }).format(Number(v));

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
      for (let t = cur; t + totalMin <= freeEnd; t += step)
        res.push({ startMin: t, endMin: t + totalMin });
      cur = Math.max(cur, b.end);
    }
    for (let t = cur; t + totalMin <= seg.end; t += step)
      res.push({ startMin: t, endMin: t + totalMin });
  }
  return res;
}

/* dodatno: slug i foto-izbor */
const slugify = (str) =>
  String(str || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .toLowerCase();

const photoSrcFor = (emp) =>
  (emp?.photoUrl && String(emp.photoUrl)) || `/employees/${slugify(emp?.name)}.jpg`;

/* ---------- responsive hook ---------- */
function useIsMobile(breakpoint = 820) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth <= breakpoint : true
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

/* ===================== MAIN COMPONENT ===================== */
export default function BookTime() {
const { selectedServices, clearServices } = useBooking();

  const { user } = useAuth();
  const nav = useNavigate();

  const isMobile = useIsMobile();

  const [employees, setEmployees] = useState([]);
  const [activeId, setActiveId] = useState(selectedServices[0]?.id || "");
  const [monthAnchor, setMonthAnchor] = useState(ymStr(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => new Date());

  // per-service preferencije
  const [prefs, setPrefs] = useState(() => {
    const m = new Map();
    selectedServices.forEach((s) =>
      m.set(s.id, { mode: "any", empId: "", booked: false })
    );
    return m;
  });

  // state za custom modal potvrde
  const [confirmData, setConfirmData] = useState(null);

  useEffect(() => {
    const offE = onSnapshot(
      query(collection(db, "employees"), orderBy("name", "asc")),
      (s) => setEmployees(s.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    return () => offE();
  }, []);

  if (!selectedServices.length) {
    return (
      <div style={wrap(isMobile)}>
        <div style={panel(isMobile)}>
          <h2 style={title}>Nema izabranih usluga</h2>
          <div style={{ color: "#fff" }}>Vrati se i izaberi do 5 usluga.</div>
        </div>
      </div>
    );
  }

  const activeService =
    selectedServices.find((s) => s.id === activeId) || selectedServices[0];
  const p =
    prefs.get(activeService.id) || { mode: "any", empId: "", booked: false };

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
        const qS = query(
          collection(db, "shifts"),
          where("dateKey", "==", dk),
          where("employeeId", "==", e.id)
        );
        const sSnap = await getDocs(qS);
        const segments = sSnap.docs.flatMap((d) => d.data().segments || []);
        if (!segments.length) {
          map.set(e.id, []);
          continue;
        }

        const qA = query(
          collection(db, "appointments"),
          where("dateKey", "==", dk),
          where("employeeId", "==", e.id)
        );
        const aSnap = await getDocs(qA);
        const busy = aSnap.docs.map((d) => d.data());

        const slots = computeSlots({
          segments,
          busy,
          totalMin: Number(activeService.durationMin || 0),
          step: 15,
        });
        map.set(e.id, slots);
      }
      if (!cancel) {
        setSlotsByEmp(map);
        setLoading(false);
      }
    }
    load();
    return () => {
      cancel = true;
    };
  }, [selectedDay, eligible, activeService]);

  const combined = useMemo(() => {
    const arr = [];
    for (const [id, slots] of slotsByEmp)
      for (const s of slots) arr.push({ ...s, employeeId: id });
    arr.sort((a, b) => a.startMin - b.startMin);
    return arr;
  }, [slotsByEmp]);

  const currentSlots =
    p.mode === "specific"
      ? (slotsByEmp.get(p.empId) || []).map((s) => ({
          ...s,
          employeeId: p.empId,
        }))
      : combined;

  // pokretanje modala – umesto direktnog book
  function askConfirm(slot) {
    if (!user) {
      alert("Prijavi se da bi rezervisao.");
      return;
    }
    if (p.mode === "specific" && !p.empId) {
      alert("Odaberi radnicu.");
      return;
    }
    const emp = employees.find((e) => e.id === slot.employeeId);
    setConfirmData({
      slot,
      emp,
      service: activeService,
      date: new Date(selectedDay),
    });
  }

 async function book(slot) {
  if (busyAction) return; // blokiraj dupli klik

  const emp = employees.find((e) => e.id === slot.employeeId);
  if (!emp) {
    alert("Radnica nije pronađena.");
    return;
  }

  try {
    setBusyAction(true);

    const dk = dateKey(selectedDay);

    // re-check preklapanja
    const qA = query(
      collection(db, "appointments"),
      where("dateKey", "==", dk),
      where("employeeId", "==", emp.id)
    );
    const aSnap = await getDocs(qA);
    const busy = aSnap.docs.map((d) => d.data());
    if (busy.some((b) => overlaps(slot.startMin, slot.endMin, b.startMin, b.endMin))) {
      alert("Termin je upravo zauzet. Izaberi drugi.");
      return;
    }

    const payload = {
      type: "booking",
      status: "booked",
      employeeId: emp.id,
      employeeName: emp.name || "",
      dateKey: dk,
      startHHMM: minToTime(slot.startMin),
      endHHMM: minToTime(slot.endMin),
      startMin: slot.startMin,
      endMin: slot.endMin,
      durationMin: Number(activeService.durationMin || 0),
      serviceId: activeService.id,
      serviceName: activeService.name,
      price: finalPriceOf(activeService) ?? null,
      clientName: `${user?.firstName || ""} ${user?.lastName || ""}`.trim(),
      clientPhone: user?.phone || "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...(activeService.color ? { color: activeService.color } : {}),
    };

    // upis termina
    const docRef = await addDoc(collection(db, "appointments"), payload);

    // osveži prefs da označi da je zakazano
    const next = new Map(prefs);
    next.set(activeService.id, { ...p, booked: true });
    setPrefs(next);

    const remaining = selectedServices.find((s) => !(next.get(s.id)?.booked));
    if (remaining) {
      setActiveId(remaining.id);
      alert("Termin je uspešno rezervisan ❤️");
    } else {
      alert("Sve izabrane usluge su uspešno zakazane ❤️");

      // ⚡ odmah ažuriraj status da se ne vidi dugme Otkaži u Home.jsx
      await updateDoc(docRef, { status: "confirmed" }); 
      // možeš staviti i "done" ili "pending" ako želiš da ih potpuno sakriješ

      clearServices();
      nav("/"); // odmah preusmeri na početnu
    }

  } catch (err) {
    console.error("Booking error:", err);
    const msg = String(err?.message || "Greška pri rezervaciji.");
    alert(
      msg.includes("index")
        ? "Upit traži Firestore indeks. Otvori konzolu i klikni na link koji je Firestore generisao da napraviš indeks, pa pokušaj ponovo."
        : msg
    );
  } finally {
    setBusyAction(false);
  }
}

  const allBooked = selectedServices.every((s) => prefs.get(s.id)?.booked);

  /* ---------- LAYOUT ---------- */
  if (isMobile) {
    // MOBILNI PRIKAZ – jedna kolona
    return (
      <div style={wrap(isMobile)}>
        <div style={panel(isMobile)}>
   

          {/* 1) Usluge */}
          <div style={mobileServicesCol}>
            {selectedServices.map((s) => {
              const booked = prefs.get(s.id)?.booked;
              const active = s.id === activeService.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  style={srvItemMobile(active, booked)}
                  type="button"
                >
                  <div style={{ fontWeight: 900 }}>{s.name}</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    {Number(s.durationMin || 0)} min{" "}
                    {finalPriceOf(s) != null && <>• {money(finalPriceOf(s))}</>}
                  </div>
                </button>
              );
            })}
          </div>

          {/* 2) Kalendar */}
          <DateStrip selectedDay={selectedDay} onSelect={setSelectedDay} />

          {/* 3) Toggle + Mesec */}
          <div style={{ display: "grid", gap: 8, margin: "8px 0 6px" }}>
            <ModeToggle
              mode={p.mode}
              onChange={(mode) =>
                setPrefs(
                  new Map(
                    prefs.set(activeService.id, {
                      ...p,
                      mode,
                      empId: mode === "specific" ? p.empId : "",
                    })
                  )
                )
              }
            />
            <input
              type="month"
              value={monthAnchor}
              onChange={(e) => {
                setMonthAnchor(e.target.value);
                const [y, m] = e.target.value
                  .split("-")
                  .map((n) => parseInt(n, 10));
                setSelectedDay(new Date(y, m - 1, 1));
              }}
              style={inpMobile}
            />
          </div>

          {/* 4) Radnice – samo za "specific" */}
          {p.mode === "specific" && (
            <>
            
           {/* MOBILE grana */}
<StylistsStrip
  employees={eligible}
  selectedId={p.empId}
  onSelect={(empId) =>
    setPrefs(new Map(prefs.set(activeService.id, { ...p, mode: "specific", empId })))
  }
  mobile={true}
/>



            </>
          )}

          {/* 5) Termini */}
          <div style={pillsGridMobile}>
            {loading ? (
              <div style={{ color: "#fff", opacity: 0.9 }}>Učitavam…</div>
            ) : currentSlots.length ? (
              currentSlots.map((s) => {
                const e = employees.find((x) => x.id === s.employeeId);
                return (
                  <button
                    key={`${s.employeeId}_${s.startMin}`}
                    style={{
                      ...pillBtnMobile,
                      opacity: busyAction ? 0.7 : 1,
                      pointerEvents: busyAction ? "none" : "auto",
                    }}
                    onClick={() => askConfirm(s)}
                    type="button"
                    disabled={busyAction}
                    title={e?.name || "Radnica"}
                  >
                    {minToTime(s.startMin)}
                    {p.mode !== "specific" && (
                      <span
                        style={{
                          fontSize: 11,
                          opacity: 0.8,
                          display: "block",
                        }}
                      >
                        {e?.name || "Radnica"}
                      </span>
                    )}
                  </button>
                );
              })
            ) : (
              <div style={{ color: "#fff", opacity: 0.9 }}>
                Nema slobodnih termina za izabrani dan.
              </div>
            )}
          </div>

          {allBooked && (
            <div style={{ marginTop: 12, color: "#fff" }}>
              🎉 Sve izabrane usluge su zakazane. Hvala!
            </div>
          )}

          {/* MODAL */}
          <ConfirmModal
            data={confirmData}
            onCancel={() => setConfirmData(null)}
            onConfirm={(slot) => {
              setConfirmData(null);
              book(slot);
            }}
          />
        </div>
      </div>
    );
  }

  // DESKTOP
  return (
    <div style={wrap(isMobile)}>
      <div style={panel(isMobile)}>
      

        <div style={layoutDesktop}>
          {/* leva kolona: usluge */}
          <div style={leftCol}>
            {selectedServices.map((s) => {
              const booked = prefs.get(s.id)?.booked;
              const active = s.id === activeService.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  style={srvItemDesktop(active, booked)}
                  type="button"
                >
                  <div style={{ fontWeight: 900, lineHeight: 1.3 }}>
                    {s.name}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    {Number(s.durationMin || 0)} min{" "}
                    {finalPriceOf(s) != null && <>• {money(finalPriceOf(s))}</>}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      fontWeight: 900,
                      color: booked ? "#1a7f3c" : "#7a1b1b",
                    }}
                  >
                    {booked ? "Zakazano" : "Nije zakazano"}
                  </div>
                </button>
              );
            })}
          </div>

          {/* desna kolona */}
          <div style={rightCol}>
            {/* info + kontrole */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "end",
              }}
            >
              <div>
                <div style={{ fontSize: 12, opacity: 0.85, color: "#fff" }}>
                  Usluga
                </div>
                <div style={{ fontWeight: 900, color: "#fff" }}>
                  {activeService.name}
                </div>
                <div style={{ fontSize: 12, opacity: 0.9, color: "#fff" }}>
                  Trajanje: <b>{Number(activeService.durationMin || 0)} min</b>{" "}
                  {finalPriceOf(activeService) != null && (
                    <>
                      • Cena: <b>{money(finalPriceOf(activeService))}</b>
                    </>
                  )}
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 160px",
                  gap: 8,
                  alignItems: "end",
                }}
              >
                <div>
                  <label style={lbl}>Način izbora</label>
                  <ModeToggle
                    mode={p.mode}
                    onChange={(mode) =>
                      setPrefs(
                        new Map(
                          prefs.set(activeService.id, {
                            ...p,
                            mode,
                            empId: mode === "specific" ? p.empId : "",
                          })
                        )
                      )
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
                      const [y, m] = e.target.value
                        .split("-")
                        .map((n) => parseInt(n, 10));
                      setSelectedDay(new Date(y, m - 1, 1));
                    }}
                    style={inp}
                  />
                </div>
              </div>
            </div>

            {/* traka sa datumima */}
            <DateStrip selectedDay={selectedDay} onSelect={setSelectedDay} />

            {/* radnice – samo kad je "specific" */}
            {p.mode === "specific" && (
              <>
                <div
                  style={{
                    color: "#fff",
                    fontWeight: 900,
                    margin: "4px 2px 6px",
                  }}
                >
                  Hair Stylish
                </div>


{/* DESKTOP grana */}
<StylistsStrip
  employees={eligible}
  selectedId={p.empId}
  onSelect={(empId) =>
    setPrefs(new Map(prefs.set(activeService.id, { ...p, mode: "specific", empId })))
  }
/>

              </>
            )}

            {/* termini */}
            <div style={{ color: "#fff", opacity: 0.9, margin: "8px 2px 6px" }}>
              Available Time
            </div>
            <div style={pillsGrid}>
              {loading ? (
                <div style={{ color: "#fff", opacity: 0.9 }}>Učitavam…</div>
              ) : currentSlots.length ? (
                currentSlots.map((s) => {
                  const e = employees.find((x) => x.id === s.employeeId);
                  return (
                    <button
                      key={`${s.employeeId}_${s.startMin}`}
                      style={{
                        ...pillBtn,
                        opacity: busyAction ? 0.7 : 1,
                        pointerEvents: busyAction ? "none" : "auto",
                      }}
                      onClick={() => askConfirm(s)}
                      type="button"
                      disabled={busyAction}
                      title={e?.name || "Radnica"}
                    >
                      <div style={{ fontWeight: 800 }}>
                        {minToTime(s.startMin)}
                      </div>
                      {p.mode !== "specific" && (
                        <div style={{ fontSize: 11, opacity: 0.85 }}>
                          {e?.name || "Radnica"}
                        </div>
                      )}
                    </button>
                  );
                })
              ) : (
                <div style={{ color: "#fff", opacity: 0.9 }}>
                  Nema slobodnih termina za izabrani dan.
                </div>
              )}
            </div>

            {allBooked && (
              <div style={{ marginTop: 12, color: "#fff" }}>
                🎉 Sve izabrane usluge su zakazane. Hvala!
              </div>
            )}

            {/* MODAL */}
            <ConfirmModal
              data={confirmData}
              onCancel={() => setConfirmData(null)}
              onConfirm={(slot) => {
                setConfirmData(null);
                book(slot);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===================== SUB-KOMPONENTE ===================== */

/* Date strip (horizontalni datumi) */
function DateStrip({ selectedDay, onSelect }) {
  const start = new Date(selectedDay);
  start.setDate(selectedDay.getDate() - 4);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });

  return (
    <div style={stripWrap}>
      <button
        type="button"
        onClick={() =>
          onSelect(
            new Date(
              selectedDay.getFullYear(),
              selectedDay.getMonth(),
              selectedDay.getDate() - 7
            )
          )
        }
        style={stripArrow}
        aria-label="Prethodna nedelja"
      >
        ‹
      </button>

      <div style={stripScroller}>
        {days.map((d, idx) => {
          const isSel = dateKey(d) === dateKey(selectedDay);
          const wd = d
            .toLocaleDateString("sr-RS", { weekday: "short" })
            .replace(".", "");
          return (
            <button key={idx} onClick={() => onSelect(d)} type="button" style={stripDay(isSel)}>
              <div style={{ fontSize: 11, opacity: 0.9 }}>{wd}</div>
              <div style={{ fontWeight: 900, fontSize: 16 }}>{d.getDate()}</div>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() =>
          onSelect(
            new Date(
              selectedDay.getFullYear(),
              selectedDay.getMonth(),
              selectedDay.getDate() + 7
            )
          )
        }
        style={stripArrow}
        aria-label="Sledeća nedelja"
      >
        ›
      </button>
    </div>
  );
}

/* Toggle: Prva slobodna / Određena radnica */
function ModeToggle({ mode, onChange }) {
  return (
    <div style={toggleRow}>
      <button
        type="button"
        onClick={() => onChange("any")}
        style={modeBtn(mode === "any")}
      >
        Prva slobodna radnica
      </button>
      <button
        type="button"
        onClick={() => onChange("specific")}
        style={modeBtn(mode === "specific")}
      >
        Određena radnica
      </button>
    </div>
  );
}

/* Stylists strip (horizontalna traka kao datumi) — SA FOTKAMA */
/* Stylists strip (horizontalna traka kao datumi) — SA FOTKAMA */
function StylistsStrip({ employees, selectedId, onSelect, mobile = false }) {
  if (!employees?.length) {
    return (
      <div style={{ color: "#fff", opacity: 0.85, padding: 8 }}>
        Nema radnica za ovu uslugu/kategoriju.
      </div>
    );
  }

  // === mobilne varijante dimenzija ===
  const AV = mobile ? 88 : 70;                // VEĆI kružići na telefonu
  const GAP = mobile ? 4 : 8;                 // MANJI razmak
  const MINW = mobile ? 110 : 160;            // Uži item da stane više njih
  const PAD = mobile ? 4 : 10;

  const stripWrap = {
    display: "grid",
    gridTemplateColumns: "36px 1fr 36px",
    alignItems: "center",
    gap: GAP,
    margin: "6px 0 10px",
  };
  const stripScroller = {
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: `minmax(${MINW}px, 1fr)`,
    gap: GAP,
    overflowX: "auto",
    padding: "2px 2px",
    scrollbarWidth: "none",
  };
  const item = (active) => ({
    display: "grid",
    gridTemplateRows: "auto auto",
    placeItems: "center",
    gap: mobile ? 4 : 6,
    padding: PAD,
    minWidth: MINW,
    borderRadius: 8,
    border: "none",
    background: "transparent",
    boxShadow: "none",
    color: "#fff",
    cursor: "pointer",
    transform: active ? "translateY(-1px)" : "none",
  });
  const avatar = {
    height: AV,
    width: AV,
    borderRadius: "50%",
    background: "transparent",
    display: "grid",
    placeItems: "center",
    boxShadow: "none",
    overflow: "hidden",
    border: "2px solid transparent",
  };
  const img = {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    borderRadius: "50%",
  };
  const name = {
    fontWeight: 800,
    fontSize: mobile ? 12 : 13,
    color: "#fff",
    background: "transparent",
    padding: 0,
    borderRadius: 0,
    textAlign: "center",
  };
  const arrowBtn = {
    height: 36,
    width: 36,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.35)",
    background: "rgba(255,255,255,.15)",
    color: "#fff",
    fontSize: 18,
    cursor: "pointer",
  };

  // mali avatar sa fallbackom na inicijale
  function Avatar({ emp, active }) {
    const [err, setErr] = useState(false);
    const src = photoSrcFor(emp);
    const initials = String(emp.name || "?")
      .split(" ")
      .map((s) => s[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();

    return (
      <div style={{ ...avatar, borderColor: active ? "#f68fa9" : "transparent" }}>
        {!src || err ? (
          <div style={{ fontWeight: 900, color: "#b15b78", fontSize: 20, letterSpacing: .5 }}>
            {initials}
          </div>
        ) : (
          <img src={src} alt={emp.name} style={img} onError={() => setErr(true)} />
        )}
      </div>
    );
  }

  return (
    <div style={stripWrap}>
      <button
        type="button"
        onClick={(e) => {
          e.currentTarget.nextSibling.scrollBy({ left: -250, behavior: "smooth" });
        }}
        style={arrowBtn}
        aria-label="Levo"
      >
        ‹
      </button>

      <div style={stripScroller}>
        {employees.map((e) => {
          const active = e.id === selectedId;
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => onSelect(e.id)}
              style={item(active)}
              title={e.name}
            >
              <Avatar emp={e} active={active} />
              <div style={name}>{e.name}</div>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.currentTarget.previousSibling.scrollBy({ left: 250, behavior: "smooth" });
        }}
        style={arrowBtn}
        aria-label="Desno"
      >
        ›
      </button>
    </div>
  );
}


/* =============== MODAL ZA POTVRDU =============== */
function ConfirmModal({ data, onCancel, onConfirm }) {
  if (!data) return null;
  const { slot, emp, service, date } = data;

  const dateStr = new Intl.DateTimeFormat("sr-RS", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);

  return (
    <div style={modalOverlay}>
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
  padding: mobile ? 12 : 18,
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-start",
});
const panel = (mobile) => ({
  width: mobile ? "min(860px, 100%)" : "min(1400px, 100%)",
  background: "rgba(255,255,255,.12)",
  border: "1px solid rgba(255,255,255,.35)",
  backdropFilter: "blur(10px)",
  borderRadius: 24,
  boxShadow: "0 24px 60px rgba(0,0,0,.25)",
  padding: mobile ? 14 : "clamp(16px,3vw,24px)",
});
const title = {
  marginTop: 0,
  color: "#000",
  textShadow: "0 2px 14px rgba(0,0,0,.25)",
};

const layoutDesktop = { display: "grid", gridTemplateColumns: "360px 1fr", gap: 12 };
const leftCol = { display: "grid", gap: 8, alignContent: "start" };
const rightCol = {
  background: "rgba(0,0,0,.35)",
  borderRadius: 16,
  padding: 12,
  border: "1px solid rgba(255,255,255,.2)",
};

/* USLUGE – desktop */
const srvItemDesktop = (active, booked) => ({
  textAlign: "left",
  padding: 12,
  borderRadius: 14,
  border: active ? "none" : "1px solid rgba(255,255,255,.35)",
  background: active
    ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)"
    : "rgba(255,255,255,.15)",
  color: "#fff",
  boxShadow: active ? "0 8px 20px rgba(255,127,181,.28)" : "none",
  cursor: "pointer",
  outline: booked ? "2px solid rgba(26,127,60,.6)" : "none",
});

/* USLUGE – mobile kartice */
const mobileServicesCol = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 8,
  marginBottom: 8,
};
const srvItemMobile = (active /* , booked */) => ({
  textAlign: "left",
  padding: 12,
  borderRadius: 14,
  border: active ? "2px solid #ffc0d6" : "1px solid rgba(255,255,255,.35)",
  background: "rgba(255,255,255,.92)",
  color: "#222",
  boxShadow: active ? "0 8px 20px rgba(0,0,0,.12)" : "0 3px 10px rgba(0,0,0,.08)",
  cursor: "pointer",
});

/* kontrole */
const lbl = { color: "#fff", fontWeight: 900, fontSize: 12, opacity: 0.95 };
const inp = {
  height: 40,
  borderRadius: 10,
  border: "1px solid #e8e8e8",
  background: "#fff",
  padding: "0 12px",
  fontSize: 14,
  color: "#222",
  width: "100%",
};
const inpMobile = {
  height: 36,
  borderRadius: 12,
  border: "1px solid #e8e8e8",
  background: "#fff",
  padding: "0 10px",
  fontSize: 14,
  color: "#222",
  width: "140px",           // uži
  maxWidth: "50vw",
  alignSelf: "start",       // da ne širi grid
};


/* --- Date strip --- */
const stripWrap = {
  display: "grid",
  gridTemplateColumns: "36px 1fr 36px",
  alignItems: "center",
  gap: 8,
  margin: "6px 0 8px",
};
const stripArrow = {
  height: 36,
  width: 36,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,.35)",
  background: "rgba(255,255,255,.15)",
  color: "#fff",
  fontSize: 18,
  cursor: "pointer",
};
const stripScroller = {
  display: "grid",
  gridAutoFlow: "column",
  gridAutoColumns: "minmax(56px, 1fr)",
  gap: 8,
  overflowX: "auto",
  padding: "2px 2px",
  scrollbarWidth: "none",
};
const stripDay = (sel) => ({
  display: "grid",
  placeItems: "center",
  gap: 2,
  padding: "8px 6px",
  borderRadius: 12,
  border: sel ? "1px solid #ffcfde" : "1px solid rgba(255,255,255,.35)",
  background: sel ? "linear-gradient(135deg,#ffffff,#ffe3ef)" : "rgba(255,255,255,.12)",
  color: "#000",
  minWidth: 64,
  cursor: "pointer",
  boxShadow: sel ? "0 6px 16px rgba(255,127,181,.25)" : "none",
});

/* --- Mode toggle (2 dugmeta) --- */
const toggleRow = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
};
const modeBtn = (active) => ({
  height: 40,
  borderRadius: 12,
  border: active ? "2px solid #ffb6d0" : "1px solid #e8e8e8",
  background: active ? "linear-gradient(135deg,#ffffff,#ffe3ef)" : "#fff",
  boxShadow: active ? "0 6px 16px rgba(255,127,181,.25)" : "none",
  fontWeight: 800,
  cursor: "pointer",

  /* ↓↓↓ ovo sprečava plavu boju teksta i iOS stilizaciju */
  color: "#000",
  WebkitAppearance: "none",
  appearance: "none",
  outline: "none",
  WebkitTapHighlightColor: "transparent",
});


/* --- Stylists strip --- */
const sectionTitleMobile = { color: "#000", fontWeight: 900, margin: "6px 2px" };
const stylStripWrap = {
  display: "grid",
  gridTemplateColumns: "36px 1fr 36px",
  alignItems: "center",
  gap: 8,
  margin: "6px 0 10px",
};
const stylStripScroller = {
  display: "grid",
  gridAutoFlow: "column",
  gridAutoColumns: "minmax(160px, 1fr)",
  gap: 8,
  overflowX: "auto",
  padding: "2px 2px",
  scrollbarWidth: "none",
};
const stylItem = (active) => ({
  display: "grid",
  gridTemplateRows: "auto auto",
  placeItems: "center",
  gap: 6,
  padding: 6,                 // malo prostora da se lakše klikne
  minWidth: 120,              // uži element – staje više u red
  borderRadius: 8,
  border: "none",             // bez ivice kvadrata
  background: "transparent",  // nema kartice
  boxShadow: "none",
  color: "#fff",
  cursor: "pointer",
  transform: active ? "translateY(-1px)" : "none",
});

const stylAvatar = {
  height: 70,
  width: 70,
  borderRadius: "50%",
  background: "transparent",     // bez gradijenta
  display: "grid",
  placeItems: "center",
  boxShadow: "none",
  overflow: "hidden",
};
const stylImg = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  borderRadius: "50%",
};
const empInitials = { fontWeight: 900, color: "#b15b78", fontSize: 20, letterSpacing: 0.5 };
const stylName = {
  fontWeight: 800,
  fontSize: 13,
  color: "#fff",            // bela slova jer je pozadina tamna u desnoj koloni
  background: "transparent",
  padding: 0,
  borderRadius: 0,
};


/* --- Pil dugmići vremena --- */
const pillsGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))",
  gap: 8,
};
const pillBtn = {
  display: "grid",
  justifyItems: "center",
  gap: 2,
  padding: "10px 12px",
  borderRadius: 999,
  border: "1px solid #efcddc",
  background: "#fff",
  color: "#000",
  cursor: "pointer",
  boxShadow: "0 6px 16px rgba(0,0,0,.08)",
};
const pillsGridMobile = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: 8,
};
const pillBtnMobile = {
  padding: "12px 10px",
  borderRadius: 999,
  border: "1px solid #efcddc",
  background: "#fff",
  color: "#000",
  cursor: "pointer",
  textAlign: "center",
  boxShadow: "0 4px 12px rgba(0,0,0,.08)",
};

/* --- Modal styles --- */
const modalOverlay = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 999,
};
const modalBox = {
  background: "#fff",
  borderRadius: 16,
  padding: 20,
  maxWidth: 360,
  width: "calc(100% - 32px)",
  boxShadow: "0 8px 30px rgba(0,0,0,0.3)",
  color: "#000",
};
const modalRow = { marginBottom: 6 };
const btnCancel = {
  flex: 1,
  padding: "10px 12px",
  background: "#eee",
  border: "none",
  borderRadius: 10,
  cursor: "pointer",
};
const btnConfirm = {
  flex: 1,
  padding: "10px 12px",
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  color: "#fff",
  border: "none",
  borderRadius: 10,
  fontWeight: "bold",
  cursor: "pointer",
};
